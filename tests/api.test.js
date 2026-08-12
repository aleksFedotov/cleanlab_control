// Тесты T4: API поверх моков — права, идемпотентность, блокировка закрытия смены.
const test = require('node:test');
const assert = require('node:assert');
const { makeApiCtx, loginOwner, loginWorker } = require('./helpers/gasMocks');

const TODAY = '2026-08-12';
const TOMORROW = '2026-08-13';

function seedClient(ctx, over = {}) {
  const t = loginOwner(ctx);
  const res = ctx.saveClient(t, Object.assign({ name: 'Отель А', type: 'отель' }, over));
  assert.ok(res.ok);
  return res.client.id;
}

test('login: неверный PIN отклоняется, верный даёт токен и роль', () => {
  const { ctx } = makeApiCtx();
  assert.ok(!ctx.login('0000').ok);
  const owner = ctx.login('1111');
  assert.strictEqual(owner.role, 'owner');
  assert.strictEqual(ctx.login('2222').role, 'worker');
  // Истёкший/чужой токен не пускает
  assert.ok(!ctx.getDayList('нет-такого', TODAY).ok);
  // Явный выход отзывает токен
  ctx.logout(owner.token);
  assert.ok(!ctx.getDayList(owner.token, TODAY).ok);
});

test('права: worker не может owner-действия, owner может', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  assert.ok(!ctx.cancelWash(worker, washId).ok);
  assert.ok(!ctx.getDeliveryPlan(worker, TODAY).ok);
  assert.ok(!ctx.getStorage(worker).ok);
  assert.ok(!ctx.saveClient(worker, { name: 'X' }).ok);
  assert.ok(ctx.cancelWash(owner, washId).ok);
  // Отменённая исчезает из списка дня и не блокирует закрытие
  const day = ctx.getDayList(worker, TODAY);
  assert.strictEqual(day.washes.length, 0);
});

test('полный цикл: постановка → в работу → завершение, идемпотентность', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  // В работу с весом; повтор — отклонён, started_at не затёрт
  const started = ctx.startWash(worker, washId, 12.34);
  assert.ok(started.ok);
  assert.strictEqual(started.wash.dirty_weight_kg, 12.3); // округление до 0,1
  assert.strictEqual(started.wash.status, 'in_progress');
  assert.ok(!ctx.startWash(worker, washId, 99).ok);
  assert.strictEqual(ctx.getDayList(worker, TODAY).washes[0].dirty_weight_kg, 12.3);

  // Завершение: WashItems атомарно, qty=0 не пишется, статус done (выдача завтра)
  const done = ctx.completeWash(worker, washId, [
    { item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 0 }, { item_type_id: 'itm_3', qty: 5 }
  ]);
  assert.ok(done.ok);
  assert.strictEqual(done.wash.status, 'done');
  assert.strictEqual(done.wash.items_total, 15);
  const items = ctx.readAll_('WashItems');
  assert.strictEqual(items.length, 2);

  // Повторное завершение не дублирует WashItems
  assert.ok(!ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 1 }]).ok);
  assert.strictEqual(ctx.readAll_('WashItems').length, 2);

  // Смена создана автоматически первым действием
  const shift = ctx.readAll_('Shifts').find(s => s.date === TODAY);
  assert.strictEqual(shift.status, 'open');

  // Лог содержит события жизненного цикла
  const actions = ctx.readAll_('Log').map(l => l.action);
  assert.deepStrictEqual(actions, ['wash_create', 'wash_start', 'wash_done']);
});

test('правило stored: дальняя дата выдачи при завершении → stored', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx, { storage: 'да' });
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, '2026-08-20').wash.id;
  ctx.startWash(worker, washId, 5);
  const done = ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 3 }]);
  assert.strictEqual(done.wash.status, 'stored');
  // stored закрытие смены не блокирует
  assert.ok(ctx.closeShift(worker).ok);
});

test('перенос: вес и статус сохраняются, закрытие разблокируется', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.startWash(worker, washId, 7);

  // Закрытие заблокировано незавершённой
  const blocked = ctx.closeShift(worker);
  assert.ok(!blocked.ok);
  assert.match(blocked.error, /незавершённые/);

  // Перенос на завтра: статус и вес на месте
  const moved = ctx.deferWash(worker, washId, TOMORROW, 'не успели');
  assert.strictEqual(moved.wash.status, 'in_progress');
  assert.strictEqual(moved.wash.wash_date, TOMORROW);
  assert.strictEqual(moved.wash.deferred_from, TODAY);
  assert.strictEqual(moved.wash.dirty_weight_kg, 7);

  // Теперь закрытие проходит; в отчёте — 1 перенос
  const closed = ctx.closeShift(worker);
  assert.ok(closed.ok);
  assert.strictEqual(closed.report.deferred, 1);
  assert.strictEqual(closed.shift.status, 'closed');
  // Повторное закрытие отклонено
  assert.ok(!ctx.closeShift(worker).ok);
});

