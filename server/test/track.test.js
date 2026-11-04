// Тесты трекинга сдачи (тикет P1, этап 4): маппинг внутренних состояний в
// клиентские статусы (таблично, чистая функция), clientGetTrack: шаги с датами,
// факт только после завершения, особые случаи no_linen/partial/deferred/cancelled,
// tenant-изоляция.
const test = require('node:test');
const assert = require('node:assert');
const {
  makeCtx, loginOwner, loginDriver, TODAY, TOMORROW
} = require('./helpers/serverMocks');
const { clientStatus_ } = require('../api/requests');

// --- Табличный прогон чистого маппинга ---

// Минимальные корректные объекты; кейс = патч поверх них.
const BASE_REQ = { id: 'req_1', client_id: 'cli_1', created_at: TODAY + ' 08:00:00' };
const PLANNED_VISIT = { id: 'del_1', date: TODAY, status: 'planned', picked_at: '', clean_taken_at: '', delivered_at: '' };

function statusOf(patch) {
  const input = Object.assign({ request: BASE_REQ, visit: null, wash: null, dirtyAt: '', today: TODAY }, patch);
  return clientStatus_(input);
}

test('clientStatus_: табличный прогон по внутренним состояниям', () => {
  // Без визита — трек не уходит дальше «Заявка принята» (двойной канал)
  assert.strictEqual(statusOf({}).key, 'accepted');
  // Визит planned не сегодня — водитель ещё не выехал
  assert.strictEqual(statusOf({ visit: Object.assign({}, PLANNED_VISIT, { date: TOMORROW }) }).key, 'accepted');
  // Визит planned сегодня — «Водитель направляется»
  assert.strictEqual(statusOf({ visit: PLANNED_VISIT }).key, 'driver_coming');
  // Забор подтверждён — «На пути в прачечную»
  assert.strictEqual(statusOf({ visit: Object.assign({}, PLANNED_VISIT, { picked_at: TODAY + ' 10:00:00' }) }).key, 'to_laundry');
  // Грязное на складе прачки, стирка не заведена — «В прачечной, в очереди»
  assert.strictEqual(statusOf({ visit: PLANNED_VISIT, dirtyAt: TODAY + ' 11:00:00' }).key, 'in_queue');

  const W = { status: 'planned', created_at: TODAY + ' 11:30:00', started_at: '', done_at: '', issued_at: '', deferred_from: '', issue_date: '' };
  assert.strictEqual(statusOf({ visit: PLANNED_VISIT, wash: W }).key, 'in_queue');
  assert.strictEqual(statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { status: 'in_progress', started_at: TODAY + ' 12:00:00' }) }).key, 'washing');
  // partial — «Стирается (частично)», даже если первая часть завершена
  const partial = statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { status: 'partial', started_at: TODAY + ' 12:00:00', done_at: TODAY + ' 13:00:00' }) });
  assert.strictEqual(partial.key, 'washing');
  assert.strictEqual(partial.label, 'Стирается (частично)');
  ['done', 'stored', 'ready_clean'].forEach(function (st) {
    assert.strictEqual(statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { status: st, done_at: TODAY + ' 13:00:00' }) }).key, 'ready', st);
  });
  // Чистое у водителя — «Направляется к вам» (даже если стирка ещё не done — защитный приоритет)
  assert.strictEqual(statusOf({ visit: Object.assign({}, PLANNED_VISIT, { picked_at: TODAY + ' 10:00:00' }), deliveryVisit: { date: TOMORROW, status: 'planned', clean_taken_at: TODAY + ' 14:00:00' }, wash: W }).key, 'to_client');
  // Визит закрыт с выдачей — «Доставлено»
  assert.strictEqual(statusOf({ visit: Object.assign({}, PLANNED_VISIT, { picked_at: TODAY + ' 10:00:00', status: 'picked' }), deliveryVisit: { date: TOMORROW, status: 'delivered', delivered_at: TODAY + ' 15:00:00' }, wash: Object.assign({}, W, { status: 'done' }) }).key, 'delivered');
  // Визит «только забрал грязное» + стирка готова — ещё НЕ «Доставлено»
  assert.strictEqual(statusOf({ visit: Object.assign({}, PLANNED_VISIT, { status: 'picked', picked_at: TODAY + ' 10:00:00' }), wash: Object.assign({}, W, { status: 'done' }) }).key, 'ready');
  // Стирка выдана (команда «Стирки») — «Доставлено» даже без закрытия визита
  assert.strictEqual(statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { status: 'issued', issued_at: TODAY + ' 15:00:00' }) }).key, 'delivered');

  // Особые случаи
  assert.strictEqual(statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { status: 'no_linen' }) }).key, 'no_linen');
  assert.strictEqual(statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { status: 'no_linen' }) }).label, 'Бельё не передано');
  const cancelled = statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { status: 'cancelled', comment: 'бельё забрали другим рейсом' }) });
  assert.strictEqual(cancelled.key, 'cancelled');
  assert.strictEqual(cancelled.label, 'Сдача отменена');
  assert.strictEqual(cancelled.note, 'бельё забрали другим рейсом');
  // Перенос: к статусу добавляется пометка с новой датой
  const deferred = statusOf({ visit: PLANNED_VISIT, wash: Object.assign({}, W, { deferred_from: TODAY, issue_date: '2026-08-15' }) });
  assert.strictEqual(deferred.key, 'in_queue');
  assert.strictEqual(deferred.note, 'перенесено на 2026-08-15');
  // «Бельё не передано» и «Сдача отменена» не из 8 шагов (step = −1)
  assert.strictEqual(statusOf({ wash: Object.assign({}, W, { status: 'no_linen' }) }).step, -1);
  assert.strictEqual(statusOf({ wash: Object.assign({}, W, { status: 'cancelled' }) }).step, -1);
});

