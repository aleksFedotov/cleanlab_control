// Тесты финансовой сводки (P4, docs/Тикет P4): getFinanceSummary.
// Суммы сверяются с getClientInvoice по эталонным счетам из P2 (invoice.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, loginDriver, seedLaundry2 } = require('./helpers/serverMocks');

const FROM = '2026-08-01';
const TO = '2026-08-31';

// Контекст + id стартовых позиций прайса (сид миграции v4, P2.2 — 7 позиций).
function mkBillingCtx() {
  const ctx = makeCtx();
  const owner = loginOwner();
  const items = ctx.api.listBillingItems(owner).items;
  const bi = {
    weight: items.find(i => i.kind === 'wash_weight').id,
    robe: items.find(i => i.name.indexOf('Халат') !== -1).id,
    pillow: items.find(i => i.name.indexOf('Подушка') !== -1).id,
    curtain: items.find(i => i.name.indexOf('Штора') !== -1).id,
    light: items.find(i => i.kind === 'trip' && i.max_kg === '30').id,
    oneway: items.find(i => i.kind === 'trip' && i.oneway === 'да').id,
    lift: items.find(i => i.kind === 'lift').id
  };
  return { ctx, owner, bi };
}

function addClient(ctx, id, name) {
  ctx.db.appendRowTenant_('Clients', {
    id: id, name: name || id, contact: '', address: '', type: 'отель', active: 'да',
    comment: '', item_types: '', accounting: '', inn: '', kpp: '', legal_address: ''
  }, '1');
  ctx.db.invalidateRefCache_();
  return id;
}

let washSeq = 0;
function addWash(ctx, o) {
  washSeq++;
  const id = o.id || ('wf_t' + washSeq);
  ctx.db.appendRowTenant_('Washes', {
    id: id, client_id: o.client_id, wash_date: o.wash_date,
    issue_date: o.issue_date || o.wash_date, status: o.status,
    dirty_weight_kg: o.kg !== undefined && o.kg !== '' ? String(o.kg) : '',
    items_total: '', comment: '',
    created_by: 'test', created_at: o.wash_date + ' 08:00:00',
    started_at: '', done_at: '', issued_at: o.issued_at || '',
    deferred_from: '', deferred_reason: '', bags: ''
  }, o.laundry_id || '1');
  return id;
}

function addWashItem(ctx, washId, typeId, qty) {
  ctx.db.appendRow_('WashItems', {
    id: ctx.db.nextId_('WashItems', 'wi'), wash_id: washId,
    item_type_id: typeId, qty: String(qty)
  });
}

let visitSeq = 0;
function addVisit(ctx, o) {
  visitSeq++;
  const id = o.id || ('delf_t' + visitSeq);
  const status = o.status ||
    (o.picked_at && o.delivered_at ? 'both' : (o.delivered_at ? 'delivered' : 'picked'));
  ctx.db.appendRowTenant_('Deliveries', {
    id: id, date: o.date, client_id: o.client_id, ord: '1', status: status,
    delivered_at: o.delivered_at || '', pickup: o.picked_at ? 'да' : '',
    driver_comment: '', created_by: 'test', created_at: o.date + ' 09:00:00',
    clean_taken_at: '', clean_bags: '', picked_at: o.picked_at || '',
    dirty_handed_at: '', pickup_only: '', lift_floor: o.lift_floor || ''
  }, o.laundry_id || '1');
  return id;
}

// Dirty-запись склада в дату визита со связью на стирку (ставится при «В работу»).
function addDirtyStorage(ctx, clientId, date, washId) {
  ctx.db.appendRowTenant_('Storage', {
    id: ctx.db.nextId_('Storage', 'st'), client_id: clientId, kind: 'dirty',
    weight_kg: '', items_total: '', wash_id: washId || '',
    created_at: date + ' 10:00:00', consumed_at: date + ' 11:00:00'
  }, '1');
}

function addLinkedType(ctx, owner, name, billingItemId) {
  const r = ctx.api.saveItemType(owner, { name: name, billing_item_id: billingItemId });
  assert.ok(r.ok, r.error);
  return r.itemType.id;
}

