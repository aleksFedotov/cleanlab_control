// Тесты авторасчёта счетов (P2, docs/tickets.md): buildInvoice_ + API прайса.
// Эталонные счёта из тикета воспроизводятся строка в строку.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, loginDriver } = require('./helpers/serverMocks');

const FROM = '2026-08-01';
const TO = '2026-08-31';

// Контекст + id стартовых позиций прайса (сид миграции v4).
function mkBillingCtx() {
  const ctx = makeCtx();
  const owner = loginOwner();
  const items = ctx.api.listBillingItems(owner).items;
  const bi = {
    weight: items.find(i => i.kind === 'wash_weight').id,
    robe: items.find(i => i.name.indexOf('Халат') !== -1).id,
    pillow: items.find(i => i.name.indexOf('Подушка') !== -1).id,
    curtain: items.find(i => i.name.indexOf('Штора') !== -1).id,
    trip: items.find(i => i.kind === 'trip' && !i.max_kg && i.oneway !== 'да').id,
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
  const id = o.id || ('w_t' + washSeq);
  ctx.db.appendRowTenant_('Washes', {
    id: id, client_id: o.client_id, wash_date: o.wash_date,
    issue_date: o.issue_date || o.wash_date, status: o.status,
    dirty_weight_kg: o.kg !== undefined && o.kg !== '' ? String(o.kg) : '',
    items_total: '', comment: '',
    created_by: 'test', created_at: o.wash_date + ' 08:00:00',
    started_at: '', done_at: '', issued_at: o.issued_at || '',
    deferred_from: '', deferred_reason: '', bags: ''
  }, '1');
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
  const id = o.id || ('del_t' + visitSeq);
  const status = o.status ||
    (o.picked_at && o.delivered_at ? 'both' : (o.delivered_at ? 'delivered' : 'picked'));
  ctx.db.appendRowTenant_('Deliveries', {
    id: id, date: o.date, client_id: o.client_id, ord: '1', status: status,
    delivered_at: o.delivered_at || '', pickup: o.picked_at ? 'да' : '',
    driver_comment: '', created_by: 'test', created_at: o.date + ' 09:00:00',
    clean_taken_at: '', clean_bags: '', picked_at: o.picked_at || '',
    dirty_handed_at: '', pickup_only: '', lift_floor: o.lift_floor || ''
  }, '1');
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

function invoice(ctx, owner, clientId) {
  const r = ctx.api.getClientInvoice(owner, clientId, FROM, TO);
  assert.ok(r.ok, r.error);
  return r.invoice;
}

function line(inv, biId) {
  return inv.lines.find(l => l.billing_item_id === biId);
}

// Тип белья, привязанный к штучной позиции прайса.
function addLinkedType(ctx, owner, name, billingItemId) {
  const r = ctx.api.saveItemType(owner, { name: name, billing_item_id: billingItemId });
  assert.ok(r.ok, r.error);
  return r.itemType.id;
}

// --- Стирки: вес и штуки ---

test('весовой клиент: Σкг × цена; cancelled и partial исключены, достирка попадает', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_a', 'Отель А');
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-03', status: 'done', kg: 500 });
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-10', status: 'stored', kg: 200 });
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-15', status: 'issued', kg: 92, issued_at: '2026-08-16 12:00:00' });
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-05', status: 'cancelled', kg: 100 });
  const partId = addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-07', status: 'partial', kg: 50 });
  // Вне периода
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-07-28', status: 'done', kg: 300 });

  assert.ok(ctx.api.saveTariff(owner, '', bi.weight, 50).ok);
  assert.ok(ctx.api.saveTariff(owner, 'cli_a', bi.weight, 55).ok);

  let inv = invoice(ctx, owner, 'cli_a');
  assert.deepStrictEqual(
    { qty: line(inv, bi.weight).qty, price: line(inv, bi.weight).price, amount: line(inv, bi.weight).amount },
    { qty: 792, price: 55, amount: 43560 });
  assert.strictEqual(inv.total, 43560);
  assert.deepStrictEqual(inv.missing_prices, []);

  // Достирка: partial → done, итоги суммируются
  const found = ctx.db.findById_('Washes', partId);
  found.obj.status = 'done';
  ctx.db.updateRow_('Washes', found.rowNumber, found.obj);
  inv = invoice(ctx, owner, 'cli_a');
  assert.strictEqual(line(inv, bi.weight).qty, 842);
});

test('наследование цены: переопределение → дефолт прачки → missing_prices', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_a');
  addClient(ctx, 'cli_b', 'Отель Б');
  addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-03', status: 'done', kg: 100 });
  addWash(ctx, { client_id: 'cli_b', wash_date: '2026-08-03', status: 'done', kg: 100 });

  // Без цен вообще — строка с price=null в missing_prices, в итог не входит
  let inv = invoice(ctx, owner, 'cli_a');
  assert.strictEqual(line(inv, bi.weight).price, null);
  assert.strictEqual(line(inv, bi.weight).amount, null);
  assert.deepStrictEqual(inv.missing_prices, [bi.weight]);
  assert.strictEqual(inv.total, 0);

  // Дефолт прачки
  ctx.api.saveTariff(owner, '', bi.weight, 50);
  assert.strictEqual(line(invoice(ctx, owner, 'cli_a'), bi.weight).price, 50);
  assert.strictEqual(line(invoice(ctx, owner, 'cli_b'), bi.weight).price, 50);

  // Переопределение клиента перекрывает дефолт; у другого — дефолт
  ctx.api.saveTariff(owner, 'cli_a', bi.weight, 55);
  assert.strictEqual(line(invoice(ctx, owner, 'cli_a'), bi.weight).price, 55);
  assert.strictEqual(line(invoice(ctx, owner, 'cli_b'), bi.weight).price, 50);

  // Снятие переопределения — возврат к дефолту
  assert.ok(ctx.api.saveTariff(owner, 'cli_a', bi.weight, '').ok);
  assert.strictEqual(line(invoice(ctx, owner, 'cli_a'), bi.weight).price, 50);
});

