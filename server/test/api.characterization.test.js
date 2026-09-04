// Характеризационные тесты server/api.js (тикет R1, шаг 0).
// Фиксируют ТЕКУЩЕЕ поведение публичных методов api перед делёжкой на модули.
// Эталон: в дальнейших шагах R1 этот файл НЕ правится — должны быть зелёными как есть.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, TODAY, TOMORROW } = require('./helpers/serverMocks');

function seedClient(ctx, over = {}) {
  const res = ctx.api.saveClient(loginOwner(), Object.assign({ name: 'Отель А', type: 'отель' }, over));
  assert.ok(res.ok);
  return res.client.id;
}

// --- completeWash: частичная достирка ---

test('R1-char: частичная достирка — итоги суммируются, вторая clean-запись склада', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  ctx.api.startWash(worker, washId, 6.5);
  const part = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }], 6.5, 'partial', 1);
  assert.ok(part.ok);
  assert.strictEqual(part.wash.status, 'partial');

  // Переносим остаток и достирываем
  assert.ok(ctx.api.deferWash(owner, washId, '2026-08-14', 'не достирали').ok);
  assert.ok(ctx.api.startWash(worker, washId).ok);
  const done = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_2', qty: 3 }], 2.04, null, 2);
  assert.ok(done.ok);
  assert.strictEqual(done.wash.status, 'done');
  // Итоги суммируются с первой частью
  assert.strictEqual(Number(done.wash.items_total), 7);
  assert.strictEqual(Number(done.wash.bags), 3);
  assert.strictEqual(Number(done.wash.dirty_weight_kg), 8.5); // 6.5 + 2.04 → round1
  // WashItems обеих частей сохранены
  assert.strictEqual(ctx.db.readAll_('WashItems').filter(wi => wi.wash_id === washId).length, 2);
  // Две открытые clean-записи склада — по заходу на стирку
  const clean = ctx.db.readAll_('Storage').filter(s =>
    s.client_id === clientId && s.kind === 'clean' && !s.consumed_at);
  assert.strictEqual(clean.length, 2);
});

test('R1-char: повторное завершение не дублирует WashItems и отклоняется', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId, 10);
  const done = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 5 }], 9.5, null, 1);
  assert.ok(done.ok);
  assert.strictEqual(ctx.db.readAll_('WashItems').length, 1);

  const again = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 1 }], 9.5, null, 1);
  assert.ok(!again.ok);
  assert.strictEqual(ctx.db.readAll_('WashItems').length, 1);
  // Clean-запись склада одна
  assert.strictEqual(ctx.api.getStorage(owner).clean.length, 1);
});

// --- deferWash по partial ---

test('R1-char: deferWash по partial — визит развоза едет следом, dirty-запись склада восстановлена', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const visit = ctx.api.addDeliveryVisit(owner, clientId, TOMORROW).visit;
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  const part = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }], 6.5, 'partial', 1);
  assert.strictEqual(part.wash.status, 'partial');

  const def = ctx.api.deferWash(owner, washId, '2026-08-14', 'не достирали');
  assert.ok(def.ok);
  // Стирка снова плановая на новую дату, выдача — следующий день
  assert.strictEqual(def.wash.status, 'planned');
  assert.strictEqual(def.wash.wash_date, '2026-08-14');
  assert.strictEqual(def.wash.issue_date, '2026-08-15');
  assert.strictEqual(def.wash.deferred_from, TODAY);
  // Постиранная часть не затирается
  assert.strictEqual(Number(def.wash.dirty_weight_kg), 6.5);
  assert.strictEqual(Number(def.wash.items_total), 4);
  // Визит развоза переехал: завтра → день после новой даты стирки
  const v = ctx.db.findById_('Deliveries', visit.id).obj;
  assert.strictEqual(v.date, '2026-08-15');
  assert.strictEqual(v.status, 'planned');
  // Остаток грязного снова «на складе»: открытая dirty-запись
  const dirty = ctx.db.readAll_('Storage').filter(s =>
    s.client_id === clientId && s.kind === 'dirty' && !s.consumed_at);
  assert.strictEqual(dirty.length, 1);
});

// --- holdPartialWash ---