test('editWashData: перезапись пересчёта, worker при закрытой смене не может', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.startWash(worker, washId, 10);
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }]);

  // Worker правит при открытой смене: старые WashItems удалены, новые записаны
  const edited = ctx.editWashData(worker, washId, 11, [{ item_type_id: 'itm_2', qty: 7 }]);
  assert.ok(edited.ok);
  assert.strictEqual(edited.wash.dirty_weight_kg, 11);
  assert.strictEqual(edited.wash.items_total, 7);
  assert.strictEqual(edited.wash.status, 'done'); // статус не изменился
  const items = ctx.readAll_('WashItems');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].item_type_id, 'itm_2');

  // После закрытия смены worker не может, owner — может
  ctx.closeShift(worker);
  assert.ok(!ctx.editWashData(worker, washId, 12, []).ok);
  assert.ok(ctx.editWashData(owner, washId, 12, [{ item_type_id: 'itm_1', qty: 1 }]).ok);
  // Снимок Shifts.total_kg после закрытия не пересчитан (spec §4.2)
  assert.strictEqual(Number(ctx.readAll_('Shifts')[0].total_kg), 11);
});

test('updateIssueDate и markIssued: выдача со склада', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx, { storage: 'да' });
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, '2026-08-20').wash.id;
  ctx.startWash(worker, washId, 3);
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_7', qty: 2 }]);

  assert.ok(!ctx.updateIssueDate(worker, washId, TOMORROW).ok); // worker не может
  const upd = ctx.updateIssueDate(owner, washId, TOMORROW);
  assert.ok(upd.ok);
  assert.strictEqual(upd.wash.status, 'stored'); // статус не изменился
  // Появилась в «Выдать сегодня» плана на завтра
  const plan = ctx.getDeliveryPlan(owner, TOMORROW);
  assert.strictEqual(plan.issueToday.length, 1);
  // Склад показывает стирку с позициями
  assert.strictEqual(ctx.getStorage(owner).stored[0].items[0].qty, 2);

  const issued = ctx.markIssued(owner, washId);
  assert.ok(issued.ok);
  assert.strictEqual(issued.wash.status, 'issued');
  assert.ok(!ctx.markIssued(owner, washId).ok); // повтор отклонён
  // Отчёт за сегодня: выдано учтено по issued_at
  assert.strictEqual(ctx.getDayReport(owner, TODAY).report.issued, 1);
});

test('внеплановая стирка сотрудника попадает в список дня', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const worker = loginWorker(ctx);
  const res = ctx.addUnplannedWash(worker, clientId, 'срочно');
  assert.ok(res.ok);
  assert.strictEqual(res.wash.wash_date, TODAY);
  assert.strictEqual(res.wash.created_by, 'worker');
  const day = ctx.getDayList(worker, TODAY);
  assert.strictEqual(day.washes.length, 1);
  assert.strictEqual(day.washes[0].client_name, 'Отель А');
  // Сортировка: незавершённые впереди
  ctx.startWash(worker, res.wash.id, 1);
  ctx.completeWash(worker, res.wash.id, []);
  ctx.addUnplannedWash(worker, clientId, 'ещё');
  const ids = Array.from(ctx.getDayList(worker, TODAY).washes.map(w => w.comment));
  assert.deepStrictEqual(ids, ['ещё', 'срочно']);
});

test('getTvData: неверный ключ отклоняется, верный отдаёт агрегаты дня', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  assert.ok(!ctx.getTvData('wrong').ok);

  const w1 = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  const w2 = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.startWash(worker, w1, 10);
  ctx.completeWash(worker, w1, [{ item_type_id: 'itm_1', qty: 20 }]);
  ctx.deferWash(worker, w2, TOMORROW, ''); // ушла из списка дня

  const tv = ctx.getTvData('tv-secret');
  assert.ok(tv.ok);
  assert.strictEqual(tv.counters.total, 1);
  assert.strictEqual(tv.counters.done, 1);
  assert.strictEqual(tv.washes[0].client, 'Отель А');
  assert.strictEqual(tv.washes[0].kg, 10);
  assert.strictEqual(tv.laundryName, 'Прачка360');
});

test('getDayReport: сводка, детализация с позициями, статус смены', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.startWash(worker, washId, 9.5);
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 5 }]);
  ctx.closeShift(worker);

  const rep = ctx.getDayReport(owner, TODAY);
  assert.strictEqual(rep.report.totalKg, 9.5);
  assert.strictEqual(rep.report.washesDone, 1);
  assert.strictEqual(rep.washes[0].client_name, 'Отель А');
  assert.deepStrictEqual(Array.from(rep.washes[0].items.map(i => `${i.item_name} ×${i.qty}`)),
    ['пододеяльник ×10', 'простыня ×5']);
  assert.strictEqual(rep.shift.status, 'closed');
});

test('справочники: архивация клиента, сброс кэша после записи', () => {
  const { ctx } = makeApiCtx();
  const owner = loginOwner(ctx);
  const clientId = seedClient(ctx);
  ctx.getDeliveryPlan(owner, TODAY); // прогреваем кэш
  ctx.deleteClient(owner, clientId);
  // Кэш сброшен: архивный клиент не предлагается в развоз
  const plan = ctx.getDeliveryPlan(owner, TODAY);
  assert.strictEqual(plan.clients.length, 0);
  // Новый тип белья получает sort после максимального
  const t = ctx.saveItemType(owner, { name: 'килт' });
  assert.strictEqual(t.itemType.sort, 12);
});