test('группировка: подушка+одеяло+наматрасник → одна строка с суммарным qty', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_a');
  const t1 = addLinkedType(ctx, owner, 'подушка', bi.pillow);
  const t2 = addLinkedType(ctx, owner, 'одеяло', bi.pillow);
  const t3 = addLinkedType(ctx, owner, 'наматрасник', bi.pillow);
  ctx.api.saveTariff(owner, '', bi.pillow, 300);

  const w = addWash(ctx, { client_id: 'cli_a', wash_date: '2026-08-03', status: 'done', kg: 100 });
  addWashItem(ctx, w, t1, 2);
  addWashItem(ctx, w, t2, 2);
  addWashItem(ctx, w, t3, 2);

  const inv = invoice(ctx, owner, 'cli_a');
  assert.deepStrictEqual(
    { qty: line(inv, bi.pillow).qty, price: line(inv, bi.pillow).price, amount: line(inv, bi.pillow).amount },
    { qty: 6, price: 300, amount: 1800 });
});

test('per-клиентская привязка: полотенце в кг у отеля и поштучно у фитнес-зала; цены 55/75', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_hotel', 'Отель');
  addClient(ctx, 'cli_gym', 'Фитнес-зал');
  // Полотенце банное — стартовый тип itm_4; поштучная позиция для фитнес-зала
  const towelBi = ctx.api.saveBillingItem(owner, {
    name: 'Услуги прачечной (Полотенце)', unit: 'шт', kind: 'wash_pcs'
  }).item.id;
  assert.ok(ctx.api.saveClientItemBilling(owner, 'cli_gym', 'itm_4', towelBi).ok);
  ctx.api.saveTariff(owner, '', towelBi, 20);
  ctx.api.saveTariff(owner, 'cli_hotel', bi.weight, 55);
  ctx.api.saveTariff(owner, 'cli_gym', bi.weight, 75);

  const wHotel = addWash(ctx, { client_id: 'cli_hotel', wash_date: '2026-08-03', status: 'done', kg: 50 });
  addWashItem(ctx, wHotel, 'itm_4', 10);
  const wGym = addWash(ctx, { client_id: 'cli_gym', wash_date: '2026-08-03', status: 'done', kg: 50 });
  addWashItem(ctx, wGym, 'itm_4', 10);

  const invHotel = invoice(ctx, owner, 'cli_hotel');
  assert.strictEqual(line(invHotel, towelBi), undefined, 'у отеля полотенце идёт в вес');
  assert.strictEqual(line(invHotel, bi.weight).price, 55);

  const invGym = invoice(ctx, owner, 'cli_gym');
  assert.deepStrictEqual(
    { qty: line(invGym, towelBi).qty, price: line(invGym, towelBi).price },
    { qty: 10, price: 20 });
  assert.strictEqual(line(invGym, bi.weight).price, 75);
});

