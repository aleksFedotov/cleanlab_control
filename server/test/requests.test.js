// Тесты заявок портала (тикет P1, этап 2): создание/перезапись, изоляция,
// права ролей, перевод в 'picked' при заборе водителем.
const test = require('node:test');
const assert = require('node:assert');
const {
  makeCtx, loginOwner, loginDriver, seedLaundry2, TODAY, TOMORROW
} = require('./helpers/serverMocks');

function seedClient(ctx, owner, name) {
  const res = ctx.api.saveClient(owner, { name: name || 'Отель А', type: 'отель' });
  assert.ok(res.ok);
  return res.client.id;
}

// Клиент + его токен портала (аккаунт через setClientAccess, как владелец).
function clientAccount(ctx, owner, clientId, login) {
  const r = ctx.api.setClientAccess(owner, clientId, login, 'portal-pass');
  assert.ok(r.ok, r.error);
  return ctx.auth.login(login, 'portal-pass').token;
}

test('clientCreateRequest: прошедшая дата отклоняется', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const token = clientAccount(ctx, owner, clientId, 'otel-past');

  const r = ctx.api.clientCreateRequest(token, '2020-01-10', 1, '', []);
  assert.ok(!r.ok);
  assert.match(r.error, /прошедшую дату/);
});

test('clientCreateRequest: создание, позиции сохранены, qty=0 не пишется', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const token = clientAccount(ctx, owner, clientId, 'otel-a');

  const r = ctx.api.clientCreateRequest(token, TOMORROW, 3, 'забрать до 12',
    [{ item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 0 }]);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.request.status, 'sent');
  assert.strictEqual(r.request.client_id, clientId);
  assert.strictEqual(r.request.bags, '3');
  assert.strictEqual(r.request.comment, 'забрать до 12');
  assert.strictEqual(r.request.items.length, 1); // qty=0 отфильтрован
  assert.strictEqual(Number(r.request.items[0].qty), 10);
  assert.strictEqual(r.request.items[0].item_type_id, 'itm_1');
  // Одна строка RequestItems в БД, id с префиксом ri_
  const rows = ctx.db.readAll_('RequestItems');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].id.startsWith('ri_'));
  assert.ok(r.request.id.startsWith('req_'));
});

test('повторная отправка на ту же дату — перезапись, а не дубль; другая дата — новая заявка', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const token = clientAccount(ctx, owner, clientId, 'otel-a');

  assert.ok(ctx.api.clientCreateRequest(token, TOMORROW, 2, '', [{ item_type_id: 'itm_1', qty: 5 }]).ok);
  const again = ctx.api.clientCreateRequest(token, TOMORROW, 4, 'передумали',
    [{ item_type_id: 'itm_2', qty: 7 }]);
  assert.ok(again.ok, again.error);
  assert.strictEqual(again.request.bags, '4');
  assert.strictEqual(again.request.comment, 'передумали');
  assert.strictEqual(again.request.items.length, 1);
  assert.strictEqual(again.request.items[0].item_type_id, 'itm_2');

  const other = ctx.api.clientCreateRequest(token, '2026-08-14', 1, '', []);
  assert.ok(other.ok, other.error);
  assert.notStrictEqual(other.request.id, again.request.id);

  // Всего две заявки (две даты), позиции старой перезаписаны
  const list = ctx.api.clientGetRequests(token);
  assert.strictEqual(list.requests.length, 2);
  const byDate = {};
  list.requests.forEach(function (r) { byDate[r.desired_date] = r; });
  assert.strictEqual(byDate[TOMORROW].items.length, 1);
  assert.strictEqual(byDate[TOMORROW].bags, '4');
  assert.strictEqual(byDate['2026-08-14'].items.length, 0);
  // Позиции первой отправки не осталось
  assert.strictEqual(ctx.db.readAll_('RequestItems')
    .filter(function (ri) { return ri.item_type_id === 'itm_1'; }).length, 0);
});

