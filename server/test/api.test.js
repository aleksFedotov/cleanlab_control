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

test('login: неверный пароль отклоняется, верный даёт токен и роль; logout отзывает', () => {
  const ctx = makeCtx();
  assert.ok(!ctx.auth.login('boss', 'не-то').ok);
  assert.ok(!ctx.auth.login('нет-такого', 'boss-pass').ok);
  const owner = ctx.auth.login('boss', 'boss-pass');
  assert.strictEqual(owner.role, 'owner');
  assert.ok(Array.isArray(owner.laundries)); // владельцу — список прачек
  assert.strictEqual(ctx.auth.login('worker1', 'worker-pass').role, 'worker');
  assert.strictEqual(ctx.auth.login('driver1', 'driver-pass').role, 'driver');
  // Водителя не пускают в API цеха
  assert.ok(!ctx.api.getDayList(ctx.auth.login('driver1', 'driver-pass').token, TODAY).ok);
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

test('deleteWash: удаляет стирку совсем; выданную и чужими ролями — нельзя', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  // worker не может удалять
  assert.ok(!ctx.api.deleteWash(worker, washId).ok);
  // owner удаляет: из отчёта стирка исчезает совсем (в отличие от отмены)
  assert.ok(ctx.api.deleteWash(owner, washId).ok);
  const rep = ctx.api.getDayReport(owner, TODAY);
  assert.strictEqual(rep.washes.length, 0);
  // повторное удаление — «не найдена»
  assert.ok(!ctx.api.deleteWash(owner, washId).ok);

  // завершённую удалить можно: заодно уходят позиции и clean-запись склада
  const w2 = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, w2, 10);
  ctx.api.completeWash(worker, w2, [{ item_type_id: 'itm_1', qty: 2 }], 10, null, 1);
  assert.strictEqual(ctx.api.getStorage(owner).clean.length, 1);
  assert.ok(ctx.api.deleteWash(owner, w2).ok);
  assert.strictEqual(ctx.api.getStorage(owner).clean.length, 0);
  assert.strictEqual(ctx.db.readAll_('WashItems').length, 0);

  // выданную клиенту — нельзя
  const w3 = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, w3, 5);
  ctx.api.completeWash(worker, w3, [], 5, null, 1);
  assert.ok(ctx.api.markIssued(owner, w3).ok);
  const del = ctx.api.deleteWash(owner, w3);
  assert.ok(!del.ok);
  assert.ok(/Выданную/.test(del.error));
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

  // Без мешков завершение отклоняется (даже с весом)
  const noBags = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 1 }], 11.5);
  assert.ok(!noBags.ok);
  assert.ok(/мешков/.test(noBags.error));

  const done = ctx.api.completeWash(worker, washId, [
    { item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 0 }, { item_type_id: 'itm_3', qty: 5 }
  ], 11.5, null, 2);
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
  const done = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 3 }], null, null, 1);
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

test('deferWash из partial: стирка → planned на новую дату, issue_date = newDate+1, визит развоза едет следом', () => {
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
  assert.strictEqual(def.wash.status, 'planned');
  assert.strictEqual(def.wash.wash_date, '2026-08-14');
  assert.strictEqual(def.wash.issue_date, '2026-08-15');
  assert.strictEqual(def.wash.deferred_from, TODAY);
  // Постиранная часть сохранена: вес/позиции/мешки не затираются
  assert.strictEqual(Number(def.wash.dirty_weight_kg), 6.5);
  assert.strictEqual(Number(def.wash.items_total), 4);
  // Визит развоза переехал: завтра → послезавтра
  const v = ctx.db.findById_('Deliveries', visit.id).obj;
  assert.strictEqual(v.date, '2026-08-15');
  assert.strictEqual(v.status, 'planned');
  // Остаток грязного снова «на складе»: карточка не показывает «Нет белья»
  const dirty = ctx.db.readAll_('Storage').filter(function (s) {
    return s.client_id === clientId && s.kind === 'dirty' && !s.consumed_at;
  });
  assert.strictEqual(dirty.length, 1);
});

test('deferWash из partial: визит в финальном статусе не двигается, стирка переносится', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  const visit = ctx.api.addDeliveryVisit(owner, clientId, TOMORROW).visit;
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }], 6.5, 'partial', 1);
  // Чистая часть уехала клиенту: визит → delivered
  assert.ok(ctx.api.driverAction(driver, visit.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, visit.id, 'deliver_clean').ok);

  const def = ctx.api.deferWash(owner, washId, '2026-08-14', 'достирать остаток');
  assert.ok(def.ok);
  assert.strictEqual(def.wash.status, 'planned');
  assert.strictEqual(ctx.db.findById_('Deliveries', visit.id).obj.date, TOMORROW);
});