test('per-клиентская привязка: халат по умолчанию поштучный, у клиента переопределён в вес', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_x');
  addClient(ctx, 'cli_y');
  // Глобально халат (itm_7) — поштучный
  assert.ok(ctx.api.saveItemType(owner, { id: 'itm_7', billing_item_id: bi.robe }).ok);
  ctx.api.saveTariff(owner, '', bi.robe, 100);
  // У клиента X халат идёт в вес (пустая привязка перекрывает глобальную)
  assert.ok(ctx.api.saveClientItemBilling(owner, 'cli_x', 'itm_7', '').ok);

  const wx = addWash(ctx, { client_id: 'cli_x', wash_date: '2026-08-03', status: 'done', kg: 30 });
  addWashItem(ctx, wx, 'itm_7', 5);
  const wy = addWash(ctx, { client_id: 'cli_y', wash_date: '2026-08-03', status: 'done', kg: 30 });
  addWashItem(ctx, wy, 'itm_7', 5);

  assert.strictEqual(line(invoice(ctx, owner, 'cli_x'), bi.robe), undefined);
  assert.strictEqual(line(invoice(ctx, owner, 'cli_y'), bi.robe).qty, 5);

  // Удаление строки привязки — возврат к глобальному дефолту (поштучно)
  assert.ok(ctx.api.saveClientItemBilling(owner, 'cli_x', 'itm_7', null).ok);
  assert.strictEqual(line(invoice(ctx, owner, 'cli_x'), bi.robe).qty, 5);
});

// --- Рейсы и подъём ---

test('ярусы: <30 кг, обычная, доставка наследует ярус забора, одна нога → oneway', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_t');
  [bi.light, bi.trip, bi.oneway].forEach(id => ctx.api.saveTariff(owner, '', id, 300));

  // Двуногий визит, партия 29 кг → обе ноги «менее 30 кг»
  const w1 = addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-03', status: 'issued', kg: 29, issued_at: '2026-08-04 12:00:00' });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-04', picked_at: '2026-08-04 10:00:00', delivered_at: '2026-08-04 12:00:00' });
  addDirtyStorage(ctx, 'cli_t', '2026-08-04', w1);

  // Двуногий визит, партия 31 кг → обе ноги обычные
  const w2 = addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-05', status: 'issued', kg: 31, issued_at: '2026-08-06 12:00:00' });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-06', picked_at: '2026-08-06 10:00:00', delivered_at: '2026-08-06 12:00:00' });
  addDirtyStorage(ctx, 'cli_t', '2026-08-06', w2);

  // Только забор → oneway (нога одна, хотя партия лёгкая)
  const w3 = addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-08', status: 'planned', kg: 20 });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-08', picked_at: '2026-08-08 10:00:00' });
  addDirtyStorage(ctx, 'cli_t', '2026-08-08', w3);

  // Только доставка → тоже oneway
  addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-08', status: 'issued', kg: 25, issued_at: '2026-08-09 12:00:00' });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-09', delivered_at: '2026-08-09 12:00:00' });

  const inv = invoice(ctx, owner, 'cli_t');
  assert.strictEqual(line(inv, bi.light).qty, 2, '29 кг: обе ноги лёгкие');
  assert.strictEqual(line(inv, bi.trip).qty, 2, '31 кг: обе ноги обычные');
  assert.strictEqual(line(inv, bi.oneway).qty, 2, 'одноногие визиты → oneway');
});