test('правка после picked (забор водителем) — отказ', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const token = clientAccount(ctx, owner, clientId, 'otel-a');

  const req = ctx.api.clientCreateRequest(token, TODAY, 2, '', []).request;
  const visit = ctx.api.addDeliveryVisit(owner, clientId, TODAY).visit;
  assert.ok(ctx.api.linkRequestToVisit(owner, req.id, visit.id).ok, 'link');

  // Водитель «Забрал грязное» → заявка picked
  const act = ctx.api.driverAction(driver, visit.id, 'pickup_dirty');
  assert.ok(act.ok, act.error);
  assert.strictEqual(ctx.api.clientGetRequest(token, req.id).request.status, 'picked');

  // Правка той же датой отклонена, позиции не меняются
  const edit = ctx.api.clientCreateRequest(token, TODAY, 9, 'хочу правку', [{ item_type_id: 'itm_1', qty: 3 }]);
  assert.strictEqual(edit.ok, false);
  assert.strictEqual(edit.error, 'Заявка уже в работе, правка недоступна');
  const after = ctx.api.clientGetRequest(token, req.id).request;
  assert.strictEqual(after.bags, '2');
  assert.strictEqual(after.items.length, 0);
});

test('чужая заявка не читается и не правится; tenant-изоляция прачек', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  seedLaundry2();
  const a = seedClient(ctx, owner, 'Отель А');
  const b = seedClient(ctx, owner, 'Отель Б');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');
  const tokenB = clientAccount(ctx, owner, b, 'otel-b');

  const reqA = ctx.api.clientCreateRequest(tokenA, TOMORROW, 1, '', []).request;
  // Клиент Б не видит и не правит заявку А
  assert.strictEqual(ctx.api.clientGetRequest(tokenB, reqA.id).error, 'Заявка не существует');
  const edit = ctx.api.clientCreateRequest(tokenB, TOMORROW, 5, '', []);
  assert.ok(edit.ok, edit.error); // у Б своя заявка на ту же дату — ок
  assert.notStrictEqual(edit.request.id, reqA.id);
  // Список А не содержит заявок Б
  assert.strictEqual(ctx.api.clientGetRequests(tokenA).requests.length, 1);

  // Владелец второй прачки не видит заявок первой
  const login2 = ctx.auth.login('boss', 'boss-pass'); // owner глобален, но активная прачка — '1'
  const mine = ctx.api.getClientRequests(login2.token);
  assert.strictEqual(mine.requests.length, 2);
  ctx.api.switchLaundry(login2.token, '2');
  const other = ctx.api.getClientRequests(login2.token);
  assert.strictEqual(other.requests.length, 0);
});

test('getClientRequests: фильтр по дате, sentCount, client_name', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const a = seedClient(ctx, owner, 'Отель А');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  assert.ok(ctx.api.clientCreateRequest(tokenA, TODAY, 1, '', []).ok);
  assert.ok(ctx.api.clientCreateRequest(tokenA, TOMORROW, 2, '', []).ok);

  const all = ctx.api.getClientRequests(owner);
  assert.strictEqual(all.requests.length, 2);
  assert.strictEqual(all.sentCount, 2);
  assert.strictEqual(all.requests[0].client_name, 'Отель А'); // сортировка по дате
  assert.strictEqual(all.requests[0].desired_date, TODAY);

  const todayOnly = ctx.api.getClientRequests(owner, TODAY);
  assert.strictEqual(todayOnly.requests.length, 1);
  assert.strictEqual(todayOnly.sentCount, 1);
});

test('linkRequestToVisit: тенант- и клиент-проверки, привязка idempotent', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const a = seedClient(ctx, owner, 'Отель А');
  const b = seedClient(ctx, owner, 'Отель Б');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  const req = ctx.api.clientCreateRequest(tokenA, TODAY, 1, '', []).request;
  const visitA = ctx.api.addDeliveryVisit(owner, a, TODAY).visit;
  const visitB = ctx.api.addDeliveryVisit(owner, b, TODAY).visit;

  assert.strictEqual(ctx.api.linkRequestToVisit(owner, req.id, visitB.id).error, 'Визит другого клиента');
  const bad = ctx.api.linkRequestToVisit(owner, req.id, 'del_missing');
  assert.strictEqual(bad.ok, false);

  const linked = ctx.api.linkRequestToVisit(owner, req.id, visitA.id);
  assert.ok(linked.ok, linked.error);
  assert.strictEqual(linked.request.visit_id, visitA.id);
  // Повторная привязка к другому визиту того же клиента — ок (смена визита)
  const relink = ctx.api.linkRequestToVisit(owner, req.id, visitA.id);
  assert.ok(relink.ok, relink.error);
});