function invoice(ctx, owner, clientId) {
  const r = ctx.api.getClientInvoice(owner, clientId, FROM, TO);
  assert.ok(r.ok, r.error);
  return r.invoice;
}

function summary(ctx, owner, from, to) {
  const r = ctx.api.getFinanceSummary(owner, from || FROM, to || TO);
  assert.ok(r.ok, r.error);
  return r;
}

function row(res, clientId) {
  return res.clients.find(c => c.client_id === clientId);
}

function kindTotals(bi, inv) {
  const kindById = {
    [bi.light]: 'trip', [bi.oneway]: 'trip', [bi.lift]: 'lift'
  };
  let trips = 0, lifts = 0;
  inv.lines.forEach(l => {
    if (kindById[l.billing_item_id] === 'trip') trips += l.qty;
    if (kindById[l.billing_item_id] === 'lift') lifts += l.qty;
  });
  return { trips, lifts };
}

// Эталонные фикстуры из тикета P2 (те же, что в invoice.test.js).

function fixtureEtalon1(ctx, owner, bi) {
  addClient(ctx, 'cli_e1', 'Отель Эталон 1');
  ctx.api.saveItemType(owner, { id: 'itm_7', billing_item_id: bi.robe });
  const t1 = addLinkedType(ctx, owner, 'подушка', bi.pillow);
  const t2 = addLinkedType(ctx, owner, 'одеяло', bi.pillow);
  const t3 = addLinkedType(ctx, owner, 'наматрасник', bi.pillow);
  ctx.api.saveTariff(owner, 'cli_e1', bi.weight, 55);
  ctx.api.saveTariff(owner, '', bi.robe, 100);
  ctx.api.saveTariff(owner, '', bi.pillow, 300);
  const w = addWash(ctx, { client_id: 'cli_e1', wash_date: '2026-08-03', status: 'done', kg: 792 });
  addWashItem(ctx, w, 'itm_7', 12);
  addWashItem(ctx, w, t1, 2);
  addWashItem(ctx, w, t2, 2);
  addWashItem(ctx, w, t3, 2);
  return 'cli_e1';
}

function fixtureEtalon2(ctx, owner, bi) {
  addClient(ctx, 'cli_e2', 'Отель Эталон 2');
  ctx.api.saveItemType(owner, { id: 'itm_7', billing_item_id: bi.robe });
  const curtainType = addLinkedType(ctx, owner, 'штора', bi.curtain);
  ctx.api.saveTariff(owner, 'cli_e2', bi.weight, 55);
  ctx.api.saveTariff(owner, '', bi.robe, 100);
  ctx.api.saveTariff(owner, '', bi.curtain, 200);
  ctx.api.saveTariff(owner, '', bi.oneway, 300);
  const w = addWash(ctx, { client_id: 'cli_e2', wash_date: '2026-08-03', status: 'done', kg: 862 });
  addWashItem(ctx, w, 'itm_7', 15);
  addWashItem(ctx, w, curtainType, 8);
  ['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26'].forEach(d => {
    addVisit(ctx, { client_id: 'cli_e2', date: d, picked_at: d + ' 10:00:00' });
  });
  return 'cli_e2';
}

function fixtureEtalon3(ctx, owner, bi) {
  addClient(ctx, 'cli_e3', 'Фитнес Эталон 3');
  ctx.api.saveItemType(owner, { id: 'itm_7', billing_item_id: bi.robe });
  ctx.api.saveTariff(owner, 'cli_e3', bi.weight, 75);
  ctx.api.saveTariff(owner, 'cli_e3', bi.robe, 155);
  ctx.api.saveTariff(owner, '', bi.light, 450);
  ctx.api.saveTariff(owner, '', bi.oneway, 450);
  ctx.api.saveTariff(owner, '', bi.lift, 300);
  for (let i = 1; i <= 7; i++) {
    const d = '2026-08-0' + i;
    const w = addWash(ctx, { client_id: 'cli_e3', wash_date: d, status: 'issued', kg: 29, issued_at: d + ' 12:00:00' });
    addVisit(ctx, { client_id: 'cli_e3', date: d, picked_at: d + ' 10:00:00', delivered_at: d + ' 12:00:00', lift_floor: '3' });
    addDirtyStorage(ctx, 'cli_e3', d, w);
  }
  for (let i = 8; i <= 11; i++) {
    const d = '2026-08-' + (i < 10 ? '0' + i : String(i));
    const w = addWash(ctx, { client_id: 'cli_e3', wash_date: d, status: 'planned' });
    addVisit(ctx, { client_id: 'cli_e3', date: d, picked_at: d + ' 10:00:00', lift_floor: '4' });
    addDirtyStorage(ctx, 'cli_e3', d, w);
  }
  const wExtra = addWash(ctx, { client_id: 'cli_e3', wash_date: '2026-08-15', status: 'done', kg: 219 });
  addWashItem(ctx, wExtra, 'itm_7', 10);
  return 'cli_e3';
}