test('ярус определяется весом грязного, а не чистого', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_t');
  [bi.light, bi.trip].forEach(id => ctx.api.saveTariff(owner, '', id, 300));
  // Партия принята 29 кг грязного → доставка того же цикла лёгкая
  const w = addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-03', status: 'issued', kg: 29, issued_at: '2026-08-05 12:00:00' });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-03', picked_at: '2026-08-03 10:00:00' });
  addDirtyStorage(ctx, 'cli_t', '2026-08-03', w);
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-05', delivered_at: '2026-08-05 12:00:00' });
  const inv = invoice(ctx, owner, 'cli_t');
  // Обе ноги одноногих визитов → oneway; лёгкий ярус берётся из веса грязного (29 < 30)
  assert.strictEqual(line(inv, bi.oneway).qty, 2);
});

test('подъём: пусто/1/2 без доплаты; 3-й → 1 шт, 4-й → 2 шт (per_floor); правка владельцем', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_l');
  ctx.api.saveTariff(owner, '', bi.lift, 300);
  ctx.api.saveTariff(owner, '', bi.oneway, 100);

  addVisit(ctx, { client_id: 'cli_l', date: '2026-08-03', delivered_at: '2026-08-03 12:00:00' }); // пусто
  addVisit(ctx, { client_id: 'cli_l', date: '2026-08-04', delivered_at: '2026-08-04 12:00:00', lift_floor: '2' });
  const v3 = addVisit(ctx, { client_id: 'cli_l', date: '2026-08-05', delivered_at: '2026-08-05 12:00:00', lift_floor: '3' });
  addVisit(ctx, { client_id: 'cli_l', date: '2026-08-06', delivered_at: '2026-08-06 12:00:00', lift_floor: '4' });

  let inv = invoice(ctx, owner, 'cli_l');
  assert.strictEqual(line(inv, bi.lift).qty, 3, '3-й этаж = 1 шт, 4-й = 2 шт');
  assert.strictEqual(line(inv, bi.lift).amount, 900);

  // Правка владельцем задним числом пересчитывает счёт
  assert.ok(ctx.api.setVisitLiftFloor(owner, v3, 5).ok);
  inv = invoice(ctx, owner, 'cli_l');
  assert.strictEqual(line(inv, bi.lift).qty, 5, '5-й этаж = 3 шт вместо 1');
  assert.ok(ctx.api.setVisitLiftFloor(owner, v3, 2).ok);
  inv = invoice(ctx, owner, 'cli_l');
  assert.strictEqual(line(inv, bi.lift).qty, 2);

  // Режим «за факт подъёма» (per_floor пусто): любой этаж = 1 шт за визит
  const liftItem = ctx.api.listBillingItems(owner).items.find(i => i.id === bi.lift);
  assert.ok(ctx.api.saveBillingItem(owner, {
    id: bi.lift, name: liftItem.name, unit: liftItem.unit, kind: 'lift', per_floor: ''
  }).ok);
  inv = invoice(ctx, owner, 'cli_l');
  assert.strictEqual(line(inv, bi.lift).qty, 1, 'остался один визит с этажом > 2');
});

test('подъём не на каждом визите и не свойство клиента', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_l');
  ctx.api.saveTariff(owner, '', bi.lift, 300);
  // 4 визита, подъём только в одном
  ['2026-08-03', '2026-08-04', '2026-08-05'].forEach(d => {
    addVisit(ctx, { client_id: 'cli_l', date: d, delivered_at: d + ' 12:00:00' });
  });
  addVisit(ctx, { client_id: 'cli_l', date: '2026-08-06', delivered_at: '2026-08-06 12:00:00', lift_floor: '3' });
  const inv = invoice(ctx, owner, 'cli_l');
  assert.strictEqual(line(inv, bi.lift).qty, 1);
});

// --- Права ---

