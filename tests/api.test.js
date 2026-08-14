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
  assert.strictEqual(ctx.login('3333').role, 'driver');
  // Водителя не пускают в API цеха и владельца
  assert.ok(!ctx.getDayList(ctx.login('3333').token, TODAY).ok);
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

  // В работу (вес на старте необязателен, но принимается); повтор — отклонён
  const started = ctx.startWash(worker, washId, 12.34);
  assert.ok(started.ok);
  assert.strictEqual(started.wash.dirty_weight_kg, 12.3); // округление до 0,1
  assert.strictEqual(started.wash.status, 'in_progress');
  assert.ok(!ctx.startWash(worker, washId, 99).ok);
  assert.strictEqual(ctx.getDayList(worker, TODAY).washes[0].dirty_weight_kg, 12.3);

  // Без веса чистого завершение отклоняется
  assert.ok(!ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 1 }]).ok);

  // Завершение: вес чистого перезаписывает, WashItems атомарно, qty=0 не пишется
  const done = ctx.completeWash(worker, washId, [
    { item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 0 }, { item_type_id: 'itm_3', qty: 5 }
  ], 11.5);
  assert.ok(done.ok);
  assert.strictEqual(done.wash.status, 'done');
  assert.strictEqual(done.wash.items_total, 15);
  assert.strictEqual(done.wash.dirty_weight_kg, 11.5);
  const items = ctx.readAll_('WashItems');
  assert.strictEqual(items.length, 2);

  // Повторное завершение не дублирует WashItems
  assert.ok(!ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 1 }], 11.5).ok);
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
  const done = ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 3 }], 5);
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
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }], 10);

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
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_7', qty: 2 }], 3);

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
  ctx.completeWash(worker, res.wash.id, [], 1);
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
  ctx.completeWash(worker, w1, [{ item_type_id: 'itm_1', qty: 20 }], 10);
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
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 5 }], 9.5);
  ctx.closeShift(worker);

  const rep = ctx.getDayReport(owner, TODAY);
  assert.strictEqual(rep.report.totalKg, 9.5);
  assert.strictEqual(rep.report.washesDone, 1);
  assert.strictEqual(rep.washes[0].client_name, 'Отель А');
  assert.deepStrictEqual(Array.from(rep.washes[0].items.map(i => `${i.item_name} ×${i.qty}`)),
    ['пододеяльник ×10', 'простыня ×5']);
  assert.strictEqual(rep.shift.status, 'closed');
});

test('getRefs: только owner, отдаёт всех клиентов включая архивных', () => {
  const { ctx } = makeApiCtx();
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const clientId = seedClient(ctx);
  ctx.deleteClient(owner, clientId);
  assert.ok(!ctx.getRefs(worker).ok);
  const refs = ctx.getRefs(owner);
  assert.strictEqual(refs.clients.length, 1);
  assert.strictEqual(refs.clients[0].active, 'нет');
  assert.strictEqual(refs.itemTypes.length, 11);
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

// --- Канбан «Неделя» = план развозов (T14) ---
test('getWeekPlan: пустая неделя копирует прошлую один раз, права', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  // Прошлая неделя (03–09.08): визиты 04 и 06, один отменённый
  ctx.addDeliveryVisit(owner, clientId, '2026-08-04');
  ctx.addDeliveryVisit(owner, clientId, '2026-08-06');
  const cancelled = ctx.addDeliveryVisit(owner, clientId, '2026-08-08').visit.id;
  ctx.removeDeliveryVisit(owner, cancelled);

  const res = ctx.getWeekPlan(owner, '2026-08-12'); // нормализуется к понедельнику 08-10
  assert.ok(res.ok);
  assert.strictEqual(res.monday, '2026-08-10');
  const cards = res.days.flatMap(d => d.cards);
  assert.strictEqual(cards.length, 2);
  const byDate = Object.fromEntries(cards.map(c => [c.date, c]));
  assert.ok(byDate['2026-08-11'] && byDate['2026-08-13']); // +7 дней
  assert.strictEqual(byDate['2026-08-11'].status, 'planned');
  assert.strictEqual(byDate['2026-08-11'].client_name, 'Отель А');

  // Повторный вызов не дублирует (идемпотентность)
  const again = ctx.getWeekPlan(owner, '2026-08-10');
  assert.strictEqual(again.days.flatMap(d => d.cards).length, 2);
  assert.strictEqual(ctx.readAll_('Log').filter(l => l.action === 'week_copy').length, 1);

  // worker не имеет доступа
  assert.ok(!ctx.getWeekPlan(loginWorker(ctx), '2026-08-10').ok);
});

test('getWeekPlan: непустая неделя не копирует прошлую', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  ctx.addDeliveryVisit(owner, clientId, '2026-08-04');
  const w = ctx.addWeekCard(owner, clientId, '2026-08-12'); // занимаем текущую неделю
  assert.ok(w.ok);
  const res = ctx.getWeekPlan(owner, '2026-08-10');
  const cards = res.days.flatMap(d => d.cards);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].date, '2026-08-12');
});

test('moveWeekCard/removeWeekCard: только planned визиты', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const client2 = seedClient(ctx, { name: 'Ресторан Б' });
  const owner = loginOwner(ctx);
  const id = ctx.addWeekCard(owner, clientId, '2026-08-12').visit.id;

  const mv = ctx.moveWeekCard(owner, id, '2026-08-14');
  assert.ok(mv.ok);
  assert.strictEqual(mv.visit.date, '2026-08-14');
  assert.ok(!ctx.moveWeekCard(loginWorker(ctx), id, '2026-08-15').ok);

  // Не-planned не двигается и не удаляется
  const doneVisit = ctx.addDeliveryVisit(owner, client2, '2026-08-12').visit.id;
  const row = ctx.findById_('Deliveries', doneVisit);
  row.obj.status = 'delivered';
  ctx.updateRow_('Deliveries', row.rowNumber, row.obj);
  assert.ok(!ctx.moveWeekCard(owner, doneVisit, '2026-08-15').ok);
  assert.ok(!ctx.removeWeekCard(owner, doneVisit).ok);

  // planned удаляется и исчезает с доски
  assert.ok(ctx.removeWeekCard(owner, id).ok);
  const res = ctx.getWeekPlan(owner, '2026-08-10');
  assert.ok(!res.days.flatMap(d => d.cards).some(c => c.id === id));
});

