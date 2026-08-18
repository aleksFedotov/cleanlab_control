// Тесты server/api.js поверх SQLite — поведенческие грани из tests/api.test.js (GAS).
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, loginDriver, TODAY, TOMORROW } = require('./helpers/serverMocks');

function seedClient(ctx, over = {}) {
  const t = loginOwner();
  const res = ctx.api.saveClient(t, Object.assign({ name: 'Отель А', type: 'отель' }, over));
  assert.ok(res.ok);
  return res.client.id;
}

test('login: неверный PIN отклоняется, верный даёт токен и роль; logout отзывает', () => {
  const ctx = makeCtx();
  assert.ok(!ctx.auth.login('0000').ok);
  const owner = ctx.auth.login('1111');
  assert.strictEqual(owner.role, 'owner');
  assert.strictEqual(ctx.auth.login('2222').role, 'worker');
  assert.strictEqual(ctx.auth.login('3333').role, 'driver');
  // Водителя не пускают в API цеха
  assert.ok(!ctx.api.getDayList(ctx.auth.login('3333').token, TODAY).ok);
  // Чужой токен не пускает
  assert.ok(!ctx.api.getDayList('нет-такого', TODAY).ok);
  ctx.auth.logout(owner.token);
  assert.ok(!ctx.api.getDayList(owner.token, TODAY).ok);
});

test('права: worker не может owner-действия, owner может; отмена убирает из дня', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  assert.ok(!ctx.api.cancelWash(worker, washId).ok);
  assert.ok(!ctx.api.getDeliveryPlan(worker, TODAY).ok);
  assert.ok(!ctx.api.getStorage(worker).ok);
  assert.ok(!ctx.api.saveClient(worker, { name: 'X' }).ok);
  assert.ok(ctx.api.cancelWash(owner, washId).ok);
  const day = ctx.api.getDayList(worker, TODAY);
  assert.strictEqual(day.washes.length, 0);
});

test('полный цикл: постановка → в работу → завершение, идемпотентность', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  const started = ctx.api.startWash(worker, washId, 12.34);
  assert.ok(started.ok);
  assert.strictEqual(started.wash.dirty_weight_kg, 12.3); // округление до 0,1
  assert.strictEqual(started.wash.status, 'in_progress');
  assert.ok(!ctx.api.startWash(worker, washId, 99).ok);

  // Без веса чистого завершение отклоняется
  assert.ok(!ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 1 }]).ok);

  const done = ctx.api.completeWash(worker, washId, [
    { item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 0 }, { item_type_id: 'itm_3', qty: 5 }
  ], 11.5);
  assert.ok(done.ok);
  assert.strictEqual(done.wash.status, 'done');
  assert.strictEqual(done.wash.items_total, 15);
  assert.strictEqual(done.wash.dirty_weight_kg, 11.5);
  assert.strictEqual(ctx.db.readAll_('WashItems').length, 2);

  // Повторное завершение не дублирует WashItems
  assert.ok(!ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 1 }], 11.5).ok);
  assert.strictEqual(ctx.db.readAll_('WashItems').length, 2);

  // Результат стирки — чистое на складе
  const storage = ctx.api.getStorage(owner);
  assert.strictEqual(storage.clean.length, 1);
  assert.strictEqual(storage.clean[0].wash_id, washId);
});

test('клиент с учётом «только количество»: вес чистого необязателен', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx, { accounting: 'count' });
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(loginOwner(), clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  const done = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 3 }]);
  assert.ok(done.ok);
});

test('editWashData: пересчёт перезаписывает WashItems и clean-запись склада', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(loginOwner(), clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 10 }], 11.5, null, 2);

  const edited = ctx.api.editWashData(worker, washId, 12, [{ item_type_id: 'itm_2', qty: 4 }], 3);
  assert.ok(edited.ok);
  assert.strictEqual(edited.wash.items_total, 4);
  assert.strictEqual(edited.wash.bags, 3);
  const items = ctx.db.readAll_('WashItems');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].item_type_id, 'itm_2');
  // Clean-запись склада синхронно поправлена
  const st = ctx.db.readAll_('Storage').find(s => s.wash_id === washId);
  assert.strictEqual(st.weight_kg, '12');
  assert.strictEqual(st.items_total, '4');
});