test('права: worker/driver → «Нет доступа» на всех методах биллинга', () => {
  const { ctx, bi } = mkBillingCtx();
  addClient(ctx, 'cli_a');
  const worker = loginWorker();
  const driver = loginDriver();
  [worker, driver].forEach(token => {
    assert.strictEqual(ctx.api.listBillingItems(token).error, 'Нет доступа');
    assert.strictEqual(ctx.api.saveBillingItem(token, { name: 'X', unit: 'шт', kind: 'wash_pcs' }).error, 'Нет доступа');
    assert.strictEqual(ctx.api.deleteBillingItem(token, bi.robe).error, 'Нет доступа');
    assert.strictEqual(ctx.api.listTariffs(token).error, 'Нет доступа');
    assert.strictEqual(ctx.api.saveTariff(token, '', bi.weight, 55).error, 'Нет доступа');
    assert.strictEqual(ctx.api.saveClientItemBilling(token, 'cli_a', 'itm_4', bi.robe).error, 'Нет доступа');
    assert.strictEqual(ctx.api.listClientItemBilling(token, 'cli_a').error, 'Нет доступа');
    assert.strictEqual(ctx.api.getClientInvoice(token, 'cli_a', FROM, TO).error, 'Нет доступа');
    assert.strictEqual(ctx.api.setVisitLiftFloor(token, 'del_1', 3).error, 'Нет доступа');
  });
});

// --- Эталонные счёта из тикета ---

test('эталон 1: 792 кг × 55 + халат 12 × 100 + подушка/одеяло/наматрасник 6 × 300', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_e1');
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

  const inv = invoice(ctx, owner, 'cli_e1');
  assert.deepStrictEqual(
    inv.lines.map(l => [l.billing_item_id, l.qty, l.price, l.amount]),
    [[bi.weight, 792, 55, 43560], [bi.robe, 12, 100, 1200], [bi.pillow, 6, 300, 1800]]);
  assert.strictEqual(inv.total, 46560);
});

test('эталон 2: 862 кг × 55 + халат 15 × 100 + штора 8 × 200 + «в одну сторону» 4 × 300', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_e2');
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

  const inv = invoice(ctx, owner, 'cli_e2');
  assert.deepStrictEqual(
    inv.lines.map(l => [l.billing_item_id, l.qty, l.price, l.amount]),
    [[bi.weight, 862, 55, 47410], [bi.robe, 15, 100, 1500],
     [bi.curtain, 8, 200, 1600], [bi.oneway, 4, 300, 1200]]);
  assert.strictEqual(inv.total, 51710);
});

test('эталон 3: 422×75 + халаты 10×155 + «менее 30 кг» 14×450 + подъём 15×300 + «в одну сторону/забор» 4×450', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_e3');
  ctx.api.saveItemType(owner, { id: 'itm_7', billing_item_id: bi.robe });
  ctx.api.saveTariff(owner, 'cli_e3', bi.weight, 75);
  ctx.api.saveTariff(owner, 'cli_e3', bi.robe, 155);
  ctx.api.saveTariff(owner, '', bi.light, 450);
  ctx.api.saveTariff(owner, '', bi.oneway, 450);
  ctx.api.saveTariff(owner, '', bi.lift, 300);

  // 7 двуногих визитов с лёгкой партией (29 кг) → 14 ног «менее 30 кг», подъём на 3-й
  for (let i = 1; i <= 7; i++) {
    const d = '2026-08-0' + i;
    const w = addWash(ctx, { client_id: 'cli_e3', wash_date: d, status: 'issued', kg: 29, issued_at: d + ' 12:00:00' });
    addVisit(ctx, { client_id: 'cli_e3', date: d, picked_at: d + ' 10:00:00', delivered_at: d + ' 12:00:00', lift_floor: '3' });
    addDirtyStorage(ctx, 'cli_e3', d, w);
  }
  // 4 одноногих визита-забора → oneway, подъём на 4-й (2 этажа каждый)
  for (let i = 8; i <= 11; i++) {
    const d = '2026-08-' + (i < 10 ? '0' + i : String(i));
    const w = addWash(ctx, { client_id: 'cli_e3', wash_date: d, status: 'planned' });
    addVisit(ctx, { client_id: 'cli_e3', date: d, picked_at: d + ' 10:00:00', lift_floor: '4' });
    addDirtyStorage(ctx, 'cli_e3', d, w);
  }
  // Добивка веса до 422 кг + халаты
  const wExtra = addWash(ctx, { client_id: 'cli_e3', wash_date: '2026-08-15', status: 'done', kg: 219 });
  addWashItem(ctx, wExtra, 'itm_7', 10);

  const inv = invoice(ctx, owner, 'cli_e3');
  assert.deepStrictEqual(
    inv.lines.map(l => [l.billing_item_id, l.qty, l.price, l.amount]),
    [[bi.weight, 422, 75, 31650], [bi.robe, 10, 155, 1550],
     [bi.light, 14, 450, 6300], [bi.oneway, 4, 450, 1800], [bi.lift, 15, 300, 4500]]);
  assert.strictEqual(inv.total, 45800);
});