test('водитель «Забрал грязное» переводит привязанную заявку в picked (только sent)', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const a = seedClient(ctx, owner, 'Отель А');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  const req = ctx.api.clientCreateRequest(tokenA, TODAY, 2, '', [{ item_type_id: 'itm_1', qty: 4 }]).request;
  const visit = ctx.api.addDeliveryVisit(owner, a, TODAY).visit;
  assert.ok(ctx.api.linkRequestToVisit(owner, req.id, visit.id).ok);

  const act = ctx.api.driverAction(driver, visit.id, 'pickup_dirty');
  assert.ok(act.ok, act.error);
  const after = ctx.api.clientGetRequest(tokenA, req.id).request;
  assert.strictEqual(after.status, 'picked');
  assert.strictEqual(after.items.length, 1); // позиции сохранились
  // sentCount у владельца обнулился
  assert.strictEqual(ctx.api.getClientRequests(owner).sentCount, 0);
});

test('матрица прав: owner/driver не создают заявки, client не видит чужие выборки', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const clientId = seedClient(ctx, owner);
  const token = clientAccount(ctx, owner, clientId, 'otel-a');

  assert.strictEqual(ctx.api.clientCreateRequest(owner, TODAY, 1, '', []).error, 'Нет доступа');
  assert.strictEqual(ctx.api.clientCreateRequest(driver, TODAY, 1, '', []).error, 'Нет доступа');
  assert.strictEqual(ctx.api.clientGetRequests(owner).error, 'Нет доступа');
  assert.strictEqual(ctx.api.linkRequestToVisit(token, 'req_x', 'del_x').error, 'Нет доступа');

  // Клиент не может грузить owner-выборки
  assert.strictEqual(ctx.api.getClientRequests(token).error, 'Нет доступа');
});

test('clientCreateRequest валидирует дату; события пишутся в Log', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const token = clientAccount(ctx, owner, clientId, 'otel-a');

  assert.strictEqual(ctx.api.clientCreateRequest(token, '', 1, '', []).error, 'Укажите дату забора');
  assert.strictEqual(ctx.api.clientCreateRequest(token, '13.08.2026', 1, '', []).error, 'Укажите дату забора');

  assert.ok(ctx.api.clientCreateRequest(token, TODAY, 1, '', []).ok);
  const created = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'request_create'; });
  assert.strictEqual(created.length, 1);
  assert.ok(ctx.api.clientCreateRequest(token, TODAY, 2, '', []).ok);
  const updated = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'request_update'; });
  assert.strictEqual(updated.length, 1);
});

test('clientGetPortalData: профиль, активные виды, ближайшие planned-визиты клиента', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const a = seedClient(ctx, owner, 'Отель А');
  const b = seedClient(ctx, owner, 'Отель Б');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  // Профиль клиента с ограниченным списком видов
  assert.ok(ctx.api.saveClient(owner, { id: a, item_types: ['itm_1', 'itm_2'] }).ok);
  // Визиты: сегодня и послезавтра у А; вчерашний (прошлое) и у Б — не попадают
  ctx.api.addDeliveryVisit(owner, a, TODAY);
  ctx.api.addDeliveryVisit(owner, a, '2026-08-14');
  ctx.api.addDeliveryVisit(owner, b, TOMORROW);
  const past = ctx.api.addDeliveryVisit(owner, a, '2026-08-10').visit;
  // Закрытый визит (финальный статус) не предлагаем
  ctx.api.driverAction(loginDriver(), past.id, 'empty');

  const r = ctx.api.clientGetPortalData(tokenA);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.client.id, a);
  assert.strictEqual(r.client.item_types, JSON.stringify(['itm_1', 'itm_2']));
  assert.ok(r.itemTypes.length > 0, 'виды белья есть');
  assert.ok(r.itemTypes.every(function (t) { return t.active === 'да'; }), 'только активные');
  // Только planned-визиты клиента А, с сегодняшнего дня, по возрастанию даты
  assert.deepStrictEqual(r.visits.map(function (v) { return v.date; }), [TODAY, '2026-08-14']);

  // Доступ только у client; другой клиент не видит визиты А
  const tokenB = clientAccount(ctx, owner, b, 'otel-b');
  const rb = ctx.api.clientGetPortalData(tokenB);
  assert.ok(rb.ok, rb.error);
  assert.deepStrictEqual(rb.visits.map(function (v) { return v.date; }), [TOMORROW]);
  assert.strictEqual(ctx.api.clientGetPortalData(owner).error, 'Нет доступа');
});