test('deferWash: перенос со следом; cancel после переноса отклонён из in_progress? нет — defer из in_progress ок', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  const def = ctx.api.deferWash(owner, washId, '2026-08-14', 'нет места');
  assert.ok(def.ok);
  assert.strictEqual(def.wash.wash_date, '2026-08-14');
  assert.strictEqual(def.wash.deferred_from, TODAY);
  // В дне-источнике стирки больше нет
  assert.strictEqual(ctx.api.getDayList(owner, TODAY).washes.length, 0);
});

test('ensureWashesFromDelivery_: визит на завтра → плановая стирка сегодня, идемпотентно', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  assert.ok(ctx.api.addDeliveryVisit(owner, clientId, TOMORROW).ok);
  const day1 = ctx.api.getDayList(owner, TODAY);
  assert.strictEqual(day1.washes.length, 1);
  assert.strictEqual(day1.washes[0].created_by, 'auto');
  assert.strictEqual(day1.washes[0].issue_date, TOMORROW);
  // Повторное чтение не дублирует
  assert.strictEqual(ctx.api.getDayList(owner, TODAY).washes.length, 1);
  // Отмена стирки не приводит к пересозданию
  assert.ok(ctx.api.cancelWash(owner, day1.washes[0].id).ok);
  assert.strictEqual(ctx.api.getDayList(owner, TODAY).washes.length, 0);
});

test('addUnplannedWash: сегодня/завтра, дедуп открытой стирки клиента', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const worker = loginWorker();
  const w = ctx.api.addUnplannedWash(worker, clientId, 'срочно');
  assert.ok(w.ok);
  assert.strictEqual(w.wash.wash_date, TODAY);
  assert.strictEqual(w.wash.issue_date, TOMORROW);
  assert.strictEqual(w.wash.created_by, 'worker');
  assert.ok(!ctx.api.addUnplannedWash(worker, clientId).ok);
});

test('closeShift: блокируют незавершённые; после закрытия — дайджест и digest_sent', async () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  // Незавершённая стирка блокирует закрытие
  const blocked = await ctx.api.closeShift(worker);
  assert.ok(!blocked.ok);
  assert.ok(blocked.error.includes(washId));

  ctx.api.startWash(worker, washId);
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 10 }], 11.5);

  // OWNER_CHAT_ID не задан → дайджест не уходит, digest_sent остаётся пустым
  const closed = await ctx.api.closeShift(worker);
  assert.ok(closed.ok);
  assert.strictEqual(closed.shift.status, 'closed');
  assert.strictEqual(closed.shift.closed_at, '21:30');
  assert.strictEqual(closed.shift.washes_done, 1);
  assert.strictEqual(ctx.fetches.length, 0);

  // Повторное закрытие отклонено
  assert.ok(!(await ctx.api.closeShift(worker)).ok);
});

test('closeShift с OWNER_CHAT_ID: дайджест отправлен, digest_sent=да', async () => {
  const ctx = makeCtx();
  ctx.db.appendRow_('Settings', { key: 'OWNER_CHAT_ID', value: '998877' });
  ctx.db.invalidateRefCache_();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(owner, washId);
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 10 }], 11.5);

  const closed = await ctx.api.closeShift(owner);
  assert.ok(closed.ok);
  assert.strictEqual(ctx.fetches.length, 1);
  assert.strictEqual(ctx.fetches[0].payload.chat_id, '998877');
  assert.ok(ctx.fetches[0].payload.text.includes('Постирано: 11.5 кг (1 стирок)'));
  const shift = ctx.db.readAll_('Shifts').find(s => s.date === TODAY);
  assert.strictEqual(shift.digest_sent, 'да');
});

test('confirmStorageCheck: no_dirty → no_linen; has_dirty возвращает в planned и создаёт dirty-запись', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  const noDirty = ctx.api.confirmStorageCheck(worker, washId, 'no_dirty');
  assert.strictEqual(noDirty.wash.status, 'no_linen');
  assert.ok(noDirty.wash.done_at);
  // no_linen не блокирует смену и не мешает повторной проверке
  const back = ctx.api.confirmStorageCheck(worker, washId, 'has_dirty');
  assert.strictEqual(back.wash.status, 'planned');
  assert.strictEqual(back.wash.done_at, '');
  assert.strictEqual(ctx.db.readAll_('Storage').filter(s => s.kind === 'dirty').length, 1);
  // already_clean → ready_clean
  const washId2 = ctx.api.addToDelivery(owner, seedClient(ctx, { name: 'Спа Б' }), TODAY, TOMORROW).wash.id;
  assert.strictEqual(ctx.api.confirmStorageCheck(worker, washId2, 'already_clean').wash.status, 'ready_clean');
});

