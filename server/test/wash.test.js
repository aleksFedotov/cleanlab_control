// Тесты модуля жизненного цикла стирки (R3): бьём напрямую в require('../wash'),
// минуя фасад api.js. Эффекты команд (WashItems/Storage/Shifts/Log) и атомарность
// транзакций — контракт модуля.
// Порядок важен: helpers/serverMocks выставляет env ДО загрузки серверных модулей.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, loginDriver, TODAY, TOMORROW } = require('./helpers/serverMocks');
const { SHEETS } = require('../schema');
const wash = require('../wash');

// Сессии — как возвращает auth.getSession_ (без токена: wash-команды сессию только читают)
const ownerSession = { userId: 'usr_owner', name: 'Владелец', role: 'owner', laundryId: '1', clientId: '' };
const workerSession = { userId: 'usr_w1', name: 'Работник', role: 'worker', laundryId: '1', clientId: '' };

function seedClient(ctx) {
  const res = ctx.api.saveClient(loginOwner(), { name: 'Отель А', type: 'отель' });
  assert.ok(res.ok);
  return res.client.id;
}

// Завершённая стирка «сегодня» с чистой записью на складе (как в visit-correct.test.js)
function washToStorage(ctx, owner, worker, clientId) {
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TODAY).wash.id;
  assert.ok(ctx.api.startWash(worker, washId).ok);
  const done = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 2 }], 5, null, 2);
  assert.ok(done.ok, done.error);
  return washId;
}

function cleanStorage(ctx, clientId) {
  return ctx.db.readAll_(SHEETS.STORAGE).filter(function (s) {
    return s.client_id === clientId && s.kind === 'clean';
  });
}

function visitRow(ctx, visitId) {
  return ctx.db.findById_(SHEETS.DELIVERIES, visitId).obj;
}

// Плановая стирка «сегодня → выдача завтра» через фасад (setup), тестируем wash.*
function plannedWash(ctx, clientId) {
  const res = ctx.api.addToDelivery(loginOwner(), clientId, TODAY, TOMORROW);
  assert.ok(res.ok);
  return res.wash.id;
}

test('completeWash: эффекты атомарны — WashItems, стирка, clean-запись, смена, Log', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);
  assert.ok(wash.startWash(workerSession, washId, 10).ok);

  const res = wash.completeWash(workerSession, washId, [
    { item_type_id: 'itm_1', qty: 4 }, { item_type_id: 'itm_2', qty: 3 }
  ], 9.5, null, 2);
  assert.ok(res.ok);
  assert.strictEqual(res.wash.status, 'done');
  assert.strictEqual(res.wash.items_total, 7);
  assert.strictEqual(res.wash.dirty_weight_kg, 9.5);

  // Позиции стирки
  const items = ctx.db.readAll_(SHEETS.WASH_ITEMS);
  assert.strictEqual(items.length, 2);
  assert.ok(items.every(function (wi) { return wi.wash_id === washId; }));
  // Чистое бельё — на складе
  const clean = ctx.db.readAll_(SHEETS.STORAGE).filter(function (s) { return s.kind === 'clean'; });
  assert.strictEqual(clean.length, 1);
  assert.strictEqual(clean[0].wash_id, washId);
  assert.strictEqual(clean[0].weight_kg, '9.5');
  // Смена дня создана
  assert.strictEqual(ctx.db.readAll_(SHEETS.SHIFTS).length, 1);
  // Событие в журнале
  const log = ctx.db.readTailByTenant_(SHEETS.LOG, 1000, '1').filter(function (e) {
    return e.action === 'wash_done' && e.entity === washId;
  });
  assert.strictEqual(log.length, 1);
});

test('cancelWash: израсходованное грязное бельё возвращается на склад', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);
  // Грязное бельё на складе, как после приёмки у водителя
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_1', client_id: clientId, kind: 'dirty', weight_kg: '8',
    items_total: '', wash_id: '', created_at: TODAY, consumed_at: ''
  }, '1');

  assert.ok(wash.startWash(workerSession, washId, 8).ok);
  // startWash израсходовал запись: бельё ушло в стирку
  let st = ctx.db.readAll_(SHEETS.STORAGE)[0];
  assert.notStrictEqual(st.consumed_at, '');
  assert.strictEqual(st.wash_id, washId);

  assert.ok(wash.cancelWash(ownerSession, washId).ok);
  // Отмена вернула партию: запись снова открыта и не привязана к стирке
  st = ctx.db.readAll_(SHEETS.STORAGE)[0];
  assert.strictEqual(st.consumed_at, '');
  assert.strictEqual(st.wash_id, '');
  assert.strictEqual(ctx.db.findById_(SHEETS.WASHES, washId).obj.status, 'cancelled');
});