test('остаток частичной стирки: getDayList показывает постиранную часть, достирка суммирует итоги', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  const part = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }], 6.5, 'partial', 1);
  assert.ok(part.ok);

  // Переносим остаток на завтра
  assert.ok(ctx.api.deferWash(owner, washId, '2026-08-14', 'не достирали').ok);
  const day = ctx.api.getDayList(worker, '2026-08-14');
  assert.strictEqual(day.washes.length, 1);
  const w = day.washes[0];
  assert.strictEqual(w.status, 'planned');
  assert.strictEqual(w.partial_rest, true);
  assert.strictEqual(Number(w.prev_kg), 6.5);
  assert.strictEqual(Number(w.prev_bags), 1);
  assert.deepStrictEqual(
    w.prev_items.map(function (x) { return { item_type_id: x.item_type_id, qty: x.qty }; }),
    [{ item_type_id: 'itm_1', qty: 4 }]
  );
  // Обычная стирка без WashItems флага не получает
  const wash2 = ctx.api.addToDelivery(owner, seedClient(ctx, { name: 'Отель Б' }), '2026-08-14', '2026-08-15').wash.id;
  const day2 = ctx.api.getDayList(worker, '2026-08-14');
  assert.ok(!day2.washes.find(function (x) { return x.id === wash2; }).partial_rest);

  // Достирка: итоги суммируются с первой частью
  assert.ok(ctx.api.startWash(worker, washId).ok);
  const done = ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_2', qty: 3 }], 2.04, null, 2);
  assert.ok(done.ok);
  assert.strictEqual(Number(done.wash.items_total), 7);
  assert.strictEqual(Number(done.wash.bags), 3);
  assert.strictEqual(Number(done.wash.dirty_weight_kg), 8.5); // 6.5 + 2.04 → round1
  // WashItems обеих частей на месте
  const items = ctx.db.readAll_('WashItems').filter(function (wi) { return wi.wash_id === washId; });
  assert.strictEqual(items.length, 2);
  // Две открытые clean-записи склада (по заходу на стирку)
  const clean = ctx.db.readAll_('Storage').filter(function (s) {
    return s.client_id === clientId && s.kind === 'clean' && !s.consumed_at;
  });
  assert.strictEqual(clean.length, 2);
});

test('holdPartialWash: решение «оставить на складе» запоминается; перенесённый остаток виден на складе', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, washId);
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 4 }], 6.5, 'partial', 1);

  // Частичная видна на складе, решение ещё не принято
  let st = ctx.api.getStorage(owner);
  assert.strictEqual(st.partialClean.length, 1);
  assert.strictEqual(st.partialClean[0].wash_hold, 0);

  // Работник не может принять решение за владельца
  assert.ok(!ctx.api.holdPartialWash(worker, washId).ok);

  // Владелец: «оставить на складе» → hold, статус остаётся partial
  const hold = ctx.api.holdPartialWash(owner, washId);
  assert.ok(hold.ok);
  assert.strictEqual(hold.wash.status, 'partial');
  assert.strictEqual(hold.wash.deferred_reason, 'hold');
  st = ctx.api.getStorage(owner);
  assert.strictEqual(st.partialClean[0].wash_hold, 1);

  // Отдельный сценарий: после переноса остатка clean-запись НЕ пропадает со склада
  const client2 = seedClient(ctx, { name: 'Отель Б' });
  const wash2 = ctx.api.addToDelivery(owner, client2, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, wash2);
  ctx.api.completeWash(worker, wash2, [{ item_type_id: 'itm_1', qty: 2 }], 3, 'partial', 1);
  assert.ok(ctx.api.deferWash(owner, wash2, '2026-08-14', 'не достирали').ok);
  st = ctx.api.getStorage(owner);
  const rest = st.partialClean.find(function (s) { return s.wash_id === wash2; });
  assert.ok(rest, 'clean-запись перенесённой частичной стирки должна оставаться на складе');
  assert.strictEqual(rest.wash_status, 'planned');
});

test('deferWash: из done/stored по-прежнему запрещён', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(owner, washId);
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 2 }], 5, null, 1);
  const res = ctx.api.deferWash(owner, washId, '2026-08-14', 'поздно');
  assert.ok(!res.ok);
  assert.strictEqual(res.error, 'Нельзя defer из статуса done');
});