test('нормализация: даты из ячеек Sheets как Date находятся днём и неделей', () => {
  const { ctx, ss } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  // Sheets хранит 'yyyy-MM-dd' как Date (полночь в TZ таблицы = 21:00 UTC накануне)
  const d = s => { const p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2]) - 3 * 3600 * 1000); };
  const dt = s => new Date(d(s.slice(0, 10)).getTime() + 9 * 3600 * 1000); // ~09:00 утра
  ss.getSheetByName('Washes').appendRow([
    'wash_d1', clientId, d(TOMORROW), d(TOMORROW), 'planned',
    '', '', '', 'owner', dt(TODAY), '', '', '', '', ''
  ]);
  const day = ctx.getDayList(owner, TOMORROW);
  assert.ok(day.washes.some(w => w.id === 'wash_d1'));
  // Визит развоза с датой как Date тоже находится неделей
  ss.getSheetByName('Deliveries').appendRow([
    'del_d1', d(TOMORROW), clientId, 1, 'planned', '', '', '', 'owner', dt(TODAY)
  ]);
  const week = ctx.getWeekPlan(owner, '2026-08-10');
  assert.ok(week.days.flatMap(x => x.cards).some(c => c.id === 'del_d1'));
  const del = ctx.getDeliveryPlan(owner, TOMORROW);
  assert.ok(del.planned.some(w => w.id === 'wash_d1'));
});

test('склад: dirty от водителя расходуется стиркой, clean — выдачей', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);

  // Водитель привёз грязное (запись создаём напрямую — API водителя будет в T18)
  ctx.addStorageEntry_(clientId, 'dirty', {});
  let sum = ctx.storageSummaryByClient_();
  assert.strictEqual(sum[clientId].dirty, 1);

  // Стирка забирает грязное со склада
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.startWash(worker, washId);
  sum = ctx.storageSummaryByClient_();
  assert.strictEqual(sum[clientId] ? sum[clientId].dirty : 0, 0);

  // Завершение кладёт чистое на склад
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 10 }], 8.25);
  sum = ctx.storageSummaryByClient_();
  assert.strictEqual(sum[clientId].clean, 1);
  assert.strictEqual(sum[clientId].cleanKg, 8.3);
  assert.strictEqual(sum[clientId].cleanItems, 10);

  // getStorage отдаёт и чистую запись
  const st = ctx.getStorage(owner);
  assert.ok(st.clean.some(s => s.wash_id === washId));

  // Выдача расходует чистое
  ctx.markIssued(owner, washId);
  sum = ctx.storageSummaryByClient_();
  assert.ok(!sum[clientId] || sum[clientId].clean === 0);
});

test('склад: правка стирки синхронно правит открытую clean-запись', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.startWash(worker, washId);
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 5 }], 5);
  ctx.editWashData(owner, washId, 7.5, [{ item_type_id: 'itm_1', qty: 8 }]);
  const sum = ctx.storageSummaryByClient_();
  assert.strictEqual(sum[clientId].cleanKg, 7.5);
  assert.strictEqual(sum[clientId].cleanItems, 8);
});

test('визиты развоза: добавить/перенести/убрать, дедуп, права', () => {
  const { ctx } = makeApiCtx();
  const clientId = seedClient(ctx);
  const client2 = seedClient(ctx, { name: 'Ресторан Б' });
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);

  // Только owner
  assert.ok(!ctx.addDeliveryVisit(worker, clientId, TOMORROW).ok);
  assert.ok(!ctx.getDeliveryVisits(worker, TOMORROW).ok);

  const v = ctx.addDeliveryVisit(owner, clientId, TOMORROW);
  assert.ok(v.ok);
  assert.strictEqual(v.visit.status, 'planned');
  assert.strictEqual(v.visit.ord, 1);

  // Дубль клиента на ту же дату отклоняется
  assert.ok(!ctx.addDeliveryVisit(owner, clientId, TOMORROW).ok);
  const v2 = ctx.addDeliveryVisit(owner, client2, TOMORROW);
  assert.strictEqual(v2.visit.ord, 2);

  // Список визитов со складскими флагами
  ctx.addStorageEntry_(clientId, 'dirty', {});
  const plan = ctx.getDeliveryVisits(owner, TOMORROW);
  assert.strictEqual(plan.visits.length, 2);
  const pv = plan.visits.find(x => x.client_id === clientId);
  assert.ok(pv.has_dirty && !pv.has_clean);

  // Перенос и удаление
  const mv = ctx.moveDeliveryVisit(owner, v.visit.id, '2026-08-14');
  assert.ok(mv.ok && mv.visit.date === '2026-08-14');
  assert.ok(!ctx.getDeliveryVisits(owner, TOMORROW).visits.some(x => x.id === v.visit.id));
  assert.ok(ctx.removeDeliveryVisit(owner, v2.visit.id).ok);
  assert.strictEqual(ctx.getDeliveryVisits(owner, TOMORROW).visits.length, 0);
  // Отменённый нельзя перенести
  assert.ok(!ctx.moveDeliveryVisit(owner, v2.visit.id, TODAY).ok);
});