test('partial: holdPartialWash фиксирует решение, deferWash возвращает остаток в план', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);
  assert.ok(wash.startWash(workerSession, washId, 10).ok);
  const partial = wash.completeWash(workerSession, washId, [{ item_type_id: 'itm_1', qty: 5 }], 6, 'partial', 1);
  assert.ok(partial.ok);
  assert.strictEqual(partial.wash.status, 'partial');

  // hold: маркер решения «оставить на складе», статус и дата выдачи не меняются
  const held = wash.holdPartialWash(ownerSession, washId);
  assert.ok(held.ok);
  assert.strictEqual(held.wash.status, 'partial');
  assert.strictEqual(held.wash.deferred_reason, 'hold');
  assert.strictEqual(held.wash.issue_date, TOMORROW);

  // defer: стирка снова в плане (новый день, выдача +1), грязный остаток восстановлен
  const deferred = wash.deferWash(ownerSession, washId, TOMORROW, 'бельё не высохло');
  assert.ok(deferred.ok);
  assert.strictEqual(deferred.wash.status, 'planned');
  assert.strictEqual(deferred.wash.wash_date, TOMORROW);
  assert.strictEqual(deferred.wash.issue_date, '2026-08-14');
  assert.strictEqual(deferred.wash.deferred_from, TODAY);
  const dirty = ctx.db.readAll_(SHEETS.STORAGE).filter(function (s) {
    return s.kind === 'dirty' && !s.consumed_at;
  });
  assert.strictEqual(dirty.length, 1);
  // Постиранная чистая часть на складе сохранилась
  const clean = ctx.db.readAll_(SHEETS.STORAGE).filter(function (s) { return s.kind === 'clean'; });
  assert.strictEqual(clean.length, 1);
});

test('транзакционность: сбой записи откатывает completeWash целиком, без частичных изменений', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);
  assert.ok(wash.startWash(workerSession, washId, 10).ok);

  // Симулируем сбой записи: подменяем db.updateRow_ (вызывается через объект-модуль;
  // storage-хелперы деструктурированы при require — их подменить так не выйдет).
  // Сбой посередине команды: WashItems уже дописаны, update стирки падает.
  const origUpdate = ctx.db.updateRow_;
  ctx.db.updateRow_ = function (sheet, rowNumber, obj, d) {
    if (sheet === SHEETS.WASHES) throw new Error('washes write failed');
    return origUpdate.call(this, sheet, rowNumber, obj, d);
  };
  try {
    assert.throws(function () {
      wash.completeWash(workerSession, washId, [{ item_type_id: 'itm_1', qty: 5 }], 9, null, 1);
    }, /washes write failed/);
  } finally {
    ctx.db.updateRow_ = origUpdate;
  }

  // Частичных эффектов нет: ни WashItems, ни clean-записи; стирка осталась в работе
  assert.strictEqual(ctx.db.readAll_(SHEETS.WASH_ITEMS).length, 0);
  assert.strictEqual(ctx.db.readAll_(SHEETS.STORAGE).filter(function (s) {
    return s.kind === 'clean';
  }).length, 0);
  const w = ctx.db.findById_(SHEETS.WASHES, washId);
  assert.strictEqual(w.obj.status, 'in_progress');
  assert.strictEqual(w.obj.done_at, '');
});


// --- R4: единый переход «выдача чистого» (visit_id вместо меток, транзакции) ---