// --- Заявка в маршруте водителя / развозе владельца ---

test('getDriverRoute: привязанная заявка видна водителю (мешки, позиции с именами)', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const a = seedClient(ctx, owner, 'Отель А');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  const req = ctx.api.clientCreateRequest(tokenA, TODAY, 3, 'у ресепшна',
    [{ item_type_id: 'itm_1', qty: 10 }, { item_type_id: 'itm_2', qty: 20 }]).request;
  const visit = ctx.api.addDeliveryVisit(owner, a, TODAY).visit;
  assert.ok(ctx.api.linkRequestToVisit(owner, req.id, visit.id).ok);

  const route = ctx.api.getDriverRoute(driver, TODAY);
  assert.ok(route.ok, route.error);
  const v = route.visits.filter(function (x) { return x.id === visit.id; })[0];
  assert.ok(v.request, 'заявка подставлена');
  assert.strictEqual(v.request.id, req.id);
  assert.strictEqual(v.request.bags, 3);
  assert.strictEqual(v.request.comment, 'у ресепшна');
  assert.deepStrictEqual(v.request.items, [
    { item_type_id: 'itm_1', name: 'пододеяльник', qty: 10 },
    { item_type_id: 'itm_2', name: 'простыня', qty: 20 }
  ]);

  // Тот же блок — в развозе владельца
  const ownerVisits = ctx.api.getDeliveryVisits(owner, TODAY);
  const ov = ownerVisits.visits.filter(function (x) { return x.id === visit.id; })[0];
  assert.ok(ov.request && ov.request.id === req.id);
});

test('getDriverRoute: fallback — sent-заявка того же клиента на дату визита без привязки', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const a = seedClient(ctx, owner, 'Отель А');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  const req = ctx.api.clientCreateRequest(tokenA, TODAY, 2, '', []).request;
  const visit = ctx.api.addDeliveryVisit(owner, a, TODAY).visit; // визит создан вручную, заявка не привязана

  const route = ctx.api.getDriverRoute(driver, TODAY);
  const v = route.visits.filter(function (x) { return x.id === visit.id; })[0];
  assert.ok(v.request, 'заявка найдена по клиенту+дате');
  assert.strictEqual(v.request.id, req.id);
  assert.strictEqual(v.request.bags, 2);
});

test('getDriverRoute: просроченная sent-заявка видна на более позднем визите; будущая — нет', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const a = seedClient(ctx, owner, 'Отель А');
  const b = seedClient(ctx, owner, 'Отель Б');
  const tokenB = clientAccount(ctx, owner, b, 'otel-b');

  // У А заявка на вчера (забор не случился), визит — сегодня.
  // API прошедшую дату отклоняет, поэтому строка заявки — напрямую в БД.
  const yesterday = '2026-08-11'; // TODAY-1 при FIXED_NOW 2026-08-12
  ctx.db.appendRow_('Requests', {
    id: ctx.db.nextId_('Requests', 'req'), client_id: a, laundry_id: '1',
    visit_id: '', desired_date: yesterday, bags: '5', comment: 'не забрали',
    status: 'sent', created_by: 'test', created_at: yesterday + ' 08:00:00', updated_at: yesterday + ' 08:00:00'
  });
  const overdueId = ctx.db.readAll_('Requests')[0].id;
  ctx.db.appendRow_('RequestItems', {
    id: ctx.db.nextId_('RequestItems', 'ri'), request_id: overdueId, item_type_id: 'itm_1', qty: 7
  });
  // У Б заявка на завтра — на сегодняшний визит не подставляется
  ctx.api.clientCreateRequest(tokenB, TOMORROW, 1, '', []);

  const visitA = ctx.api.addDeliveryVisit(owner, a, TODAY).visit;
  const visitB = ctx.api.addDeliveryVisit(owner, b, TODAY).visit;

  const route = ctx.api.getDriverRoute(driver, TODAY);
  const vA = route.visits.filter(function (x) { return x.id === visitA.id; })[0];
  const vB = route.visits.filter(function (x) { return x.id === visitB.id; })[0];
  assert.ok(vA.request, 'просроченная заявка подставлена');
  assert.strictEqual(vA.request.id, overdueId);
  assert.strictEqual(vA.request.desired_date, yesterday);
  assert.strictEqual(vA.request.bags, 5);
  assert.deepStrictEqual(vA.request.items, [{ item_type_id: 'itm_1', name: 'пододеяльник', qty: 7 }]);
  assert.strictEqual(vB.request, null, 'будущая заявка не видна');
});