// --- Схема и справочник прайса ---

test('миграция v4: стартовый прайс сидится один раз (идемпотентно)', () => {
  const { ctx, owner } = mkBillingCtx();
  const before = ctx.api.listBillingItems(owner).items;
  assert.strictEqual(before.length, 8);
  assert.strictEqual(before.filter(i => i.kind === 'wash_weight' && i.active === 'да').length, 1);
  ctx.db.migrateToV4_();
  ctx.db.migrateToV4_();
  assert.strictEqual(ctx.api.listBillingItems(owner).items.length, 8);
});

test('ровно одна активная весовая позиция на прачку', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  const dup = ctx.api.saveBillingItem(owner, { name: 'Махра за кг', unit: 'кг', kind: 'wash_weight' });
  assert.strictEqual(dup.ok, false);
  assert.ok(dup.error.indexOf('весовая позиция') !== -1);
  // Архивировали старую — можно завести новую
  const old = ctx.api.listBillingItems(owner).items.find(i => i.id === bi.weight);
  assert.ok(ctx.api.saveBillingItem(owner, {
    id: old.id, name: old.name, unit: old.unit, kind: old.kind, active: 'нет'
  }).ok);
  assert.ok(ctx.api.saveBillingItem(owner, { name: 'Махра за кг', unit: 'кг', kind: 'wash_weight' }).ok);
});

test('deleteBillingItem: запрет при использовании, разрешён для неиспользуемой', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_a');

  // Используется в тарифах
  ctx.api.saveTariff(owner, '', bi.robe, 100);
  let r = ctx.api.deleteBillingItem(owner, bi.robe);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('используется') !== -1);
  ctx.api.saveTariff(owner, '', bi.robe, '');

  // Используется в типах белья
  ctx.api.saveItemType(owner, { id: 'itm_7', billing_item_id: bi.robe });
  assert.strictEqual(ctx.api.deleteBillingItem(owner, bi.robe).ok, false);
  ctx.api.saveItemType(owner, { id: 'itm_7', billing_item_id: '' });

  // Используется в per-клиентской привязке
  ctx.api.saveClientItemBilling(owner, 'cli_a', 'itm_7', bi.robe);
  assert.strictEqual(ctx.api.deleteBillingItem(owner, bi.robe).ok, false);
  ctx.api.saveClientItemBilling(owner, 'cli_a', 'itm_7', null);

  // Свободная позиция удаляется
  assert.ok(ctx.api.deleteBillingItem(owner, bi.robe).ok);
  const items = ctx.api.listBillingItems(owner).items;
  assert.strictEqual(items.find(i => i.id === bi.robe), undefined);
});

test('saveBillingItem: валидация вида/единицы/названия', () => {
  const { ctx, owner } = mkBillingCtx();
  assert.strictEqual(ctx.api.saveBillingItem(owner, { name: 'X', unit: 'шт', kind: 'bogus' }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, { name: 'X', unit: 'тонны', kind: 'wash_pcs' }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, { name: '  ', unit: 'шт', kind: 'wash_pcs' }).ok, false);
});

test('migrateToV4_: повторный запуск не дублирует прайс (страж по всей таблице)', () => {
  const { ctx } = mkBillingCtx(); // прачка 1 уже имеет 8 позиций из openTest
  // Три прачки: при хвостовом LIMIT-страже позиции первой «терялись» в хвосте
  // и каждый перезапуск сидил её заново (баг «прайс дублируется»).
  ctx.db.appendRow_('Laundries', { id: '2', name: 'П2', active: 'да' });
  ctx.db.appendRow_('Laundries', { id: '3', name: 'П3', active: 'да' });
  ctx.db.migrateToV4_(); // досидит прачки 2 и 3
  assert.strictEqual(ctx.db.readAll_('BillingItems').length, 24, '3 прачки × 8 позиций');
  ctx.db.migrateToV4_(); // повторно — ничего не добавляет
  assert.strictEqual(ctx.db.readAll_('BillingItems').length, 24);
});