// --- Суммы совпадают с getClientInvoice ---

// Каждый эталон в своём контексте: дефолтные тарифы эталона 3 перекрывали бы эталон 2.
function checkEtalon(fixture, expected) {
  const { ctx, owner, bi } = mkBillingCtx();
  const cid = fixture(ctx, owner, bi);
  const res = summary(ctx, owner);
  const inv = invoice(ctx, owner, cid);
  assert.strictEqual(row(res, cid).amount, expected, cid);
  assert.strictEqual(row(res, cid).amount, inv.total, cid);
  assert.deepStrictEqual(row(res, cid).lines, inv.lines, cid);
  assert.strictEqual(res.totals.amount, expected);
  return row(res, cid);
}

test('эталоны P2: суммы getFinanceSummary == getClientInvoice (46560 / 51710 / 45800)', () => {
  checkEtalon(fixtureEtalon1, 46560);
  checkEtalon(fixtureEtalon2, 51710);
  checkEtalon(fixtureEtalon3, 45800);
});

test('объёмы клиента и итоги totals (washes/weight_kg/items_total)', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_a', 'Отель А');
  ctx.api.saveTariff(owner, '', bi.weight, 50);
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-03', status: 'done', kg: 100 });
  const w2 = addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-10', status: 'stored', kg: 50 });
  // Рейс 50 кг ≥ N=30 — не тарифицируется (P2.2, позиции plain-trip больше нет)
  addVisit(ctx, { client_id: 'cli_a', date: '2026-08-03', picked_at: '2026-08-03 10:00:00', delivered_at: '2026-08-03 12:00:00' });
  addDirtyStorage(ctx, 'cli_a', '2026-08-03', w2);

  const res = summary(ctx, owner);
  const r = row(res, 'cli_a');
  assert.strictEqual(r.washes, 2);
  assert.strictEqual(r.weight_kg, 150);
  assert.strictEqual(res.totals.washes, 2);
  assert.strictEqual(res.totals.weight_kg, 150);
  assert.strictEqual(res.totals.amount, r.amount);
});

test('trips/lifts согласованы со строками счёта по kind', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  const e3 = fixtureEtalon3(ctx, owner, bi);
  const e2 = fixtureEtalon2(ctx, owner, bi);

  const res = summary(ctx, owner);
  [e3, e2].forEach(cid => {
    const inv = invoice(ctx, owner, cid);
    const kt = kindTotals(bi, inv);
    assert.strictEqual(row(res, cid).trips, kt.trips, cid + ' trips');
    assert.strictEqual(row(res, cid).lifts, kt.lifts, cid + ' lifts');
  });
  assert.strictEqual(row(res, e3).trips, 14 + 4, '14 лёгких ног + 4 oneway');
  assert.strictEqual(row(res, e3).lifts, 15);
});

test('клиент с позицией без цены: missing_prices > 0, сумма по оценённым строкам', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_m', 'Отель Без Цен');
  ctx.api.saveTariff(owner, '', bi.weight, 50);
  // Подъём без цены → missing_prices
  addWash(ctx, { client_id: 'cli_m', wash_date: '2026-08-03', status: 'done', kg: 100 });
  addVisit(ctx, { client_id: 'cli_m', date: '2026-08-03', delivered_at: '2026-08-03 12:00:00', lift_floor: '3' });

  const res = summary(ctx, owner);
  const r = row(res, 'cli_m');
  const inv = invoice(ctx, owner, 'cli_m');
  assert.ok(r.missing_prices > 0);
  assert.strictEqual(r.missing_prices, inv.missing_prices.length);
  assert.strictEqual(r.amount, 5000, 'только весовая строка; подъём без цены не входит');
});