test('deliver_clean: склад + стирки + визит в одной транзакции, одна метка; повторная выдача отклонена', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  const washId = washToStorage(ctx, owner, worker, clientId);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  // Взятие штампует чистые записи визитом
  const taken = cleanStorage(ctx, clientId)[0];
  assert.strictEqual(taken.consumed_at, 'driver');
  assert.strictEqual(taken.visit_id, v.id);

  const r = ctx.api.driverAction(driver, v.id, 'deliver_clean');
  assert.ok(r.ok, r.error);
  // Стирка выдана, склад израсходован, визит закрыт — и всё с одной меткой
  const w = ctx.db.findById_(SHEETS.WASHES, washId).obj;
  assert.strictEqual(w.status, 'issued');
  const vNow = visitRow(ctx, v.id);
  assert.strictEqual(vNow.status, 'delivered');
  assert.ok(vNow.delivered_at);
  assert.strictEqual(w.issued_at, vNow.delivered_at, 'одна метка на склад, стирку и визит');
  const issued = cleanStorage(ctx, clientId)[0];
  assert.notStrictEqual(issued.consumed_at, 'driver');
  assert.strictEqual(issued.consumed_at, w.issued_at);

  // Повторная выдача невозможна: визит уже закрыт
  const again = ctx.api.driverAction(driver, v.id, 'deliver_clean');
  assert.strictEqual(again.ok, false);
});

test('deliver_clean: сбой записи визита откатывает склад и стирки целиком', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  const washId = washToStorage(ctx, owner, worker, clientId);
  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);

  // Сбой посередине операции: склад и стирки уже записаны, запись визита падает.
  // Подмена работает, т.к. wash-команды и deliveries зовут db.updateRow_ через объект-модуль.
  const origUpdate = ctx.db.updateRow_;
  ctx.db.updateRow_ = function (sheet, rowNumber, obj, d) {
    if (sheet === SHEETS.DELIVERIES) throw new Error('deliveries write failed');
    return origUpdate.call(this, sheet, rowNumber, obj, d);
  };
  try {
    assert.throws(function () {
      ctx.api.driverAction(driver, v.id, 'deliver_clean');
    }, /deliveries write failed/);
  } finally {
    ctx.db.updateRow_ = origUpdate;
  }

  // Частичных эффектов нет: чистое снова «у водителя», стирка не выдана, визит открыт
  const st = cleanStorage(ctx, clientId)[0];
  assert.strictEqual(st.consumed_at, 'driver');
  assert.strictEqual(ctx.db.findById_(SHEETS.WASHES, washId).obj.status, 'done');
  const vNow = visitRow(ctx, v.id);
  assert.strictEqual(vNow.status, 'planned');
  assert.strictEqual(vNow.delivered_at, '');
});

test('undo_deliver: стирки → stored, чистое → driver, визит снова открыт', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  const washId = washToStorage(ctx, owner, worker, clientId);
  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, v.id, 'deliver_clean').ok);

  const r = ctx.api.correctVisit(driver, v.id, 'undo_deliver');
  assert.ok(r.ok, r.error);
  const w = ctx.db.findById_(SHEETS.WASHES, washId).obj;
  assert.strictEqual(w.status, 'stored');
  assert.strictEqual(w.issued_at, '');
  const st = cleanStorage(ctx, clientId)[0];
  assert.strictEqual(st.consumed_at, 'driver', 'чистое снова у водителя');
  const vNow = visitRow(ctx, v.id);
  assert.strictEqual(vNow.status, 'planned');
  assert.strictEqual(vNow.delivered_at, '');
});

test('undo_pickup: два визита одного клиента в один день — удаляется запись своего визита', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx);
  const v1 = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  // Второй визит в тот же день — напрямую в БД (API дедупит визиты клиента на дату)
  ctx.db.appendRowTenant_(SHEETS.DELIVERIES, {
    id: 'del_dup', date: TODAY, client_id: clientId, ord: '2', status: 'planned',
    delivered_at: '', pickup: '', driver_comment: '', created_by: 'owner',
    created_at: '2026-08-12 08:00:00', clean_taken_at: '', clean_bags: '',
    picked_at: '', dirty_handed_at: '', pickup_only: '', lift_floor: ''
  }, '1');
  const v2 = visitRow(ctx, 'del_dup');

  assert.ok(ctx.api.driverAction(driver, v1.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverAction(driver, v2.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverHandover(driver).ok);
  const dirty = ctx.db.readAll_(SHEETS.STORAGE).filter(function (s) {
    return s.client_id === clientId && s.kind === 'dirty';
  });
  assert.strictEqual(dirty.length, 2);
  assert.ok(dirty.every(function (s) { return s.visit_id !== ''; }), 'каждая запись сдана по своему визиту');

  const r = ctx.api.correctVisit(driver, v1.id, 'undo_pickup');
  assert.ok(r.ok, r.error);
  const rest = ctx.db.readAll_(SHEETS.STORAGE).filter(function (s) {
    return s.client_id === clientId && s.kind === 'dirty';
  });
  assert.strictEqual(rest.length, 1);
  assert.strictEqual(rest[0].visit_id, v2.id, 'осталась запись второго визита');
});