test('R1-char: holdPartialWash — маркер hold в deferred_reason, дата не переносится, статус partial', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }], 6.5, 'partial', 1);

  const hold = ctx.api.holdPartialWash(owner, washId);
  assert.ok(hold.ok);
  assert.strictEqual(hold.wash.status, 'partial');
  assert.strictEqual(hold.wash.deferred_reason, 'hold');
  // Дата стирки и выдачи НЕ переносятся
  assert.strictEqual(hold.wash.wash_date, TODAY);
  assert.strictEqual(hold.wash.issue_date, TOMORROW);
  // Решение отражено на складе
  assert.strictEqual(ctx.api.getStorage(owner).partialClean[0].wash_hold, 1);
  // Не частичную стирку «захолдить» нельзя
  const other = ctx.api.addToDelivery(owner, clientId, '2026-08-14', '2026-08-15').wash.id;
  assert.strictEqual(ctx.api.holdPartialWash(owner, other).error, 'Не частичная стирка');
});

// --- getClientInvoice ---

test('R1-char: getClientInvoice — счёт за период строится из washes/visits', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const clientId = seedClient(ctx);
  const items = ctx.api.listBillingItems(owner).items;
  const biWeight = items.find(i => i.kind === 'wash_weight').id;
  const biOneway = items.find(i => i.kind === 'trip' && i.oneway === 'да').id;
  assert.ok(ctx.api.saveTariff(owner, '', biWeight, 50).ok);
  assert.ok(ctx.api.saveTariff(owner, '', biOneway, 300).ok);

  // Завершённая выданная стирка 10 кг в периоде
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId, 10);
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 5 }], 10, null, 1);
  assert.ok(ctx.api.markIssued(owner, washId).ok);
  // Внепериодная стирка (июль) — в счёт не входит
  ctx.db.appendRowTenant_('Washes', {
    id: 'w_char_old', client_id: clientId, wash_date: '2026-07-20', issue_date: '2026-07-21',
    status: 'done', dirty_weight_kg: '99', items_total: '', comment: '',
    created_by: 'test', created_at: '2026-07-20 08:00:00', started_at: '', done_at: '',
    issued_at: '', deferred_from: '', deferred_reason: '', bags: ''
  }, '1');
  // Одноногий визит-забор в периоде → строка «в одну сторону»
  ctx.db.appendRowTenant_('Deliveries', {
    id: 'del_char_1', date: '2026-08-05', client_id: clientId, ord: '1', status: 'picked',
    delivered_at: '', pickup: 'да', driver_comment: '', created_by: 'test',
    created_at: '2026-08-05 09:00:00', clean_taken_at: '', clean_bags: '',
    picked_at: '2026-08-05 10:00:00', dirty_handed_at: '', pickup_only: '', lift_floor: ''
  }, '1');
  ctx.db.invalidateRefCache_();

  const res = ctx.api.getClientInvoice(owner, clientId, '2026-08-01', '2026-08-31');
  assert.ok(res.ok, res.error);
  const inv = res.invoice;
  const weightLine = inv.lines.find(l => l.billing_item_id === biWeight);
  const onewayLine = inv.lines.find(l => l.billing_item_id === biOneway);
  // Вес: только августовская выданная стирка (10 кг), июльская исключена
  assert.strictEqual(weightLine.qty, 10);
  assert.strictEqual(weightLine.price, 50);
  assert.strictEqual(weightLine.amount, 500);
  assert.strictEqual(onewayLine.qty, 1);
  assert.strictEqual(onewayLine.amount, 300);
  assert.strictEqual(inv.total, 800);
  assert.deepStrictEqual(inv.missing_prices, []);
});

// --- closeShift ---

test('R1-char: closeShift — блокеры, force, итоги смены', async () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  // Незавершённая стирка блокирует закрытие
  const blocked = await ctx.api.closeShift(worker);
  assert.ok(!blocked.ok);
  assert.ok(blocked.error.includes(washId));

  // force=true закрывает несмотря на блокеры
  const forced = await ctx.api.closeShift(worker, true);
  assert.ok(forced.ok);
  assert.strictEqual(forced.shift.status, 'closed');
  assert.strictEqual(forced.shift.closed_at, '21:30');

  // Повторное закрытие отклонено
  assert.ok(!(await ctx.api.closeShift(worker)).ok);
});

