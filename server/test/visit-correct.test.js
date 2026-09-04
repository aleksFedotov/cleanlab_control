// Тесты correctVisit (P6, docs/Тикет P6 — правка визита задним числом.md):
// отмена действий водителя задним числом + setVisitLiftFloor водителем.
// P6.1 (docs/Тикет P6.1): undo_pickup при сданном на складе грязном откатывает
// и складскую запись; cancelWash из in_progress возвращает dirty-записи на склад.
const test = require('node:test');
const assert = require('node:assert');
const {
  makeCtx, loginOwner, loginWorker, loginDriver,
  seedUser, seedLaundry2, loginDriver2, TODAY
} = require('./helpers/serverMocks');
const auth = require('../auth');

function seedClient(ctx, owner, name) {
  const res = ctx.api.saveClient(owner, { name: name || 'Отель А', type: 'отель' });
  assert.ok(res.ok);
  return res.client.id;
}

// Чистое на складе клиента: стирка прошла полный цикл (в работу → завершение).
function washToStorage(ctx, owner, worker, clientId, bags) {
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TODAY).wash.id;
  assert.ok(ctx.api.startWash(worker, washId).ok);
  const done = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 2 }], 5, null, bags || 2);
  assert.ok(done.ok, done.error);
  return washId;
}

function cleanStorage(ctx, clientId) {
  return ctx.db.readAll_('Storage').filter(function (s) {
    return s.client_id === clientId && s.kind === 'clean';
  });
}

function visitRow(ctx, visitId) {
  return ctx.db.findById_('Deliveries', visitId).obj;
}

test('undo_empty: empty → planned, поля чистые; дальше driverAction работает', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;

  assert.ok(ctx.api.driverAction(driver, v.id, 'empty').ok);
  assert.strictEqual(visitRow(ctx, v.id).status, 'empty');

  const r = ctx.api.correctVisit(driver, v.id, 'undo_empty');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'planned');
  assert.strictEqual(r.visit.delivered_at, '');

  // Правильное действие отмечается тут же
  const r2 = ctx.api.driverAction(driver, v.id, 'pickup_dirty');
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(r2.visit.status, 'picked');

  // Повторная отмена на не-empty — ошибка
  assert.strictEqual(ctx.api.correctVisit(driver, v.id, 'undo_empty').ok, false);
});

test('undo_take_clean: чистое возвращается на склад; блок при выданном', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 2);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.strictEqual(cleanStorage(ctx, clientId)[0].consumed_at, 'driver');

  const r = ctx.api.correctVisit(driver, v.id, 'undo_take_clean');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.clean_taken_at, '');
  assert.strictEqual(r.visit.clean_bags, '');
  assert.strictEqual(cleanStorage(ctx, clientId)[0].consumed_at, '', 'чистое снова на складе');

  // Можно взять заново и выдать
  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, v.id, 'deliver_clean').ok);

  // Блок: выданное чистое нельзя «снять с водителя»
  const blocked = ctx.api.correctVisit(driver, v.id, 'undo_take_clean');
  assert.strictEqual(blocked.ok, false);
  assert.ok(/сначала отмените выдачу/.test(blocked.error));
});

test('undo_deliver: стирки → stored, чистое снова у водителя, delivered → planned', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  const washId = washToStorage(ctx, owner, worker, clientId, 2);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, v.id, 'deliver_clean').ok);
  assert.strictEqual(visitRow(ctx, v.id).status, 'delivered');
  assert.strictEqual(ctx.db.findById_('Washes', washId).obj.status, 'issued');

  const r = ctx.api.correctVisit(owner, v.id, 'undo_deliver'); // отменяет владелец
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'planned');
  assert.strictEqual(r.visit.delivered_at, '');
  const wash = ctx.db.findById_('Washes', washId).obj;
  assert.strictEqual(wash.status, 'stored');
  assert.strictEqual(wash.issued_at, '');
  assert.strictEqual(cleanStorage(ctx, clientId)[0].consumed_at, 'driver', 'чистое снова у водителя');

  // Выдачу можно отметить заново
  assert.ok(ctx.api.driverAction(driver, v.id, 'deliver_clean').ok);
  assert.strictEqual(visitRow(ctx, v.id).status, 'delivered');
});

test('undo_deliver из both: статус → picked', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 1);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverAction(driver, v.id, 'deliver_clean').ok);
  assert.strictEqual(visitRow(ctx, v.id).status, 'both');

  const r = ctx.api.correctVisit(driver, v.id, 'undo_deliver');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'picked');
  assert.strictEqual(r.visit.delivered_at, '');
  assert.ok(r.visit.picked_at, 'забор грязного сохранён');
});

