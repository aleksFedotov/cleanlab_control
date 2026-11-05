// Тесты driverTakeClean (R9, docs/Тикет R9 — единая команда забора чистого водителем.md):
// выборочный забор чистого по списку визитов — один вызов API, одна серверная
// транзакция на весь список. Точки без чистого и неподходящие id пропускаются
// (best-effort), сбой посередине пакета не оставляет частично взятых точек.
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

test('забор по списку: склад помечен driver + visit_id, визиты получили clean_taken_at/bags', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientA = seedClient(ctx, owner, 'Отель А');
  const clientB = seedClient(ctx, owner, 'Отель Б');
  const vA = ctx.api.addDeliveryVisit(owner, clientA, TODAY).visit;
  const vB = ctx.api.addDeliveryVisit(owner, clientB, TODAY).visit;
  washToStorage(ctx, owner, worker, clientA, 3);
  washToStorage(ctx, owner, worker, clientB, 2);

  const r = ctx.api.driverTakeClean(driver, [vA.id, vB.id]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.taken, 2);
  assert.strictEqual(r.bags, 5);
  assert.strictEqual(r.skipped, 0);

  const storeA = cleanStorage(ctx, clientA);
  assert.strictEqual(storeA[0].consumed_at, 'driver');
  assert.strictEqual(storeA[0].visit_id, vA.id);
  const storeB = cleanStorage(ctx, clientB);
  assert.strictEqual(storeB[0].consumed_at, 'driver');
  assert.strictEqual(storeB[0].visit_id, vB.id);

  assert.ok(visitRow(ctx, vA.id).clean_taken_at, 'визит А: clean_taken_at');
  assert.strictEqual(Number(visitRow(ctx, vA.id).clean_bags), 3);
  assert.ok(visitRow(ctx, vB.id).clean_taken_at, 'визит Б: clean_taken_at');
  assert.strictEqual(Number(visitRow(ctx, vB.id).clean_bags), 2);
});

test('Log: take_clean_batch со списком id и итогами', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const v = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  washToStorage(ctx, owner, worker, clientId, 4);

  assert.ok(ctx.api.driverTakeClean(driver, [v.id]).ok);
  const ev = logEvents(ctx, 'take_clean_batch').pop();
  assert.ok(ev, 'событие take_clean_batch записано');
  const details = JSON.parse(ev.details);
  assert.deepStrictEqual(details.visits, [v.id]);
  assert.strictEqual(details.taken, 1);
  assert.strictEqual(details.bags, 4);
  assert.strictEqual(details.skipped, 0);
});

test('точка без чистого на складе — skipped, остальные взяты', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientA = seedClient(ctx, owner, 'Отель А');
  const clientB = seedClient(ctx, owner, 'Отель Б');
  const vA = ctx.api.addDeliveryVisit(owner, clientA, TODAY).visit;
  const vB = ctx.api.addDeliveryVisit(owner, clientB, TODAY).visit; // чистого нет
  washToStorage(ctx, owner, worker, clientA, 2);

  const r = ctx.api.driverTakeClean(driver, [vA.id, vB.id]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.taken, 1);
  assert.strictEqual(r.bags, 2);
  assert.strictEqual(r.skipped, 1);
  assert.ok(visitRow(ctx, vA.id).clean_taken_at, 'точка с чистым взята');
  assert.strictEqual(visitRow(ctx, vB.id).clean_taken_at, '', 'пустая точка не тронута');
});