test('notReady: обслуженные точки (выдано/чистое у водителя) не попадают в предупреждение', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const worker = loginWorker();
  const driver = loginDriver();
  // Клиент 1: чистое выдано — визит закрыт
  const c1 = seedClient(ctx);
  const v1 = ctx.api.addDeliveryVisit(owner, c1, TOMORROW).visit;
  const w1 = ctx.api.addToDelivery(owner, c1, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, w1);
  ctx.api.completeWash(worker, w1, [{ item_type_id: 'itm_1', qty: 2 }], 5, null, 1);
  assert.ok(ctx.api.driverAction(driver, v1.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(driver, v1.id, 'deliver_clean').ok);
  // Клиент 2: чистое у водителя, визит ещё открыт
  const c2 = seedClient(ctx);
  const v2 = ctx.api.addDeliveryVisit(owner, c2, TOMORROW).visit;
  const w2 = ctx.api.addToDelivery(owner, c2, TODAY, TOMORROW).wash.id;
  ctx.api.startWash(worker, w2);
  ctx.api.completeWash(worker, w2, [{ item_type_id: 'itm_1', qty: 2 }], 5, null, 1);
  assert.ok(ctx.api.driverAction(driver, v2.id, 'take_clean').ok);
  // Клиент 3: чистого нет вообще — должен остаться в предупреждении
  const c3 = seedClient(ctx);
  ctx.api.addDeliveryVisit(owner, c3, TOMORROW);

  const notReady = ctx.api.getDeliveryVisits(owner, TOMORROW).notReady;
  const ids = notReady.map(function (n) { return n.client_id; });
  assert.ok(ids.indexOf(c1) === -1, 'выданный клиент не «не готов»');
  assert.ok(ids.indexOf(c2) === -1, 'чистое у водителя — не «не готов»');
  assert.ok(ids.indexOf(c3) !== -1, 'без чистого — «не готов»');
});

test('setPickupOnly: подтверждённая точка «только забрать грязное» исчезает из notReady, отмена возвращает', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  const visit = ctx.api.addDeliveryVisit(owner, clientId, TOMORROW).visit;

  // Без чистого белья точка «не готова»
  let notReady = ctx.api.getDeliveryVisits(owner, TOMORROW).notReady;
  assert.ok(notReady.some(function (n) { return n.client_id === clientId; }));

  // Подтверждение владельца — предупреждение пропадает
  const set = ctx.api.setPickupOnly(owner, visit.id, true);
  assert.ok(set.ok);
  assert.strictEqual(set.visit.pickup_only, 'да');
  notReady = ctx.api.getDeliveryVisits(owner, TOMORROW).notReady;
  assert.ok(!notReady.some(function (n) { return n.client_id === clientId; }));

  // Снятие пометки — точка снова проверяется по обычным правилам
  const unset = ctx.api.setPickupOnly(owner, visit.id, false);
  assert.ok(unset.ok);
  assert.strictEqual(unset.visit.pickup_only, '');
  notReady = ctx.api.getDeliveryVisits(owner, TOMORROW).notReady;
  assert.ok(notReady.some(function (n) { return n.client_id === clientId; }));
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
  ctx.api.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 10 }], 11.5, null, 1);

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
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 10 }], 11.5, null, 1);

  const closed = await ctx.api.closeShift(owner);
  assert.ok(closed.ok);
  assert.strictEqual(ctx.fetches.length, 1);
  assert.strictEqual(ctx.fetches[0].payload.chat_id, '998877');
  assert.ok(ctx.fetches[0].payload.text.includes('Постирано: 11.5 кг (1 стирок)'));
  const shift = ctx.db.readAll_('Shifts').find(s => s.date === TODAY);
  assert.strictEqual(shift.digest_sent, 'да');
});

test('closeShift с force: закрывает при незавершённых и предупреждает владельца', async () => {
  const ctx = makeCtx();
  ctx.db.appendRow_('Settings', { key: 'OWNER_CHAT_ID', value: '998877' });
  ctx.db.invalidateRefCache_();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  const worker = loginWorker();
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;

  // Без подтверждения — блок
  assert.ok(!(await ctx.api.closeShift(worker)).ok);

  // С подтверждением — смена закрыта, владельцу ушло предупреждение
  const closed = await ctx.api.closeShift(worker, true);
  assert.ok(closed.ok);
  assert.strictEqual(closed.shift.status, 'closed');
  const warn = ctx.fetches.find(f => f.payload.text.includes('закрыта с незавершёнными'));
  assert.ok(warn, 'предупреждение владельцу отправлено');
  assert.ok(warn.payload.text.includes('не начата'));
  assert.ok(warn.payload.text.includes('только владелец'));
  // В логе зафиксированы незавершённые
  const ev = ctx.db.readAll_('Log').find(e => e.action === 'shift_close');
  assert.ok(ev.details.includes(washId));
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
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 5 }], 8, null, 1);
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
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 5 }], 8, null, 1);
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