test('undo_deliver: стирки не найдены — визит откатан, warn в логе', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  const washId = washToStorage(ctx, owner, worker, clientId, 1);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, v.id, 'deliver_clean').ok);

  // «Правили вручную»: стирку уже перевели в другой статус
  const w = ctx.db.findById_('Washes', washId);
  w.obj.status = 'done';
  ctx.db.updateRow_('Washes', w.rowNumber, w.obj);

  const r = ctx.api.correctVisit(driver, v.id, 'undo_deliver');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'planned');
  const ev = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'visit_correct'; }).pop();
  assert.ok(ev, 'событие visit_correct записано');
  const details = JSON.parse(ev.details);
  assert.strictEqual(details.op, 'undo_deliver');
  assert.strictEqual(details.warn, 'washes_not_found');
  assert.strictEqual(details.before.status, 'delivered');
  assert.strictEqual(details.after.status, 'planned');
  assert.ok(details.before.delivered_at, 'before хранит delivered_at');
  assert.strictEqual(details.after.delivered_at, '');
});

test('undo_pickup: picked → planned, both → delivered', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;

  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok);
  assert.strictEqual(visitRow(ctx, v.id).status, 'picked');

  const r = ctx.api.correctVisit(driver, v.id, 'undo_pickup');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'planned');
  assert.strictEqual(r.visit.picked_at, '');
  assert.strictEqual(r.visit.pickup, '');

  // both → delivered: забираем грязное при уже выданном чистом
  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok);
  // имитируем выданное чистое правкой полей (как после deliver_clean)
  const row = ctx.db.findById_('Deliveries', v.id);
  row.obj.delivered_at = '2026-08-12 12:00:00';
  row.obj.status = 'both';
  ctx.db.updateRow_('Deliveries', row.rowNumber, row.obj);
  const r2 = ctx.api.correctVisit(driver, v.id, 'undo_pickup');
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(r2.visit.status, 'delivered');
});

// --- P6.1: откат склада при отмене забора сданного грязного ---

function dirtyStorage(ctx, clientId) {
  return ctx.db.readAll_('Storage').filter(function (s) {
    return s.client_id === clientId && s.kind === 'dirty';
  });
}

test('undo_pickup: грязное сдано, запись открыта → запись удалена, визит откачен', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;

  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverHandover(driver).ok);
  assert.ok(visitRow(ctx, v.id).dirty_handed_at);
  assert.strictEqual(dirtyStorage(ctx, clientId).length, 1, 'фантом висит на складе');

  const r = ctx.api.correctVisit(driver, v.id, 'undo_pickup');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'planned');
  assert.strictEqual(r.visit.picked_at, '');
  assert.strictEqual(r.visit.dirty_handed_at, '');
  assert.strictEqual(dirtyStorage(ctx, clientId).length, 0, 'фантом исчез со склада');

  const ev = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'visit_correct'; }).pop();
  const details = JSON.parse(ev.details);
  assert.strictEqual(details.storage_found, 1);
  assert.strictEqual(details.storage_removed, 1);
  assert.ok(details.before.dirty_handed_at);
  assert.strictEqual(details.after.dirty_handed_at, '');
});

test('undo_pickup: 2 записи с одной меткой (массовая сдача) → удалена ровно одна', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  // Два визита одного клиента (разные дни), сдача разом → записи с одним created_at
  const v1 = ctx.api.addDeliveryVisit(owner, clientId, '2026-08-12').visit;
  const v2 = ctx.api.addDeliveryVisit(owner, clientId, '2026-08-13').visit;
  assert.ok(ctx.api.driverAction(driver, v1.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverAction(driver, v2.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverHandover(driver).ok);
  assert.strictEqual(dirtyStorage(ctx, clientId).length, 2);
  assert.strictEqual(visitRow(ctx, v1.id).dirty_handed_at, visitRow(ctx, v2.id).dirty_handed_at);

  const r = ctx.api.correctVisit(driver, v1.id, 'undo_pickup');
  assert.ok(r.ok, r.error);
  const rest = dirtyStorage(ctx, clientId);
  assert.strictEqual(rest.length, 1, 'вторая запись не тронута');
  const ev = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'visit_correct'; }).pop();
  assert.strictEqual(JSON.parse(ev.details).storage_found, 2);

  // Второй визит откатывается по оставшейся записи
  const r2 = ctx.api.correctVisit(driver, v2.id, 'undo_pickup');
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(dirtyStorage(ctx, clientId).length, 0);
});

test('undo_pickup: партия в стирке → ошибка с номером стирки, состояние не меняется', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverHandover(driver).ok);

  // Приёмка: стирка забирает грязное со склада
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TODAY).wash.id;
  assert.ok(ctx.api.startWash(worker, washId).ok);
  assert.ok(dirtyStorage(ctx, clientId)[0].wash_id, 'запись израсходована стиркой');

  const blocked = ctx.api.correctVisit(driver, v.id, 'undo_pickup');
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.error.indexOf('Грязное уже принято в стирку (стирка ' + washId + ')') === 0, blocked.error);
  assert.ok(/Отмените её на складе, затем повторите отмену забора/.test(blocked.error));

  // Ничего не изменилось
  const vRow = visitRow(ctx, v.id);
  assert.strictEqual(vRow.status, 'picked');
  assert.ok(vRow.picked_at);
  assert.ok(vRow.dirty_handed_at);
  assert.strictEqual(dirtyStorage(ctx, clientId).length, 1);
});