test('driverReturnClean точечен: при двух визитах с чистым у водителя возвращается только своё', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx);
  const v1 = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  const wash1 = washToStorage(ctx, owner, worker, clientId);
  assert.ok(ctx.api.driverAction(driver, v1.id, 'take_clean').ok);

  // Второе чистое уходит со вторым визитом
  const wash2 = washToStorage(ctx, owner, worker, clientId);
  const v2 = ctx.api.addDeliveryVisit(owner, clientId, TOMORROW).visit;
  assert.ok(ctx.api.driverAction(driver, v2.id, 'take_clean').ok);
  const atDriver = cleanStorage(ctx, clientId).filter(function (s) { return s.consumed_at === 'driver'; });
  assert.strictEqual(atDriver.length, 2);

  const r = ctx.api.driverReturnClean(driver, v1.id);
  assert.ok(r.ok, r.error);
  const now = cleanStorage(ctx, clientId);
  const back = now.filter(function (s) { return s.consumed_at === ''; });
  const stillDriver = now.filter(function (s) { return s.consumed_at === 'driver'; });
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].wash_id, wash1, 'вернулось бельё первого визита');
  assert.strictEqual(stillDriver.length, 1);
  assert.strictEqual(stillDriver[0].wash_id, wash2, 'чистое второго визита не тронуто');
  assert.strictEqual(visitRow(ctx, v1.id).clean_taken_at, '');
  assert.ok(visitRow(ctx, v2.id).clean_taken_at, 'визит 2 не очищен');
});