// --- Этаж от водителя ---

test('driverAction принимает этаж подъёма; пусто/1/2 → без доплаты', () => {
  const { ctx, owner } = mkBillingCtx();
  addClient(ctx, 'cli_d');
  const driver = loginDriver();

  const v1 = ctx.api.addDeliveryVisit(owner, 'cli_d', '2026-08-05').visit.id;
  const r1 = ctx.api.driverAction(driver, v1, 'pickup_dirty', 3);
  assert.ok(r1.ok, r1.error);
  assert.strictEqual(r1.visit.lift_floor, '3');

  const v2 = ctx.api.addDeliveryVisit(owner, 'cli_d', '2026-08-06').visit.id;
  const r2 = ctx.api.driverAction(driver, v2, 'pickup_dirty', 2);
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(r2.visit.lift_floor, '', '1–2 этаж — без доплаты');

  // Событие visit_lift в Log
  const liftEvents = ctx.db.findRowsBy_('Log', function (e) { return e.action === 'visit_lift'; }, 100);
  assert.strictEqual(liftEvents.length, 2);
});

test('getDriverRoute: статистика дня — посещённые точки и доплата за подъём', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_v1');
  addClient(ctx, 'cli_v2');
  addClient(ctx, 'cli_v3');
  ctx.api.saveTariff(owner, '', bi.lift, '200'); // дефолтная цена подъёма
  const driver = loginDriver();
  const d = '2026-08-05';
  // На одну дату у клиента может быть только один визит — три разных клиента
  const v1 = ctx.api.addDeliveryVisit(owner, 'cli_v1', d).visit.id;
  const v2 = ctx.api.addDeliveryVisit(owner, 'cli_v2', d).visit.id;
  ctx.api.addDeliveryVisit(owner, 'cli_v3', d); // остаётся planned — не посещена
  ctx.api.driverAction(driver, v1, 'pickup_dirty', 5); // (5−2) × 200 = 600
  ctx.api.driverAction(driver, v2, 'pickup_dirty', 3); // (3−2) × 200 = 200

  const r = ctx.api.getDriverRoute(driver, d);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.stats.visited, 2);
  assert.strictEqual(r.stats.lift_qty, 4, 'per_floor=да: этажи выше 2-го');
  assert.strictEqual(r.stats.lift_total, 800);
  assert.strictEqual(r.stats.lift_missing, false);

  // Цену сняли — сумма не считается, флаг missing взведён
  ctx.api.saveTariff(owner, '', bi.lift, '');
  const r2 = ctx.api.getDriverRoute(driver, d);
  assert.strictEqual(r2.stats.lift_total, 0);
  assert.strictEqual(r2.stats.lift_missing, true);
});

test('старт стирки связывает dirty-запись склада со стиркой (вес ноги-забора)', () => {
  const { ctx, owner } = mkBillingCtx();
  addClient(ctx, 'cli_s');
  const worker = loginWorker();
  // Грязное на складе (как после driverHandover)
  ctx.db.appendRowTenant_('Storage', {
    id: ctx.db.nextId_('Storage', 'st'), client_id: 'cli_s', kind: 'dirty',
    weight_kg: '', items_total: '', wash_id: '', created_at: '2026-08-11 10:00:00', consumed_at: ''
  }, '1');
  const w = addWash(ctx, { client_id: 'cli_s', wash_date: '2026-08-12', status: 'planned' });
  const r = ctx.api.startWash(worker, w, 29);
  assert.ok(r.ok, r.error);
  const st = ctx.db.findRowsBy_('Storage', function (s) { return s.client_id === 'cli_s'; }, 10)[0];
  assert.strictEqual(st.obj.wash_id, w, 'dirty-запись связана со стиркой');
  assert.ok(st.obj.consumed_at, 'запись израсходована');
});