test('чужой id / закрытый визит / уже взятый — пропуск, не ошибка', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientOwn = seedClient(ctx, owner, 'Отель А');
  const vOwn = ctx.api.addDeliveryVisit(owner, clientOwn, TODAY).visit;
  // Отдельные клиенты: дедуп ensureVisit_ — один клиент, один визит на дату
  const clientClosed = seedClient(ctx, owner, 'Отель Б');
  const vClosed = ctx.api.addDeliveryVisit(owner, clientClosed, TODAY).visit;
  const clientTaken = seedClient(ctx, owner, 'Отель В');
  const vTaken = ctx.api.addDeliveryVisit(owner, clientTaken, TODAY).visit;
  const clientEmpty = seedClient(ctx, owner, 'Отель Г');
  const vEmpty = ctx.api.addDeliveryVisit(owner, clientEmpty, TODAY).visit;
  washToStorage(ctx, owner, worker, clientClosed, 2);
  washToStorage(ctx, owner, worker, clientTaken, 2);

  assert.ok(ctx.api.driverAction(driver, vClosed.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, vClosed.id, 'deliver_clean').ok);
  assert.strictEqual(visitRow(ctx, vClosed.id).status, 'delivered');

  assert.ok(ctx.api.driverAction(driver, vTaken.id, 'take_clean').ok);

  // Визит чужой прачки напрямую в БД: для водителя прачки 1 его id «не найден»
  seedLaundry2();
  ctx.db.appendRow_('Deliveries', {
    id: 'del_foreign', date: TODAY, client_id: 'cli_foreign', ord: 0, status: 'planned',
    delivered_at: '', pickup: '', driver_comment: '', created_by: 'test', created_at: '',
    laundry_id: '2'
  });

  const r = ctx.api.driverTakeClean(driver, ['del_none', 'del_foreign', vClosed.id, vTaken.id, vEmpty.id]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.taken, 0);
  assert.strictEqual(r.skipped, 1, 'пустая точка — best-effort пропуск; чужие/закрытые/взятые молча отфильтрованы');
  assert.strictEqual(visitRow(ctx, vTaken.id).clean_taken_at.length > 0, true, 'взятый визит не тронут');
  assert.strictEqual(cleanStorage(ctx, clientOwn).length, 0, 'по пустой точке склад не создан');

  assert.strictEqual(ctx.api.driverTakeClean(worker, [vOwn.id]).error, 'Нет доступа');
  assert.strictEqual(ctx.api.driverTakeClean(driver, []).ok, false, 'пустой список — ошибка');
});

test('атомарность: сбой посередине пакета откатывает склад и визиты', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientA = seedClient(ctx, owner, 'Отель А');
  const clientB = seedClient(ctx, owner, 'Отель Б');
  const vA = ctx.api.addDeliveryVisit(owner, clientA, TODAY).visit;
  const vB = ctx.api.addDeliveryVisit(owner, clientB, TODAY).visit;
  washToStorage(ctx, owner, worker, clientA, 2);
  washToStorage(ctx, owner, worker, clientB, 2);

  // Подмена: второй вызов updateRow_ по Deliveries бросает — команда должна откатиться целиком
  const realUpdate = ctx.db.updateRow_;
  let calls = 0;
  ctx.db.updateRow_ = function (sheet, rowNumber, obj) {
    if (sheet === 'Deliveries') {
      calls++;
      if (calls === 2) throw new Error('boom: сбой записи визита');
    }
    return realUpdate.call(ctx.db, sheet, rowNumber, obj);
  };
  try {
    assert.throws(
      () => ctx.api.driverTakeClean(driver, [vA.id, vB.id]),
      /boom/,
      'исключение из транзакции пробрасывается'
    );
  } finally {
    ctx.db.updateRow_ = realUpdate;
  }

  assert.strictEqual(cleanStorage(ctx, clientA).some(function (s) { return s.consumed_at === 'driver'; }), false,
    'склад клиента А не изменён');
  assert.strictEqual(cleanStorage(ctx, clientB).some(function (s) { return s.consumed_at === 'driver'; }), false,
    'склад клиента Б не изменён');
  assert.strictEqual(visitRow(ctx, vA.id).clean_taken_at, '', 'визит А не взят');
  assert.strictEqual(visitRow(ctx, vB.id).clean_taken_at, '', 'визит Б не взят');
  // Событие в лог не должно остаться от откаченной транзакции
  assert.strictEqual(logEvents(ctx, 'take_clean_batch').length, 0, 'лог откатился вместе с транзакцией');
});

test('regression driverTakeAllClean: ответ с skipped, поведение прежнее', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const clientA = seedClient(ctx, owner, 'Отель А');
  const clientB = seedClient(ctx, owner, 'Отель Б');
  ctx.api.addDeliveryVisit(owner, clientA, TODAY).visit;
  ctx.api.addDeliveryVisit(owner, clientB, TODAY).visit; // чистого нет — skipped
  washToStorage(ctx, owner, worker, clientA, 3);

  const r = ctx.api.driverTakeAllClean(driver, TODAY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.taken, 1);
  assert.strictEqual(r.bags, 3);
  assert.strictEqual(r.skipped, 1);

  // Повторный массовый забор: взятая точка отфильтрована, пустая снова пропущена
  const again = ctx.api.driverTakeAllClean(driver, TODAY);
  assert.ok(again.ok, again.error);
  assert.strictEqual(again.taken, 0);
  assert.strictEqual(again.skipped, 1);
});