test('migrateToV9_: backfill visit_id по меткам, несматчившееся — "", повторный запуск no-op', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);

  // openTest уже прогнал миграцию на пустой БД — сбрасываем маркер и сидим «историю»
  const marker = ctx.db.findRowsBy_(SHEETS.SETTINGS, function (s) {
    return s.key === 'STORAGE_VISIT_ID_BACKFILL';
  }, 10)[0];
  ctx.db.deleteRow_(SHEETS.SETTINGS, marker.rowNumber);

  // История: выдача чистого (issued_at === delivered_at) и сдача грязного
  // (created_at === dirty_handed_at), без visit_id, как до R4
  ctx.db.appendRowTenant_(SHEETS.DELIVERIES, {
    id: 'del_hist1', date: '2026-08-10', client_id: clientId, ord: '1', status: 'both',
    delivered_at: '2026-08-10 12:00:00', pickup: 'да', driver_comment: '', created_by: 'owner',
    created_at: '2026-08-10 10:00:00', clean_taken_at: '', clean_bags: '',
    picked_at: '2026-08-10 11:00:00', dirty_handed_at: '', pickup_only: '', lift_floor: ''
  }, '1');
  ctx.db.appendRowTenant_(SHEETS.DELIVERIES, {
    id: 'del_hist2', date: '2026-08-11', client_id: clientId, ord: '1', status: 'picked',
    delivered_at: '', pickup: 'да', driver_comment: '', created_by: 'owner',
    created_at: '2026-08-11 08:00:00', clean_taken_at: '', clean_bags: '',
    picked_at: '2026-08-11 09:00:00', dirty_handed_at: '2026-08-11 09:00:00', pickup_only: '', lift_floor: ''
  }, '1');
  ctx.db.appendRowTenant_(SHEETS.WASHES, {
    id: 'wash_hist1', client_id: clientId, wash_date: '2026-08-09', issue_date: '2026-08-10',
    status: 'issued', dirty_weight_kg: '5', items_total: '2', comment: '', created_by: 'owner',
    created_at: '2026-08-09 10:00:00', started_at: '', done_at: '',
    issued_at: '2026-08-10 12:00:00', deferred_from: '', deferred_reason: '', bags: '1'
  }, '1');
  ctx.db.appendRowTenant_(SHEETS.WASHES, {
    id: 'wash_hist2', client_id: clientId, wash_date: '2026-08-11', issue_date: '2026-08-12',
    status: 'stored', dirty_weight_kg: '4', items_total: '1', comment: '', created_by: 'owner',
    created_at: '2026-08-11 10:00:00', started_at: '', done_at: '2026-08-11 18:00:00',
    issued_at: '', deferred_from: '', deferred_reason: '', bags: '1'
  }, '1');
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_hist1', client_id: clientId, kind: 'clean', weight_kg: '5', items_total: '2',
    wash_id: 'wash_hist1', visit_id: '', created_at: '2026-08-09 18:00:00', consumed_at: '2026-08-10 12:00:00'
  }, '1');
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_hist2', client_id: clientId, kind: 'dirty', weight_kg: '', items_total: '',
    wash_id: '', visit_id: '', created_at: '2026-08-11 09:00:00', consumed_at: ''
  }, '1');
  // Несматчившееся: неподанная clean-запись неподанной стирки — visit_id не появляется
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_hist3', client_id: clientId, kind: 'clean', weight_kg: '4', items_total: '1',
    wash_id: 'wash_hist2', visit_id: '', created_at: '2026-08-11 18:00:00', consumed_at: ''
  }, '1');

  ctx.db.migrateToV9_();
  const byId = {};
  ctx.db.readAll_(SHEETS.STORAGE).forEach(function (s) { byId[s.id] = s; });
  assert.strictEqual(byId.st_hist1.visit_id, 'del_hist1', 'clean выданной стирки → визит выдачи');
  assert.strictEqual(byId.st_hist2.visit_id, 'del_hist2', 'dirty → визит сдачи');
  assert.strictEqual(byId.st_hist3.visit_id, '', 'неподанная стирка не сматчилась');
  // Маркер выставлен
  const after = ctx.db.readAll_(SHEETS.SETTINGS).filter(function (s) {
    return s.key === 'STORAGE_VISIT_ID_BACKFILL';
  });
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].value, 'done');

  // Повторный запуск — no-op по маркеру: ручная правка не затирается
  const row = ctx.db.findRowsBy_(SHEETS.STORAGE, function (s) { return s.id === 'st_hist1'; }, 10)[0];
  row.obj.visit_id = 'hack';
  ctx.db.updateRow_(SHEETS.STORAGE, row.rowNumber, row.obj);
  ctx.db.migrateToV9_();
  assert.strictEqual(ctx.db.findById_(SHEETS.STORAGE, 'st_hist1').obj.visit_id, 'hack');
});


// --- P8: проверка склада, ручное внесение чистого ---

const { storageSummaryByClient_ } = require('../storage');

test('P8: already_clean без открытого clean у клиента → ошибка, статус и Log не тронуты', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);

  const res = wash.confirmStorageCheck(workerSession, washId, 'already_clean');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Чистого белья этого клиента на складе нет. ' +
    'Если бельё физически на полке — внесите его вручную.');
  const w = ctx.db.findById_(SHEETS.WASHES, washId).obj;
  assert.strictEqual(w.status, 'planned');
  assert.strictEqual(w.done_at, '');
  assert.strictEqual(ctx.db.readTailByTenant_(SHEETS.LOG, 1000, '1').filter(function (e) {
    return e.action === 'storage_check';
  }).length, 0);
});

test('P8: already_clean, чистое уже у водителя (consumed_at=driver) → ошибка', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_dr1', client_id: clientId, kind: 'clean', weight_kg: '5',
    items_total: '10', bags: '2', wash_id: '', visit_id: '',
    created_at: TODAY, consumed_at: 'driver'
  }, '1');

  const res = wash.confirmStorageCheck(workerSession, washId, 'already_clean');
  assert.strictEqual(res.ok, false, 'чистое у водителя на складе не считается');
  assert.strictEqual(ctx.db.findById_(SHEETS.WASHES, washId).obj.status, 'planned');
});

test('P8: already_clean при открытом clean → ready_clean (регрессия)', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_cl1', client_id: clientId, kind: 'clean', weight_kg: '5',
    items_total: '10', bags: '2', wash_id: '', visit_id: '',
    created_at: TODAY, consumed_at: ''
  }, '1');

  const res = wash.confirmStorageCheck(workerSession, washId, 'already_clean');
  assert.ok(res.ok);
  assert.strictEqual(res.wash.status, 'ready_clean');
  assert.ok(res.wash.done_at);
});

