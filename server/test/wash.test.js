// Тесты модуля жизненного цикла стирки (R3): бьём напрямую в require('../wash'),
// минуя фасад api.js. Эффекты команд (WashItems/Storage/Shifts/Log) и атомарность
// транзакций — контракт модуля.
// Порядок важен: helpers/serverMocks выставляет env ДО загрузки серверных модулей.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, TODAY, TOMORROW } = require('./helpers/serverMocks');
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