test('клиент без стирок за период отсутствует в выдаче', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_idle', 'Простаивающий');
  addClient(ctx, 'cli_active', 'Активный');
  ctx.api.saveTariff(owner, '', bi.weight, 50);
  addWash(ctx, { client_id: 'cli_active', wash_date: '2026-08-03', status: 'done', kg: 10 });

  const res = summary(ctx, owner);
  assert.strictEqual(row(res, 'cli_idle'), undefined);
  assert.strictEqual(res.clients.length, 1);
});

// --- Права и изоляция ---

test('права: worker/driver → «Нет доступа»', () => {
  const ctx = makeCtx();
  assert.strictEqual(ctx.api.getFinanceSummary(loginWorker(), FROM, TO).error, 'Нет доступа');
  assert.strictEqual(ctx.api.getFinanceSummary(loginDriver(), FROM, TO).error, 'Нет доступа');
});

test('tenant-фильтр: чужая прачка не видна', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  seedLaundry2();
  ctx.db.appendRowTenant_('Clients', {
    id: 'cli_t2', name: 'Клиент прачки 2', contact: '', address: '', type: 'отель', active: 'да',
    comment: '', item_types: '', accounting: '', inn: '', kpp: '', legal_address: ''
  }, '2');
  ctx.db.invalidateRefCache_();
  addWash(ctx, { client_id: 'cli_t2', wash_date: '2026-08-03', status: 'done', kg: 500, laundry_id: '2' });
  addClient(ctx, 'cli_t1', 'Клиент прачки 1');
  ctx.api.saveTariff(owner, '', bi.weight, 50);
  addWash(ctx, { client_id: 'cli_t1', wash_date: '2026-08-03', status: 'done', kg: 10 });

  const res = summary(ctx, owner);
  assert.strictEqual(row(res, 'cli_t2'), undefined);
  assert.strictEqual(res.clients.length, 1);
  assert.strictEqual(res.totals.weight_kg, 10);
});

// --- Период ---

test('пустой период: пустой список, нулевые итоги, без ошибок', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_a');
  ctx.api.saveTariff(owner, '', bi.weight, 50);
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-03', status: 'done', kg: 100 });

  const res = summary(ctx, owner, '2026-09-01', '2026-09-30');
  assert.deepStrictEqual(res.clients, []);
  assert.deepStrictEqual(res.totals, { washes: 0, weight_kg: 0, items_total: 0, amount: 0 });
});

test('некорректный период: формат дат и from > to', () => {
  const { ctx, owner } = mkBillingCtx();
  assert.strictEqual(ctx.api.getFinanceSummary(owner, 'bad', TO).error, 'Некорректный период');
  assert.strictEqual(ctx.api.getFinanceSummary(owner, FROM, '2026-8-1').error, 'Некорректный период');
  assert.strictEqual(ctx.api.getFinanceSummary(owner, '01.08.2026', TO).error, 'Некорректный период');
  assert.strictEqual(ctx.api.getFinanceSummary(owner, TO, FROM).error, 'Некорректный период');
  assert.strictEqual(ctx.api.getFinanceSummary(owner, '', '').error, 'Некорректный период');
});

test('регрессия: стирка по удалённому клиенту не роняет сводку', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  ctx.api.saveTariff(owner, '', bi.weight, 50);
  // Строки Clients нет (клиент удалён вне purgeClient) — сводка обязана отработать
  addWash(ctx, { client_id: 'cli_deleted', wash_date: '2026-08-03', status: 'done', kg: 100 });

  const res = summary(ctx, owner);
  assert.strictEqual(res.clients.length, 1);
  assert.strictEqual(res.clients[0].client_id, 'cli_deleted');
  assert.strictEqual(res.totals.washes, 1);
  assert.strictEqual(res.totals.weight_kg, 100);
  assert.strictEqual(res.totals.amount, 5000);
});