test('P8: addManualClean — валидации: мешки, вес, комментарий; count-клиент', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const countId = ctx.api.saveClient(loginOwner(), { name: 'Поштучный', type: 'отель', accounting: 'count' }).client.id;

  assert.strictEqual(wash.addManualClean(workerSession, clientId, 5, 10, 0, 'остаток').ok, false, 'без мешков');
  assert.strictEqual(wash.addManualClean(workerSession, clientId, 5, 10, 1.5, 'остаток').ok, false, 'мешки не целые');
  assert.strictEqual(wash.addManualClean(workerSession, clientId, 0, 10, 2, 'остаток').ok, false, 'без веса');
  assert.strictEqual(wash.addManualClean(workerSession, clientId, 5, 10, 2, '   ').ok, false, 'пустой комментарий');
  assert.strictEqual(wash.addManualClean(workerSession, countId, 5, 0, 2, 'остаток').ok, false, 'count без штук');
  const countOk = wash.addManualClean(workerSession, countId, 0, 12, 2, 'остаток');
  assert.ok(countOk.ok, 'count-клиенту вес не нужен: ' + (countOk.error || ''));
  // Несуществующий/неактивный клиент
  assert.strictEqual(wash.addManualClean(workerSession, 'cl_none', 5, 10, 2, 'остаток').ok, false);
});

test('P8: addManualClean — успех: clean-запись с bags и пустым wash_id, Log, Telegram работника', () => {
  const ctx = makeCtx();
  ctx.db.appendRow_('Settings', { key: 'OWNER_CHAT_ID', value: '998877' });
  ctx.db.invalidateRefCache_();
  const clientId = seedClient(ctx);

  const res = wash.addManualClean(workerSession, clientId, 7.5, 20, 3, 'со старой накладной');
  assert.ok(res.ok, res.error);
  const entry = res.entry;
  assert.strictEqual(entry.kind, 'clean');
  assert.strictEqual(entry.bags, 3);
  assert.strictEqual(entry.wash_id, '', 'стирки за записью нет');
  assert.strictEqual(entry.weight_kg, 7.5);
  const st = ctx.db.findById_(SHEETS.STORAGE, entry.id).obj;
  assert.strictEqual(st.bags, '3');

  const ev = ctx.db.readTailByTenant_(SHEETS.LOG, 1000, '1').filter(function (e) {
    return e.action === 'storage_manual_clean';
  });
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].entity, entry.id);
  const det = JSON.parse(ev[0].details);
  assert.strictEqual(det.client_id, clientId);
  assert.strictEqual(det.kg, 7.5);
  assert.strictEqual(det.bags, 3);
  assert.strictEqual(det.comment, 'со старой накладной');

  const msg = ctx.fetches.find(function (f) {
    return f.payload.text && f.payload.text.indexOf('чистое внесено вручную') !== -1;
  });
  assert.ok(msg, 'владельцу ушло Telegram об действии работника');
  assert.ok(msg.payload.text.indexOf('Отель А') !== -1);

  // Действие владельца — без уведомления
  const before = ctx.fetches.length;
  assert.ok(wash.addManualClean(ownerSession, clientId, 1, 1, 1, 'от владельца').ok);
  assert.strictEqual(ctx.fetches.length, before, 'действия владельца не шлём');
});

test('P8: storageSummaryByClient_ — мешки ручной записи из bags, записи со стиркой — со стирки', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  // Запись из стирки: мешки хранятся на стирке
  ctx.db.appendRowTenant_(SHEETS.WASHES, {
    id: 'wash_s1', client_id: clientId, wash_date: TODAY, issue_date: TOMORROW,
    status: 'done', dirty_weight_kg: '5', items_total: '2', comment: '', created_by: 'owner',
    created_at: TODAY + ' 10:00:00', started_at: '', done_at: TODAY + ' 18:00:00',
    issued_at: '', deferred_from: '', deferred_reason: '', bags: '2'
  }, '1');
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_s1', client_id: clientId, kind: 'clean', weight_kg: '5', items_total: '2',
    bags: '', wash_id: 'wash_s1', visit_id: '', created_at: TODAY, consumed_at: ''
  }, '1');
  // Ручная запись: мешки свои
  assert.ok(wash.addManualClean(ownerSession, clientId, 3, 5, 4, 'ручное').ok);

  const s = storageSummaryByClient_('1')[clientId];
  assert.strictEqual(s.clean, 2);
  assert.strictEqual(s.cleanBags, 6, '2 со стирки + 4 ручных');
  assert.strictEqual(s.cleanKg, 8);
  assert.strictEqual(s.cleanItems, 7);
});