// --- clientGetTrack: интеграция ---

function seedClientWithAccess(ctx) {
  const owner = loginOwner();
  const res = ctx.api.saveClient(owner, { name: 'Отель Трек', type: 'отель' });
  assert.ok(res.ok);
  const clientId = res.client.id;
  assert.ok(ctx.api.setClientAccess(owner, clientId, 'track-hotel', 'portal-pass').ok);
  const token = ctx.auth.login('track-hotel', 'portal-pass').token;
  return { owner: owner, clientId: clientId, token: token };
}

test('clientGetTrack: от «Заявка принята» до «Готово» — шаги с датами, факт после завершения', () => {
  const ctx = makeCtx();
  const driver = loginDriver();
  const s = seedClientWithAccess(ctx);

  const req = ctx.api.clientCreateRequest(s.token, 2, '', [{ item_type_id: 'itm_1', qty: 12 }]).request;
  const visit = ctx.api.addDeliveryVisit(s.owner, s.clientId, TODAY).visit;
  assert.ok(ctx.api.linkRequestToVisit(s.owner, req.id, visit.id).ok);

  // Сразу после привязки: «Водитель направляется» (визит planned сегодня)
  const t0 = ctx.api.clientGetTrack(s.token, req.id);
  assert.ok(t0.ok, t0.error);
  assert.strictEqual(t0.status.key, 'driver_coming');
  assert.strictEqual(t0.fact, null, 'факта до стирки нет');
  const stepKeys = t0.steps.map(function (x) { return x.key; });
  assert.deepStrictEqual(stepKeys, ['accepted', 'driver_coming', 'to_laundry', 'in_queue', 'washing', 'ready', 'to_client', 'delivered']);
  const accepted = t0.steps[0];
  assert.strictEqual(accepted.done, true);
  assert.strictEqual(accepted.current, false);
  assert.strictEqual(t0.steps[1].current, true);

  // Водитель подтвердил забор → «На пути в прачечную»
  assert.ok(ctx.api.driverAction(driver, visit.id, 'pickup_dirty').ok);
  const t1 = ctx.api.clientGetTrack(s.token, req.id);
  assert.strictEqual(t1.status.key, 'to_laundry');
  assert.ok(t1.steps[2].at.includes(TODAY), 'picked_at в шаге');
  assert.strictEqual(t1.steps[2].current, true);
  assert.strictEqual(t1.steps[0].done, true);
  assert.strictEqual(t1.steps[1].done, true);

  // Стирка дня создана (ensureWashesFromDelivery_ при чтении вчерашнего дня)
  assert.ok(ctx.api.getDayList(s.owner, '2026-08-11').ok);
  const wash = ctx.db.findRowsByTenant_('Washes', function (w) {
    return w.client_id === s.clientId;
  }, 10, '1')[0];
  assert.ok(wash, 'стирка auto-создана');
  assert.strictEqual(ctx.api.clientGetTrack(s.token, req.id).status.key, 'in_queue');

  // Стирается → готово; факт — только после completeWash
  assert.ok(ctx.api.startWash(s.owner, wash.obj.id, 20).ok);
  assert.strictEqual(ctx.api.clientGetTrack(s.token, req.id).status.key, 'washing');
  const done = ctx.api.completeWash(s.owner, wash.obj.id, [{ item_type_id: 'itm_1', qty: 12 }], 18.5, '', 3);
  assert.ok(done.ok, done.error);
  const t2 = ctx.api.clientGetTrack(s.token, req.id);
  assert.strictEqual(t2.status.key, 'ready');
  assert.ok(t2.fact, 'факт появился');
  assert.strictEqual(t2.fact.weight_kg, 18.5);
  assert.strictEqual(t2.fact.bags, 3);
  assert.strictEqual(t2.fact.items.length, 1);
  assert.strictEqual(t2.fact.items[0].name, 'пододеяльник');
  assert.strictEqual(t2.fact.items[0].qty, 12);
  assert.ok(t2.steps[5].at.includes(TODAY), 'done_at в шаге «Готово»');
});