test('markIssued: выдача списывает clean-запись склада', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(owner, washId);
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 5 }], 8);
  const issued = ctx.api.markIssued(owner, washId);
  assert.ok(issued.ok);
  assert.strictEqual(issued.wash.status, 'issued');
  const st = ctx.db.readAll_('Storage').find(s => s.wash_id === washId);
  assert.ok(st.consumed_at);
  // Повторная выдача отклонена
  assert.ok(!ctx.api.markIssued(owner, washId).ok);
});

test('updateIssueDate: только у done/stored; меняет дату без смены статуса', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  assert.ok(!ctx.api.updateIssueDate(owner, washId, '2026-08-15').ok); // planned
  ctx.api.startWash(owner, washId);
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 5 }], 8);
  const upd = ctx.api.updateIssueDate(owner, washId, '2026-08-15');
  assert.ok(upd.ok);
  assert.strictEqual(upd.wash.issue_date, '2026-08-15');
  assert.strictEqual(upd.wash.status, 'done');
});

test('справочники: saveClient нормализует item_types/accounting; deleteClient архивирует; кэш сброшен', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const bad = ctx.api.saveClient(owner, { name: 'К', item_types: 'не-массив', accounting: 'странное' });
  assert.ok(bad.ok);
  assert.strictEqual(bad.client.item_types, '');
  assert.strictEqual(bad.client.accounting, '');
  const good = ctx.api.saveClient(owner, { name: 'К2', item_types: ['itm_1'], accounting: 'weight' });
  assert.strictEqual(good.client.item_types, '["itm_1"]');
  assert.strictEqual(good.client.accounting, 'weight');
  const del = ctx.api.deleteClient(owner, good.client.id);
  assert.strictEqual(del.client.active, 'нет');
  // Кэш инвалидирован: getRefs видит изменения
  const refs = ctx.api.getRefs(owner);
  assert.strictEqual(refs.clients.find(c => c.id === good.client.id).active, 'нет');
});

test('saveItemType: создавать может worker, переименовывать — только owner', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const created = ctx.api.saveItemType(worker, { name: 'новый вид' });
  assert.ok(created.ok);
  assert.ok(!ctx.api.saveItemType(worker, { id: created.itemType.id, name: 'переимен' }).ok);
  assert.ok(ctx.api.saveItemType(owner, { id: created.itemType.id, name: 'переимен' }).ok);
});

test('rememberClientItemType: добавляет тип в список клиента без дублей', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx, { item_types: ['itm_1'] });
  const worker = loginWorker();
  assert.ok(ctx.api.rememberClientItemType(worker, clientId, 'itm_2').ok);
  assert.ok(ctx.api.rememberClientItemType(worker, clientId, 'itm_2').ok);
  const c = ctx.db.findById_('Clients', clientId).obj;
  assert.deepStrictEqual(JSON.parse(c.item_types), ['itm_1', 'itm_2']);
});

test('getWeekPlan: пустая неделя материализуется копией прошлой', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  // Прошлая неделя: понедельник 2026-08-03
  assert.ok(ctx.api.addDeliveryVisit(owner, clientId, '2026-08-03').ok);
  const week = ctx.api.getWeekPlan(owner, '2026-08-10');
  assert.ok(week.ok);
  assert.strictEqual(week.monday, '2026-08-10');
  const mondayCards = week.days[0].cards;
  assert.strictEqual(mondayCards.length, 1);
  assert.strictEqual(mondayCards[0].date, '2026-08-10');
  assert.strictEqual(mondayCards[0].client_name, 'Отель А');
  // Повторный вызов не дублирует
  assert.strictEqual(ctx.api.getWeekPlan(owner, '2026-08-10').days[0].cards.length, 1);
});

test('getTvData: по ключу, только агрегаты дня', () => {
  const ctx = makeCtx();
  assert.ok(!ctx.api.getTvData('неверный').ok);
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW);
  const tv = ctx.api.getTvData('tv-secret');
  assert.ok(tv.ok);
  assert.strictEqual(tv.date, TODAY);
  assert.strictEqual(tv.counters.total, 1);
  assert.strictEqual(tv.counters.planned, 1);
  assert.strictEqual(tv.updatedAt, '21:30');
});