test('P8: ручное чистое не влияет на getDayReport/getSummaryReport', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  plannedWash(ctx, clientId);

  const dayBefore = ctx.api.getDayReport(owner, TODAY);
  const sumBefore = ctx.api.getSummaryReport(owner, TODAY, TODAY);
  assert.ok(wash.addManualClean(ownerSession, clientId, 10, 30, 5, 'досистемный запас').ok);
  const dayAfter = ctx.api.getDayReport(owner, TODAY);
  const sumAfter = ctx.api.getSummaryReport(owner, TODAY, TODAY);

  assert.strictEqual(dayAfter.report.totalKg, dayBefore.report.totalKg, 'кг дня не изменились');
  assert.strictEqual(dayAfter.report.washesDone, dayBefore.report.washesDone, 'стирок дня не прибавилось');
  assert.deepStrictEqual(sumAfter.clients, sumBefore.clients, 'сводный отчёт не изменился');
});

test('P8: getDayList — карточка несёт storage с цифрами клиента; без записей — нули', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  const washId = plannedWash(ctx, clientId);
  // Грязная партия + ручное чистое
  ctx.db.appendRowTenant_(SHEETS.STORAGE, {
    id: 'st_d1', client_id: clientId, kind: 'dirty', weight_kg: '', items_total: '',
    bags: '', wash_id: '', visit_id: '', created_at: TODAY, consumed_at: ''
  }, '1');
  assert.ok(wash.addManualClean(ownerSession, clientId, 6, 15, 2, 'ручное').ok);
  // Клиент без записей на складе
  const emptyId = ctx.api.saveClient(owner, { name: 'Пустой', type: 'отель' }).client.id;
  const emptyWashId = plannedWash(ctx, emptyId);

  const list = ctx.api.getDayList(owner, TODAY);
  assert.ok(list.ok);
  const card = list.washes.find(function (w) { return w.id === washId; });
  assert.deepStrictEqual(card.storage,
    { dirty: 1, clean: 1, clean_kg: 6, clean_items: 15, clean_bags: 2, clean_detail: [] });
  const empty = list.washes.find(function (w) { return w.id === emptyWashId; });
  assert.deepStrictEqual(empty.storage,
    { dirty: 0, clean: 0, clean_kg: 0, clean_items: 0, clean_bags: 0, clean_detail: [] });
});

test('clean_detail: разбивка чистого по типам из WashItems, включая ручные записи с items', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  // Завершённая стирка → clean-запись со стиркой (2 типа)
  const doneId = plannedWash(ctx, clientId);
  assert.ok(wash.startWash(workerSession, doneId, 9.5).ok);
  assert.ok(wash.completeWash(workerSession, doneId, [
    { item_type_id: 'itm_1', qty: 4 }, { item_type_id: 'itm_2', qty: 3 }
  ], 9.5, null, 2).ok);
  // Ручное чистое без разбивки — в clean_detail не попадает
  assert.ok(wash.addManualClean(ownerSession, clientId, 2, 5, 1, 'ручное').ok);
  // Ручное чистое с разбивкой — попадает (v11: WashItems по storage_id)
  assert.ok(wash.addManualClean(ownerSession, clientId, 3, 0, 1, 'ручное с разбивкой', [
    { item_type_id: 'itm_2', qty: 2 }, { item_type_id: 'itm_3', qty: 1 }
  ]).ok);
  const washId = plannedWash(ctx, clientId);

  const card = ctx.api.getDayList(owner, TODAY).washes.find(function (w) { return w.id === washId; });
  assert.deepStrictEqual(card.storage.clean_detail, [
    { name: 'простыня', qty: 5 },
    { name: 'пододеяльник', qty: 4 },
    { name: 'наволочка', qty: 1 }
  ], 'разбивка стирки + ручной записи, сортировка по убыванию qty');
  assert.strictEqual(card.storage.clean_items, 15, 'итог штук — со всеми записями');
});