test('clientGetTrack: «Направляется к вам» → «Доставлено»; no_linen честный статус', () => {
  const ctx = makeCtx();
  const driver = loginDriver();
  const s = seedClientWithAccess(ctx);

  const req = ctx.api.clientCreateRequest(s.token, 1, '', []).request;
  const visit = ctx.api.addDeliveryVisit(s.owner, s.clientId, TODAY).visit;
  assert.ok(ctx.api.linkRequestToVisit(s.owner, req.id, visit.id).ok);
  assert.ok(ctx.api.driverAction(driver, visit.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.getDayList(s.owner, '2026-08-11').ok);
  const wash = ctx.db.findRowsByTenant_('Washes', function (w) {
    return w.client_id === s.clientId;
  }, 10, '1')[0].obj;
  // Чистое едет к клиенту следующим визитом (визит забора остался в 'picked'):
  // визит выдачи на завтра, чистое на складе после completeWash
  const visitOut = ctx.api.addDeliveryVisit(s.owner, s.clientId, TOMORROW).visit;
  assert.ok(ctx.api.startWash(s.owner, wash.id, 10).ok);
  assert.ok(ctx.api.completeWash(s.owner, wash.id, [], 10, '', 1).ok);

  // Водитель забрал чистое со склада по визиту выдачи → «Направляется к вам»
  assert.ok(ctx.api.driverTakeAllClean(driver, TOMORROW).ok);
  const t1 = ctx.api.clientGetTrack(s.token, req.id);
  assert.strictEqual(t1.status.key, 'to_client');
  assert.strictEqual(t1.steps[6].current, true);
  assert.ok(t1.steps[6].at.includes(TODAY), 'clean_taken_at в шаге');

  // Отдал чистое → «Доставлено»
  assert.ok(ctx.api.driverAction(driver, visitOut.id, 'deliver_clean').ok);
  const t2 = ctx.api.clientGetTrack(s.token, req.id);
  assert.strictEqual(t2.status.key, 'delivered');
  assert.strictEqual(t2.steps[7].current, true);
  assert.strictEqual(t2.fact.weight_kg, 10);

  // no_linen: грязного не было — честный статус, без факта.
  // Заявка на 14-е — напрямую в БД (API создаёт только сегодняшние)
  ctx.db.appendRow_('Requests', {
    id: ctx.db.nextId_('Requests', 'req'), client_id: s.clientId, laundry_id: '1',
    visit_id: '', desired_date: '2026-08-14', bags: '1', comment: '',
    status: 'sent', created_by: 'test', created_at: '2026-08-14 08:00:00', updated_at: '2026-08-14 08:00:00'
  });
  const req2 = { id: ctx.db.readAll_('Requests').filter(function (r) {
    return r.desired_date === '2026-08-14';
  })[0].id };
  const visit2 = ctx.api.addDeliveryVisit(s.owner, s.clientId, '2026-08-14').visit;
  assert.ok(ctx.api.linkRequestToVisit(s.owner, req2.id, visit2.id).ok);
  ctx.db.appendRow_('Washes', {
    id: ctx.db.nextId_('Washes', 'wash'), client_id: s.clientId,
    wash_date: '2026-08-14', issue_date: '', status: 'no_linen',
    dirty_weight_kg: '', items_total: '', comment: '',
    created_by: 'auto', created_at: '2026-08-14 09:00:00',
    started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: '',
    bags: '', laundry_id: '1'
  });
  const t3 = ctx.api.clientGetTrack(s.token, req2.id);
  assert.strictEqual(t3.status.key, 'no_linen');
  assert.strictEqual(t3.fact, null);
  assert.ok(t3.steps.every(function (x) { return !x.current; }), 'ни один шаг не current');
});

test('clientGetTrack: непривязанная заявка — визит находится fallback\'ом, статус двигается', () => {
  const ctx = makeCtx();
  const driver = loginDriver();
  const s = seedClientWithAccess(ctx);

  // Без linkRequestToVisit — как заявки, забранные до появления автопривязки
  const req = ctx.api.clientCreateRequest(s.token, 2, '', []).request;
  const visit = ctx.api.addDeliveryVisit(s.owner, s.clientId, TODAY).visit;
  assert.ok(ctx.api.driverAction(driver, visit.id, 'pickup_dirty').ok);

  const t = ctx.api.clientGetTrack(s.token, req.id);
  assert.ok(t.ok, t.error);
  assert.strictEqual(t.status.key, 'to_laundry');
  assert.ok(t.steps[2].at.includes(TODAY), 'picked_at в шаге «На пути в прачечную»');

  // Легаси-заявка: забрана до автопривязки, visit_id остался пуст — трек
  // всё равно находит визит fallback'ом
  const row = ctx.db.findRowsByTenant_('Requests', function (r) { return r.id === req.id; }, 1, '1')[0];
  row.obj.visit_id = '';
  ctx.db.updateRow_('Requests', row.rowNumber, row.obj);
  const t2 = ctx.api.clientGetTrack(s.token, req.id);
  assert.strictEqual(t2.status.key, 'to_laundry');
});

test('clientGetTrack: чужой трек не читается; права только у client', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const s = seedClientWithAccess(ctx);
  const other = ctx.api.saveClient(owner, { name: 'Отель Чужой', type: 'отель' }).client;
  assert.ok(ctx.api.setClientAccess(owner, other.id, 'other-hotel', 'portal-pass').ok);
  const otherToken = ctx.auth.login('other-hotel', 'portal-pass').token;

  const req = ctx.api.clientCreateRequest(s.token, 1, '', []).request;
  assert.strictEqual(ctx.api.clientGetTrack(otherToken, req.id).error, 'Заявка не существует');
  assert.strictEqual(ctx.api.clientGetTrack(owner, req.id).error, 'Нет доступа');
});