test('цепочка: startWash → cancelWash возвращает записи → undo_pickup проходит', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverHandover(driver).ok);
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TODAY).wash.id;
  assert.ok(ctx.api.startWash(worker, washId).ok);

  const c = ctx.api.cancelWash(owner, washId);
  assert.ok(c.ok, c.error);
  assert.strictEqual(c.wash.status, 'cancelled');
  const entry = dirtyStorage(ctx, clientId)[0];
  assert.strictEqual(entry.consumed_at, '', 'запись снова на складе');
  assert.strictEqual(entry.wash_id, '');
  const cancelEv = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'wash_cancel'; }).pop();
  assert.strictEqual(JSON.parse(cancelEv.details).storage_returned, 1);

  const r = ctx.api.correctVisit(driver, v.id, 'undo_pickup');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'planned');
  assert.strictEqual(dirtyStorage(ctx, clientId).length, 0, 'запись удалена при откате');
});

test('undo_pickup: запись не найдена → визит откачен, warn storage_not_found', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverHandover(driver).ok);

  // «Правили вручную»: складскую запись удалили
  const s = ctx.db.readAll_('Storage').filter(function (row) { return row.kind === 'dirty'; })[0];
  const sRow = ctx.db.findById_('Storage', s.id);
  ctx.db.deleteRow_('Storage', sRow.rowNumber);

  const r = ctx.api.correctVisit(driver, v.id, 'undo_pickup');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'planned');
  assert.strictEqual(r.visit.dirty_handed_at, '');
  const ev = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'visit_correct'; }).pop();
  assert.strictEqual(JSON.parse(ev.details).warn, 'storage_not_found');
});

test('cancelWash из planned без складских записей — как раньше (регрессия)', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TODAY).wash.id;

  const c = ctx.api.cancelWash(owner, washId);
  assert.ok(c.ok, c.error);
  assert.strictEqual(c.wash.status, 'cancelled');
  const ev = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'wash_cancel'; }).pop();
  assert.strictEqual(JSON.parse(ev.details).storage_returned, 0);

  // Из завершённых статусов отмена по-прежнему запрещена
  const worker = loginWorker();
  const wash2 = washToStorage(ctx, owner, worker, clientId, 1);
  const blocked = ctx.api.cancelWash(owner, wash2);
  assert.strictEqual(blocked.ok, false);
});

test('setVisitLiftFloor водителем: 5 → "5", 2 → ""; счёт и надбавка пересчитываются', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const items = ctx.api.listBillingItems(owner).items;
  const lift = items.find(function (i) { return i.kind === 'lift'; });
  assert.ok(ctx.api.saveTariff(owner, '', lift.id, 300).ok);

  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  assert.ok(ctx.api.driverAction(driver, v.id, 'pickup_dirty').ok); // закрытый визит

  const r = ctx.api.setVisitLiftFloor(driver, v.id, 5);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.lift_floor, '5');

  // Счёт: (5−2) × 300
  let inv = ctx.api.getClientInvoice(owner, clientId, '2026-08-01', '2026-08-31').invoice;
  assert.strictEqual(inv.lines.find(function (l) { return l.billing_item_id === lift.id; }).qty, 3);
  // Надбавка водителя: 3 этажа × дефолтные 100
  assert.strictEqual(ctx.api.getDriverRoute(driver, TODAY).stats.lift_pay, 300);

  const r2 = ctx.api.setVisitLiftFloor(driver, v.id, 2);
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(r2.visit.lift_floor, '', '1–2 этаж — без доплаты');
  inv = ctx.api.getClientInvoice(owner, clientId, '2026-08-01', '2026-08-31').invoice;
  assert.ok(!inv.lines.find(function (l) { return l.billing_item_id === lift.id; }),
    'строка подъёма исчезла из счёта');
  assert.strictEqual(ctx.api.getDriverRoute(driver, TODAY).stats.lift_pay, 0);
});

test('права: worker/client → «Нет доступа»; чужой визит → «Визит не найден»', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  seedUser('usr_c1', '1', 'Клиент', 'client', 'client1', 'client-pass');
  const clientTok = auth.login('client1', 'client-pass').token;
  const worker = loginWorker();

  [worker, clientTok].forEach(function (token) {
    assert.strictEqual(ctx.api.correctVisit(token, v.id, 'undo_pickup').error, 'Нет доступа');
    assert.strictEqual(ctx.api.setVisitLiftFloor(token, v.id, 3).error, 'Нет доступа');
  });

  // Чужая прачка
  seedLaundry2();
  const driver2 = loginDriver2();
  assert.strictEqual(ctx.api.correctVisit(driver2, v.id, 'undo_pickup').error, 'Визит не найден');
  assert.strictEqual(ctx.api.setVisitLiftFloor(driver2, v.id, 3).error, 'Визит не найден');

  // Неизвестная операция
  assert.strictEqual(ctx.api.correctVisit(loginDriver(), v.id, 'boom').error, 'Неизвестная операция');
});