test('экраны дня материализуют стирки из завтрашнего развоза (раньше — только getDayList)', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();
  // План развоза на завтра есть, экран «Стирка» никто не открывал
  assert.ok(ctx.api.addDeliveryVisit(owner, clientId, TOMORROW).ok);
  // Отчёт за день сам создаёт плановую стирку
  const rep = ctx.api.getDayReport(owner, TODAY);
  assert.ok(rep.ok);
  assert.strictEqual(rep.washes.length, 1);
  assert.strictEqual(rep.washes[0].status, 'planned');

  // То же — через состояние закрытия смены (второй клиент)
  const clientId2 = seedClient(ctx, { name: 'Отель Б' });
  assert.ok(ctx.api.addDeliveryVisit(owner, clientId2, TOMORROW).ok);
  const close = ctx.api.getShiftCloseState(loginOwner());
  assert.ok(close.ok);
  assert.strictEqual(close.blockers.length, 2); // обе стирки дня теперь существуют и открыты
});

test('materializeTodayAllLaundries_: копия недели завтрашнего дня + стирки для всех активных прачек', () => {
  const ctx = makeCtx();
  const { seedLaundry2 } = require('./helpers/serverMocks');
  seedLaundry2();
  const owner = loginOwner();
  const c1 = seedClient(ctx);
  // Прачка 1: визит на завтра → стирка сегодня. Копия недели здесь НЕ сработает:
  // неделя завтрашнего дня (2026-08-10..16) уже не пуста из-за этого визита.
  assert.ok(ctx.api.addDeliveryVisit(owner, c1, TOMORROW).ok);
  // Прачка 2: только визит на прошлой неделе (2026-08-03..09) → копия на неделю завтра
  const owner2 = ctx.api.switchLaundry(owner, '2');
  assert.ok(owner2.ok);
  const c2 = ctx.api.saveClient(owner, { name: 'Отель В', type: 'отель' }).client.id;
  assert.ok(ctx.api.addDeliveryVisit(owner, c2, '2026-08-05').ok);

  ctx.api.materializeTodayAllLaundries_();

  // Стирка сегодня создана в прачке 1; в прачке 2 завтра развоза нет — стирок нет
  const w1 = ctx.db.findRowsByTenant_('Washes', w => w.wash_date === TODAY, 100, '1');
  const w2 = ctx.db.findRowsByTenant_('Washes', w => w.wash_date === TODAY, 100, '2');
  assert.strictEqual(w1.length, 1);
  assert.strictEqual(w2.length, 0);
  // Неделя завтрашнего дня (2026-08-10..16) скопирована с прошлой для прачки 2
  const copied = ctx.db.findRowsByTenant_('Deliveries', v => v.date === '2026-08-12', 100, '2');
  assert.ok(copied.some(r => r.obj.client_id === c2));
  // Идемпотентно: повторный запуск ничего не дублирует
  ctx.api.materializeTodayAllLaundries_();
  assert.strictEqual(ctx.db.findRowsByTenant_('Washes', w => w.wash_date === TODAY, 100, '1').length, 1);
  assert.strictEqual(ctx.db.findRowsByTenant_('Deliveries', v => v.date === '2026-08-12', 100, '2').length, 1);
});

test('getWeekPlan: частично заполненная неделя дополняется слиянием, правки владельца не затираются', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const a = seedClient(ctx);
  const b = seedClient(ctx, { name: 'Отель Б' });
  const c = seedClient(ctx, { name: 'Отель В' });
  // Прошлая неделя: A и B в понедельник 2026-08-03, C во вторник 2026-08-04
  assert.ok(ctx.api.addDeliveryVisit(owner, a, '2026-08-03').ok);
  assert.ok(ctx.api.addDeliveryVisit(owner, b, '2026-08-03').ok);
  assert.ok(ctx.api.addDeliveryVisit(owner, c, '2026-08-04').ok);
  // Эта неделя частично заполнена: A уже есть на 08-10, C на 08-11 отменён владельцем.
  // Старое правило «копировать, только если неделя пуста» здесь молча ничего не делало.
  assert.ok(ctx.api.addDeliveryVisit(owner, a, '2026-08-10').ok);
  const cancelledId = ctx.api.addDeliveryVisit(owner, c, '2026-08-11').visit.id;
  assert.ok(ctx.api.removeDeliveryVisit(owner, cancelledId).ok);

  const week = ctx.api.getWeekPlan(owner, '2026-08-10');
  assert.ok(week.ok);
  const mon = week.days[0].cards.map(x => x.client_id).sort();
  const tue = week.days[1].cards.map(x => x.client_id);
  // A не задублировался, B докопировался из прошлой недели
  assert.deepStrictEqual(mon, [a, b].sort());
  // Отменённый владельцем C не воскрес
  assert.deepStrictEqual(tue, []);
  // Повторный вызов ничего не меняет (маркер week_copy в Log)
  const again = ctx.api.getWeekPlan(owner, '2026-08-10');
  assert.strictEqual(again.days[0].cards.length, 2);
  assert.strictEqual(again.days[1].cards.length, 0);
});