test('P8: addManualClean с items — WashItems со storage_id, items_total = сумма qty', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);

  const res = wash.addManualClean(ownerSession, clientId, 5, 999, 2, 'остаток', [
    { item_type_id: 'itm_1', qty: 4 }, { item_type_id: 'itm_2', qty: 3 },
    { item_type_id: 'itm_1', qty: 1 } // дубликат типа — суммируется
  ]);
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.entry.items_total, 8, 'переданный itemsTotal игнорируется, берётся сумма разбивки');

  const wis = ctx.db.readAll_(SHEETS.WASH_ITEMS).filter(function (wi) {
    return wi.storage_id === res.entry.id;
  });
  assert.strictEqual(wis.length, 2, 'дубликат слит в одну строку');
  assert.deepStrictEqual(
    wis.map(function (wi) { return [wi.item_type_id, Number(wi.qty)]; }),
    [['itm_1', 5], ['itm_2', 3]]
  );
  wis.forEach(function (wi) {
    assert.strictEqual(wi.wash_id, '', 'стирки за позицией нет');
  });

  const ev = ctx.db.readTailByTenant_(SHEETS.LOG, 1000, '1').filter(function (e) {
    return e.action === 'storage_manual_clean';
  });
  const det = JSON.parse(ev[0].details);
  assert.strictEqual(det.items, 8);
  assert.strictEqual(det.breakdown.length, 2, 'в журнале разбивка по видам');
});

test('P8: addManualClean с items — валидации разбивки; count-клиент без веса', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const countId = ctx.api.saveClient(loginOwner(), { name: 'Поштучный', type: 'отель', accounting: 'count' }).client.id;

  assert.strictEqual(wash.addManualClean(ownerSession, clientId, 5, 0, 2, 'x', [
    { item_type_id: 'itm_none', qty: 1 }
  ]).ok, false, 'неизвестный вид белья');
  assert.strictEqual(wash.addManualClean(ownerSession, clientId, 5, 0, 2, 'x', [
    { item_type_id: 'itm_1', qty: 0 }
  ]).ok, false, 'qty = 0');
  assert.strictEqual(wash.addManualClean(ownerSession, clientId, 5, 0, 2, 'x', [
    { item_type_id: 'itm_1', qty: 1.5 }
  ]).ok, false, 'qty не целое');
  // Ошибки разбивки откатывают транзакцию: clean-записей не появилось
  assert.strictEqual(ctx.db.readAll_(SHEETS.STORAGE).length, 0);
  assert.strictEqual(ctx.db.readAll_(SHEETS.WASH_ITEMS).length, 0);

  // count-клиент: вес не нужен, штуки берутся из разбивки
  const res = wash.addManualClean(workerSession, countId, 0, 0, 1, 'остаток', [
    { item_type_id: 'itm_1', qty: 6 }
  ]);
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.entry.items_total, 6);
  assert.strictEqual(res.entry.weight_kg, '');
});

test('P8: WashItems ручной записи не влияют на getDayReport/getSummaryReport', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  plannedWash(ctx, clientId);

  const dayBefore = ctx.api.getDayReport(owner, TODAY);
  const sumBefore = ctx.api.getSummaryReport(owner, TODAY, TODAY);
  assert.ok(wash.addManualClean(ownerSession, clientId, 10, 0, 5, 'досистемный запас', [
    { item_type_id: 'itm_1', qty: 30 }
  ]).ok);
  const dayAfter = ctx.api.getDayReport(owner, TODAY);
  const sumAfter = ctx.api.getSummaryReport(owner, TODAY, TODAY);

  assert.strictEqual(dayAfter.report.totalKg, dayBefore.report.totalKg, 'кг дня не изменились');
  assert.strictEqual(dayAfter.report.washesDone, dayBefore.report.washesDone, 'стирок дня не прибавилось');
  assert.deepStrictEqual(sumAfter.clients, sumBefore.clients,
    'сводный отчёт не изменился: позиции с wash_id=\'\' в разбивку по видам не попадают');
});