test('getDriverRoute: без заявки request=null; picked без привязки не подставляется', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const a = seedClient(ctx, owner, 'Отель А');
  const b = seedClient(ctx, owner, 'Отель Б');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  // Заявка клиента А на завтра — на сегодняшний визит не влияет
  ctx.api.clientCreateRequest(tokenA, TOMORROW, 1, '', []);
  const visitA = ctx.api.addDeliveryVisit(owner, a, TODAY).visit;
  const visitB = ctx.api.addDeliveryVisit(owner, b, TODAY).visit;

  const route = ctx.api.getDriverRoute(driver, TODAY);
  const vA = route.visits.filter(function (x) { return x.id === visitA.id; })[0];
  const vB = route.visits.filter(function (x) { return x.id === visitB.id; })[0];
  assert.strictEqual(vA.request, null);
  assert.strictEqual(vB.request, null);
});

test('getDayList: заявка клиента видна в карточке стирки; будущая не подтягивается', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const a = seedClient(ctx, owner, 'Отель А');
  const b = seedClient(ctx, owner, 'Отель Б');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');
  const tokenB = clientAccount(ctx, owner, b, 'otel-b');

  // Заявка А на сегодня; у Б — только на завтра (для сегодняшней стирки — будущая)
  ctx.api.clientCreateRequest(tokenA, TODAY, 2, '', [{ item_type_id: 'itm_1', qty: 10 }]);
  ctx.api.clientCreateRequest(tokenB, TOMORROW, 1, '', [{ item_type_id: 'itm_2', qty: 5 }]);
  // Стирки сегодняшнего дня материализуются из завтрашнего развоза
  ctx.api.addDeliveryVisit(owner, a, TOMORROW);
  ctx.api.addDeliveryVisit(owner, b, TOMORROW);

  const day = ctx.api.getDayList(owner, TODAY);
  const wA = day.washes.filter(function (w) { return w.client_id === a; })[0];
  const wB = day.washes.filter(function (w) { return w.client_id === b; })[0];
  assert.ok(wA.request, 'заявка А в карточке стирки');
  assert.strictEqual(wA.request.bags, 2);
  assert.deepStrictEqual(wA.request.items, [
    { item_type_id: 'itm_1', name: 'пододеяльник', qty: 10 }
  ]);
  assert.strictEqual(wB.request, null, 'будущая заявка не подтягивается');
});

test('getDayList: просроченная заявка подтягивается к более поздней стирке', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const a = seedClient(ctx, owner, 'Отель А');
  const tokenA = clientAccount(ctx, owner, a, 'otel-a');

  ctx.api.clientCreateRequest(tokenA, TODAY, 3, '', [{ item_type_id: 'itm_2', qty: 7 }]);
  // Стирка завтрашнего дня (развоз послезавтра): заявка «на сегодня» уже просрочена
  ctx.api.addDeliveryVisit(owner, a, '2026-08-14');

  const day = ctx.api.getDayList(owner, TOMORROW);
  const wA = day.washes.filter(function (w) { return w.client_id === a; })[0];
  assert.ok(wA.request, 'просроченная заявка видна в стирке');
  assert.strictEqual(wA.request.desired_date, TODAY);
  assert.strictEqual(wA.request.bags, 3);
});