test('R1-char: closeShift — итоги смены: washes_done по завершённым', async () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 10 }], 11.5, null, 1);

  const closed = await ctx.api.closeShift(worker);
  assert.ok(closed.ok);
  assert.strictEqual(closed.shift.washes_done, 1);
  assert.strictEqual(closed.shift.date, TODAY);
});

// --- getDayList: идемпотентная материализация ---

test('R1-char: getDayList материализует стирки из развоза идемпотентно', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  assert.ok(ctx.api.addDeliveryVisit(owner, clientId, TOMORROW).ok);

  const day1 = ctx.api.getDayList(owner, TODAY);
  assert.strictEqual(day1.washes.length, 1);
  assert.strictEqual(day1.washes[0].created_by, 'auto');
  assert.strictEqual(day1.washes[0].issue_date, TOMORROW);
  // Повторный вызов не дублирует стирки (ensureWashesFromDelivery_)
  assert.strictEqual(ctx.api.getDayList(owner, TODAY).washes.length, 1);
  assert.strictEqual(ctx.db.readAll_('Washes').length, 1);
  // Отменённая стирка не пересоздаётся
  assert.ok(ctx.api.cancelWash(owner, day1.washes[0].id).ok);
  assert.strictEqual(ctx.api.getDayList(owner, TODAY).washes.length, 0);
});

// --- Права ---

test('R1-char: права — worker на owner-методах получает «Нет доступа»', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const worker = loginWorker();
  assert.strictEqual(ctx.api.holdPartialWash(worker, 'wash_x').error, 'Нет доступа');
  assert.strictEqual(ctx.api.getDeliveryPlan(worker, TODAY).error, 'Нет доступа');
  assert.strictEqual(ctx.api.saveClient(worker, { name: 'X' }).error, 'Нет доступа');
  assert.strictEqual(ctx.api.listUsers(worker).error, 'Нет доступа');
  assert.ok(clientId); // контекст прогрет
});

// --- Снапшот публичного API ---

const API_SNAPSHOT = [
  'addDeliveryVisit', 'addToDelivery', 'addUnplannedWash', 'addWeekCard', 'cancelWash',
  'closeShift', 'completeWash', 'confirmStorageCheck', 'correctVisit', 'createLaundry', 'createUser',
  'deactivateLaundry', 'deactivateUser', 'deferWash', 'deleteBillingItem', 'deleteClient',
  'deleteItemType', 'deletePayAdjustment', 'deleteUser', 'deleteWash', 'driverAction',
  'driverHandover', 'driverTakeAllClean', 'editWashData', 'getClientInvoice', 'getDayList',
  'getDayReport', 'getDeliveryPlan', 'getDeliveryPointStats', 'getDeliveryVisits',
  'getDriverRoute', 'getFinanceSummary', 'getMyPayroll', 'getPayroll', 'getRefs',
  'getShiftCloseState', 'getStorage', 'getSummaryReport', 'getTvData', 'getWeekPlan',
  'getWorkHours', 'holdPartialWash', 'listBillingItems', 'listClientItemBilling',
  'listLaundries', 'listPayAdjustments', 'listPayRates', 'listPaySettings', 'listTariffs',
  'listUsers', 'login', 'logout', 'makeTelegramBindCode', 'markIssued', 'moveDeliveryVisit',
  'moveWeekCard', 'purgeClient', 'reactivateUser', 'rememberClientItemType',
  'removeDeliveryVisit', 'removeWeekCard', 'resetUserPassword', 'saveBillingItem',
  'saveClient', 'saveClientItemBilling', 'saveItemType', 'savePayAdjustment', 'savePayRate',
  'savePaySettings', 'saveTariff', 'setPickupOnly', 'setVisitLiftFloor', 'setWorkHours',
  'startWash', 'switchLaundry', 'updateIssueDate', 'updateLaundry', 'updateUser'
];

test('R1-char: снапшот — состав публичного api не изменился (78 методов)', () => {
  const api = require('../api').api;
  assert.deepStrictEqual(Object.keys(api).sort(), API_SNAPSHOT);
});
