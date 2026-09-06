// Тесты driverReturnClean (P6.2, docs/Тикет P6.2 — возврат чистого на склад.md):
// штатный возврат чистого на склад по конкретной точке — отдельное событие
// clean_return в Log, статус визита и стирки не меняются.
const test = require('node:test');
const assert = require('node:assert');
const {
  makeCtx, loginOwner, loginWorker, loginDriver,
  seedLaundry2, loginDriver2, TODAY
} = require('./helpers/serverMocks');

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

function logEvents(ctx, action) {
  return ctx.db.readAll_('Log').filter(function (e) { return e.action === action; });
}

test('возврат: склад открыт, поля визита очищены, статус planned сохранён', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 3);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.strictEqual(cleanStorage(ctx, clientId)[0].consumed_at, 'driver');

  const r = ctx.api.driverReturnClean(driver, v.id);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.returnedBags, 3);
  assert.strictEqual(r.visit.clean_taken_at, '');
  assert.strictEqual(r.visit.clean_bags, '');
  assert.strictEqual(r.visit.status, 'planned', 'статус не изменился');
  assert.strictEqual(cleanStorage(ctx, clientId)[0].consumed_at, '', 'чистое снова на складе');

  // Чистое можно взять заново обычным действием
  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
});

test('возврат из picked: статус picked сохранён, грязное не тронуто', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 2);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  // picked + чистое у водителя (picked — финальный статус, take_clean после него заблокирован,
  // поэтому состояние эмулируем правкой полей: забор отмечен, чистое ещё с водителем)
  const row = ctx.db.findById_('Deliveries', v.id);
  row.obj.picked_at = '2026-08-12 12:00:00';
  row.obj.status = 'picked';
  ctx.db.updateRow_('Deliveries', row.rowNumber, row.obj);

  const r = ctx.api.driverReturnClean(driver, v.id);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.visit.status, 'picked');
  assert.ok(r.visit.picked_at, 'забор грязного сохранён');
  assert.strictEqual(r.visit.clean_taken_at, '');
});

test('запреты: без взятия → «не взято»; после выдачи → ошибка, склад не меняется', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 2);

  // Без взятия
  const noTake = ctx.api.driverReturnClean(driver, v.id);
  assert.strictEqual(noTake.ok, false);
  assert.ok(/не взято/.test(noTake.error), noTake.error);

  // Выдано → возврат заблокирован, склад не меняется
  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, v.id, 'deliver_clean').ok);
  assert.strictEqual(visitRow(ctx, v.id).status, 'delivered');
  const blocked = ctx.api.driverReturnClean(driver, v.id);
  assert.strictEqual(blocked.ok, false);
  assert.ok(/сначала отмените выдачу/.test(blocked.error), blocked.error);
  assert.strictEqual(cleanStorage(ctx, clientId)[0].consumed_at.length > 0, true, 'склад не изменился');
});

test('стирки не тронуты: done/stored, issued_at пуст, WashItems на месте', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  const washId = washToStorage(ctx, owner, worker, clientId, 2);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  const itemsBefore = ctx.db.readAll_('WashItems').filter(function (i) { return i.wash_id === washId; });
  assert.ok(itemsBefore.length, 'WashItems созданы при завершении стирки');

  const r = ctx.api.driverReturnClean(driver, v.id);
  assert.ok(r.ok, r.error);
  const wash = ctx.db.findById_('Washes', washId).obj;
  assert.ok(wash.status === 'done' || wash.status === 'stored', wash.status);
  assert.strictEqual(wash.issued_at, '');
  const itemsAfter = ctx.db.readAll_('WashItems').filter(function (i) { return i.wash_id === washId; });
  assert.deepStrictEqual(itemsAfter, itemsBefore, 'WashItems не затронуты');
});

test('Log: clean_return с bags; visit_correct отсутствует', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 4);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverReturnClean(driver, v.id).ok);

  const ev = logEvents(ctx, 'clean_return').pop();
  assert.ok(ev, 'событие clean_return записано');
  assert.strictEqual(ev.entity, v.id);
  const details = JSON.parse(ev.details);
  assert.strictEqual(details.bags, 4);
  assert.strictEqual(details.client_id, clientId);
  assert.strictEqual(details.date, TODAY);
  assert.strictEqual(logEvents(ctx, 'visit_correct').length, 0, 'visit_correct не пишется');
});

test('cargo: clean_points/clean_bags уменьшились на точку', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 5);

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.strictEqual(ctx.api.getDriverRoute(driver, TODAY).cargo.clean_bags, 5);

  const r = ctx.api.driverReturnClean(driver, v.id);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.cargo.clean_bags, 0);
  assert.strictEqual(r.cargo.clean_points, 0);
});

test('права: worker → «Нет доступа»; чужая прачка → «Визит не найден»', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 2);
  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);

  assert.strictEqual(ctx.api.driverReturnClean(worker, v.id).error, 'Нет доступа');

  seedLaundry2();
  assert.strictEqual(ctx.api.driverReturnClean(loginDriver2(), v.id).error, 'Визит не найден');

  // Владелец может вернуть
  const r = ctx.api.driverReturnClean(owner, v.id);
  assert.ok(r.ok, r.error);
});

test('идемпотентность: повторный возврат → ошибка, склад не дублируется', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 2);
  const openBefore = cleanStorage(ctx, clientId).filter(function (s) { return !s.consumed_at; }).length;

  assert.ok(ctx.api.driverAction(driver, v.id, 'take_clean').ok);
  assert.ok(ctx.api.driverReturnClean(driver, v.id).ok);
  const openAfter = cleanStorage(ctx, clientId).filter(function (s) { return !s.consumed_at; }).length;
  assert.strictEqual(openAfter, openBefore, 'склад вернулся к исходному состоянию');

  const again = ctx.api.driverReturnClean(driver, v.id);
  assert.strictEqual(again.ok, false);
  assert.ok(/не взято/.test(again.error), again.error);
  assert.strictEqual(
    cleanStorage(ctx, clientId).filter(function (s) { return !s.consumed_at; }).length,
    openBefore, 'склад не задублировался'
  );
});
