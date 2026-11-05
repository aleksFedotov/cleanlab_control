// Тесты авторасчёта счетов (P2, docs/tickets.md): buildInvoice_ + API прайса.
// Эталонные счёта из тикета воспроизводятся строка в строку.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, loginDriver } = require('./helpers/serverMocks');

const FROM = '2026-08-01';
const TO = '2026-08-31';

// Контекст + id стартовых позиций прайса (сид миграции v4: 8 позиций,
// включая per_visit «Доставку» P11; plain-trip без per_visit удалена миграцией v6).
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
    round: items.find(i => i.kind === 'trip' && i.per_visit === 'да').id,
    oneway: items.find(i => i.kind === 'trip' && i.oneway === 'да').id,
    lift: items.find(i => i.kind === 'lift').id
  };
  return { ctx, owner, bi };
}

function addClient(ctx, id, name, extra) {
  ctx.db.appendRowTenant_('Clients', Object.assign({
    id: id, name: name || id, contact: '', address: '', type: 'отель', active: 'да',
    comment: '', item_types: '', accounting: '', inn: '', kpp: '', legal_address: '',
    paid_delivery: ''
  }, extra || {}), '1');
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

test('ярусы: <30 кг — платно ×2, от 30 кг — бесплатно, одна нога → oneway', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_t');
  [bi.light, bi.oneway].forEach(id => ctx.api.saveTariff(owner, '', id, 300));

  // Двуногий визит, партия 29 кг → обе ноги «менее 30 кг»
  const w1 = addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-03', status: 'issued', kg: 29, issued_at: '2026-08-04 12:00:00' });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-04', picked_at: '2026-08-04 10:00:00', delivered_at: '2026-08-04 12:00:00' });
  addDirtyStorage(ctx, 'cli_t', '2026-08-04', w1);

  // Двуногий визит, партия 31 кг → обе ноги бесплатны (доставка от N кг не тарифицируется)
  const w2 = addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-05', status: 'issued', kg: 31, issued_at: '2026-08-06 12:00:00' });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-06', picked_at: '2026-08-06 10:00:00', delivered_at: '2026-08-06 12:00:00' });
  addDirtyStorage(ctx, 'cli_t', '2026-08-06', w2);

  // Только забор → oneway (нога одна, независимо от веса)
  const w3 = addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-08', status: 'planned', kg: 20 });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-08', picked_at: '2026-08-08 10:00:00' });
  addDirtyStorage(ctx, 'cli_t', '2026-08-08', w3);

  // Только доставка → тоже oneway, хотя партия 25 кг < N
  addWash(ctx, { client_id: 'cli_t', wash_date: '2026-08-08', status: 'issued', kg: 25, issued_at: '2026-08-09 12:00:00' });
  addVisit(ctx, { client_id: 'cli_t', date: '2026-08-09', delivered_at: '2026-08-09 12:00:00' });

  const inv = invoice(ctx, owner, 'cli_t');
  assert.strictEqual(line(inv, bi.light).qty, 2, '29 кг: обе ноги лёгкие');
  assert.strictEqual(line(inv, bi.oneway).qty, 2, 'одноногие визиты → oneway независимо от веса');
  const tripLines = inv.lines.filter(l => {
    const item = ctx.api.listBillingItems(owner).items.find(i => i.id === l.billing_item_id);
    return item && item.kind === 'trip';
  });
  assert.strictEqual(tripLines.length, 2, 'тяжёлый рейс 31 кг строк не даёт — только лёгкий ярус и oneway');
});

test('ярус определяется весом грязного, а не чистого', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_t');
  [bi.light].forEach(id => ctx.api.saveTariff(owner, '', id, 300));
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

  // P2.2: параметры системной позиции зафиксированы — per_floor сменить нельзя
  assert.strictEqual(ctx.api.saveBillingItem(owner, {
    id: bi.lift, kind: 'lift', per_floor: ''
  }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, {
    id: bi.lift, kind: 'lift', name: 'Подъём', active: 'нет'
  }).ok, false);
  // Разрешён только код НФ
  assert.ok(ctx.api.saveBillingItem(owner, { id: bi.lift, kind: 'lift', ext_code: 'LIFT-1' }).ok);
  assert.strictEqual(
    ctx.api.listBillingItems(owner).items.find(i => i.id === bi.lift).ext_code, 'LIFT-1');
  inv = invoice(ctx, owner, 'cli_l');
  assert.strictEqual(line(inv, bi.lift).qty, 2, 'расчёт не изменился');
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
  });
  // P6: setVisitLiftFloor разрешён и водителю — роль проходит, падает на отсутствии визита
  assert.strictEqual(ctx.api.setVisitLiftFloor(worker, 'del_1', 3).error, 'Нет доступа');
  assert.strictEqual(ctx.api.setVisitLiftFloor(driver, 'del_1', 3).error, 'Визит не найден');
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
  assert.strictEqual(before.length, 8, '8 позиций: 7 P2.2 + per_visit «Доставка» (P11)');
  assert.strictEqual(before.filter(i => i.kind === 'wash_weight' && i.active === 'да').length, 1);
  ctx.db.migrateToV4_();
  ctx.db.migrateToV4_();
  assert.strictEqual(ctx.api.listBillingItems(owner).items.length, 8);
});

test('миграция v6: «Доставка» и её тарифы удалены, идемпотентно, чужие прачки не тронуты', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  // Вторая прачка со «старым» прайсом: досидим вручную как было до v6
  ctx.db.appendRow_('Laundries', { id: '2', name: 'П2', active: 'да' });
  ctx.db.appendRowTenant_('BillingItems', {
    id: 'bi_old_trip', name: 'Доставка', unit: 'рейс', kind: 'trip',
    oneway: '', max_kg: '', per_floor: '', ext_code: '', sort: '5', active: 'да'
  }, '2');
  ctx.db.appendRowTenant_('ClientTariffs', {
    id: 'ct_old', client_id: '', billing_item_id: 'bi_old_trip', price: '300'
  }, '2');
  ctx.db.appendRowTenant_('BillingItems', {
    id: 'bi_old_light', name: 'Доставка менее 30 кг', unit: 'рейс', kind: 'trip',
    oneway: '', max_kg: '30', per_floor: '', ext_code: '', sort: '6', active: 'да'
  }, '2');

  ctx.db.migrateToV6_();
  let items2 = ctx.db.readAllByTenant_('BillingItems', '2');
  assert.strictEqual(items2.find(i => i.id === 'bi_old_trip'), undefined, 'plain-trip удалена');
  assert.ok(items2.find(i => i.id === 'bi_old_light'), 'пороговая на месте');
  assert.strictEqual(
    ctx.db.readAllByTenant_('ClientTariffs', '2').filter(t => t.billing_item_id === 'bi_old_trip').length,
    0, 'тарифы удалённой позиции удалены');
  // Прачка 1 (уже на v6) не тронута; список глобальный (v7): 8 + пороговая прачки 2
  assert.strictEqual(ctx.api.listBillingItems(owner).items.length, 9);
  // Повторный запуск — без изменений
  ctx.db.migrateToV6_();
  assert.strictEqual(ctx.db.readAllByTenant_('BillingItems', '2').length, items2.length);
  assert.strictEqual(ctx.api.listBillingItems(owner).items.length, 9);
  // Пороговая позиция прачки 1 — та же, что в хелпере
  assert.ok(ctx.api.listBillingItems(owner).items.find(i => i.id === bi.light));
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

test('saveBillingItem: валидация вида/названия; единица выводится из kind', () => {
  const { ctx, owner } = mkBillingCtx();
  assert.strictEqual(ctx.api.saveBillingItem(owner, { name: 'X', kind: 'bogus' }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, { name: '  ', kind: 'wash_pcs' }).ok, false);
  const r = ctx.api.saveBillingItem(owner, { name: 'Услуги (Махра)', kind: 'wash_pcs' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.item.unit, 'шт', 'единица выставлена по kind, селекта единицы больше нет');
});

test('saveBillingItem/deleteBillingItem: trip и lift фиксированы (P2.2)', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  // Создание закрыто
  assert.strictEqual(ctx.api.saveBillingItem(owner, { name: 'Рейс', kind: 'trip' }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, { name: 'Подъём', kind: 'lift' }).ok, false);
  // Удаление закрыто (системные)
  assert.strictEqual(ctx.api.deleteBillingItem(owner, bi.light).ok, false);
  assert.strictEqual(ctx.api.deleteBillingItem(owner, bi.oneway).ok, false);
  assert.strictEqual(ctx.api.deleteBillingItem(owner, bi.lift).ok, false);
  // Переименование/деактивация системной oneway — ошибка
  assert.strictEqual(ctx.api.saveBillingItem(owner, {
    id: bi.oneway, kind: 'trip', name: 'Забор'
  }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, {
    id: bi.oneway, kind: 'trip', active: 'нет'
  }).ok, false);
  // Код НФ — разрешён
  assert.ok(ctx.api.saveBillingItem(owner, { id: bi.oneway, kind: 'trip', ext_code: 'DLV-1' }).ok);
  // P11: per_visit «Доставка» — тоже системная: только код НФ, архивация/переименование закрыты
  assert.strictEqual(ctx.api.deleteBillingItem(owner, bi.round).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, {
    id: bi.round, kind: 'trip', active: 'нет'
  }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, {
    id: bi.round, kind: 'trip', name: 'Рейс'
  }).ok, false);
  assert.ok(ctx.api.saveBillingItem(owner, { id: bi.round, kind: 'trip', ext_code: 'DLV-2' }).ok);
});

test('пороговая позиция: смена порога 30 → 20 пересчитывает счёт и имя', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_th');
  ctx.api.saveTariff(owner, '', bi.light, 300);

  // Двуногие визиты 25 кг и 15 кг
  const w25 = addWash(ctx, { client_id: 'cli_th', wash_date: '2026-08-03', status: 'issued', kg: 25, issued_at: '2026-08-04 12:00:00' });
  addVisit(ctx, { client_id: 'cli_th', date: '2026-08-04', picked_at: '2026-08-04 10:00:00', delivered_at: '2026-08-04 12:00:00' });
  addDirtyStorage(ctx, 'cli_th', '2026-08-04', w25);
  const w15 = addWash(ctx, { client_id: 'cli_th', wash_date: '2026-08-05', status: 'issued', kg: 15, issued_at: '2026-08-06 12:00:00' });
  addVisit(ctx, { client_id: 'cli_th', date: '2026-08-06', picked_at: '2026-08-06 10:00:00', delivered_at: '2026-08-06 12:00:00' });
  addDirtyStorage(ctx, 'cli_th', '2026-08-06', w15);

  let inv = invoice(ctx, owner, 'cli_th');
  assert.strictEqual(line(inv, bi.light).qty, 4, 'при N=30 обе партии тарифицируются');
  assert.strictEqual(line(inv, bi.light).name, 'Доставка менее 30 кг');

  // Порог 0 / не число — ошибка
  assert.strictEqual(ctx.api.saveBillingItem(owner, { id: bi.light, kind: 'trip', max_kg: '0' }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, { id: bi.light, kind: 'trip', max_kg: 'abc' }).ok, false);

  // 30 → 20: 25 кг перестаёт тарифицироваться, 15 кг — остаётся
  const r = ctx.api.saveBillingItem(owner, { id: bi.light, kind: 'trip', max_kg: '20' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.item.name, 'Доставка менее 20 кг', 'имя генерируется из N');
  inv = invoice(ctx, owner, 'cli_th');
  assert.strictEqual(line(inv, bi.light).qty, 2, 'только партия 15 кг × 2 ноги');
  assert.strictEqual(line(inv, bi.light).name, 'Доставка менее 20 кг');
});

test('per-клиентский порог доставки: max_kg в ClientTariffs перекрывает дефолт', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_th2');
  ctx.api.saveTariff(owner, '', bi.light, 300);

  // Двуногий визит с партией 40 кг
  const w40 = addWash(ctx, { client_id: 'cli_th2', wash_date: '2026-08-03', status: 'issued', kg: 40, issued_at: '2026-08-04 12:00:00' });
  addVisit(ctx, { client_id: 'cli_th2', date: '2026-08-04', picked_at: '2026-08-04 10:00:00', delivered_at: '2026-08-04 12:00:00' });
  addDirtyStorage(ctx, 'cli_th2', '2026-08-04', w40);

  // Дефолт 30: 40 кг — бесплатно, строки нет
  let inv = invoice(ctx, owner, 'cli_th2');
  assert.strictEqual(line(inv, bi.light), undefined);

  // Валидация порога
  assert.strictEqual(ctx.api.saveTariff(owner, 'cli_th2', bi.light, 300, '0').ok, false);
  assert.strictEqual(ctx.api.saveTariff(owner, 'cli_th2', bi.light, 300, 'abc').ok, false);
  // Порог нельзя задать глобальному дефолту и непороговой позиции
  assert.strictEqual(ctx.api.saveTariff(owner, '', bi.light, 300, '45').ok, false);
  assert.strictEqual(ctx.api.saveTariff(owner, 'cli_th2', bi.robe, 100, '45').ok, false);

  // Клиентский порог 45: 40 кг тарифицируется, имя строки из N клиента
  const r = ctx.api.saveTariff(owner, 'cli_th2', bi.light, '', '45');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.tariff.price, '', 'цена не задана — наследует дефолт');
  assert.strictEqual(r.tariff.max_kg, '45');
  inv = invoice(ctx, owner, 'cli_th2');
  assert.strictEqual(line(inv, bi.light).qty, 2, 'обе ноги тарифицируются');
  assert.strictEqual(line(inv, bi.light).name, 'Доставка менее 45 кг');
  assert.strictEqual(line(inv, bi.light).price, 300, 'цена — глобальный дефолт');

  // Смена цены без maxKg (undefined) не затирает порог
  assert.ok(ctx.api.saveTariff(owner, 'cli_th2', bi.light, 350).ok);
  inv = invoice(ctx, owner, 'cli_th2');
  assert.strictEqual(line(inv, bi.light).name, 'Доставка менее 45 кг');
  assert.strictEqual(line(inv, bi.light).price, 350);

  // Снятие цены при заданном пороге не удаляет строку тарифа
  assert.ok(ctx.api.saveTariff(owner, 'cli_th2', bi.light, '').ok);
  assert.strictEqual(
    ctx.api.listTariffs(owner, 'cli_th2').tariffs
      .find(t => t.billing_item_id === bi.light && t.client_id === 'cli_th2').max_kg,
    '45');

  // Снятие порога ('') → возврат к дефолту 30: 40 кг снова бесплатно
  assert.ok(ctx.api.saveTariff(owner, 'cli_th2', bi.light, '', '').ok);
  assert.strictEqual(
    ctx.api.listTariffs(owner, 'cli_th2').tariffs
      .find(t => t.billing_item_id === bi.light && t.client_id === 'cli_th2'),
    undefined, 'пустые цена и порог — строка удалена');
  inv = invoice(ctx, owner, 'cli_th2');
  assert.strictEqual(line(inv, bi.light), undefined);
});

test('минимум кг в счёте: min_kg весовой позиции поднимает итог периода', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_min');
  ctx.api.saveTariff(owner, '', bi.weight, 100);

  // Валидация: только целое > 0 (или пусто)
  assert.strictEqual(ctx.api.saveBillingItem(owner, { id: bi.weight, kind: 'wash_weight', min_kg: 'abc' }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, { id: bi.weight, kind: 'wash_weight', min_kg: '-5' }).ok, false);
  assert.strictEqual(ctx.api.saveBillingItem(owner, { id: bi.weight, kind: 'wash_weight', min_kg: '3.5' }).ok, false);

  // Минимум 14: 5 кг → в счёт 14 кг
  const r = ctx.api.saveBillingItem(owner, { id: bi.weight, kind: 'wash_weight', min_kg: '14' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.item.min_kg, '14');
  addWash(ctx, { client_id: 'cli_min', wash_date: '2026-08-03', status: 'issued', kg: 5, issued_at: '2026-08-04 12:00:00' });
  let inv = invoice(ctx, owner, 'cli_min');
  assert.strictEqual(line(inv, bi.weight).qty, 14);
  assert.strictEqual(line(inv, bi.weight).amount, 1400);

  // Больше минимума — не режется
  addWash(ctx, { client_id: 'cli_min', wash_date: '2026-08-05', status: 'issued', kg: 20, issued_at: '2026-08-06 12:00:00' });
  inv = invoice(ctx, owner, 'cli_min');
  assert.strictEqual(line(inv, bi.weight).qty, 25, '5 + 20 = 25 > 14');

  // Стирок нет — минимум не выставляется
  addClient(ctx, 'cli_min0');
  inv = invoice(ctx, owner, 'cli_min0');
  assert.strictEqual(line(inv, bi.weight), undefined);

  // Форма прайса (без min_kg) не затирает минимум
  assert.ok(ctx.api.saveBillingItem(owner, {
    id: bi.weight, kind: 'wash_weight', name: 'Услуги прачечной (постельное бельё)',
    ext_code: '', active: 'да'
  }).ok);
  assert.strictEqual(ctx.api.listBillingItems(owner).items.find(i => i.id === bi.weight).min_kg, '14');

  // Снятие минимума: 5 + 20 = 25 кг как есть
  assert.ok(ctx.api.saveBillingItem(owner, { id: bi.weight, kind: 'wash_weight', min_kg: '' }).ok);
  inv = invoice(ctx, owner, 'cli_min');
  assert.strictEqual(line(inv, bi.weight).qty, 25);
});

test('migrateToV4_: повторный запуск не дублирует прайс (v7 — прайс глобальный)', () => {
  const { ctx } = mkBillingCtx(); // 7 глобальных позиций из openTest
  // Прайс глобальный: новые прачки не получают свои копии, повторный запуск — no-op.
  ctx.db.appendRow_('Laundries', { id: '2', name: 'П2', active: 'да' });
  ctx.db.appendRow_('Laundries', { id: '3', name: 'П3', active: 'да' });
  ctx.db.migrateToV4_();
  assert.strictEqual(ctx.db.readAll_('BillingItems').length, 8, 'прайс один на все прачки');
  ctx.db.migrateToV4_();
  assert.strictEqual(ctx.db.readAll_('BillingItems').length, 8);
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
  // Надбавка водителя: этажи × его ставка, от прайса не зависит
  assert.strictEqual(r.stats.lift_pay, 400, '(3+1) этажа × дефолтные 100 ₽');

  // Персональная ставка в PayRates переопределяет дефолт
  const drv = ctx.db.findRowsBy_('Users', function (u) { return u.role === 'driver'; }, 10)[0].obj;
  assert.ok(ctx.api.savePayRate(owner, drv.id, { lift_floor_rate: '150' }).ok);
  const r1 = ctx.api.getDriverRoute(driver, d);
  assert.strictEqual(r1.stats.lift_pay, 600, '(3+1) этажа × 150 ₽');
  assert.strictEqual(r1.stats.lift_total, 800, 'цена по прайсу не изменилась');
  assert.ok(ctx.api.savePayRate(owner, drv.id, { lift_floor_rate: '' }).ok);

  // Цену сняли — сумма по прайсу не считается, надбавка водителя считается
  ctx.api.saveTariff(owner, '', bi.lift, '');
  const r2 = ctx.api.getDriverRoute(driver, d);
  assert.strictEqual(r2.stats.lift_total, 0);
  assert.strictEqual(r2.stats.lift_missing, true);
  assert.strictEqual(r2.stats.lift_pay, 400);
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

// --- P11: платная доставка для части клиентов (per_visit «Доставка») ---

test('P11 тип А: полный рейс ≥ порога → 1 × «Доставка», пороговой и oneway строк нет', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_pd', 'Платный', { paid_delivery: 'да' });
  [bi.light, bi.oneway].forEach(id => ctx.api.saveTariff(owner, '', id, 300));
  ctx.api.saveTariff(owner, '', bi.round, 500);

  // Двуногий визит, партия 31 кг ≥ порога
  const w = addWash(ctx, { client_id: 'cli_pd', wash_date: '2026-08-03', status: 'issued', kg: 31, issued_at: '2026-08-04 12:00:00' });
  addVisit(ctx, { client_id: 'cli_pd', date: '2026-08-04', picked_at: '2026-08-04 10:00:00', delivered_at: '2026-08-04 12:00:00' });
  addDirtyStorage(ctx, 'cli_pd', '2026-08-04', w);

  const inv = invoice(ctx, owner, 'cli_pd');
  assert.deepStrictEqual(
    { qty: line(inv, bi.round).qty, price: line(inv, bi.round).price, amount: line(inv, bi.round).amount },
    { qty: 1, price: 500, amount: 500 });
  assert.strictEqual(line(inv, bi.round).name, 'Доставка');
  assert.strictEqual(line(inv, bi.light), undefined, 'порог к типу А не применяется');
  assert.strictEqual(line(inv, bi.oneway), undefined, 'oneway к типу А не применяется');
});

test('P11 тип А: рейс в одну сторону → 1 × «Доставка», oneway нет', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_pd1', undefined, { paid_delivery: 'да' });
  ctx.api.saveTariff(owner, '', bi.round, 500);
  ctx.api.saveTariff(owner, '', bi.oneway, 300);

  addVisit(ctx, { client_id: 'cli_pd1', date: '2026-08-08', picked_at: '2026-08-08 10:00:00' });

  const inv = invoice(ctx, owner, 'cli_pd1');
  assert.strictEqual(line(inv, bi.round).qty, 1, 'один рейс = одна цена, нога не удешевляет');
  assert.strictEqual(line(inv, bi.oneway), undefined);
});

test('P11 тип А без цены на «Доставку» → missing_prices, строка с amount null', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_pd0', undefined, { paid_delivery: 'да' });

  addVisit(ctx, { client_id: 'cli_pd0', date: '2026-08-08', picked_at: '2026-08-08 10:00:00', delivered_at: '2026-08-08 12:00:00' });

  const inv = invoice(ctx, owner, 'cli_pd0');
  assert.strictEqual(line(inv, bi.round).price, null);
  assert.strictEqual(line(inv, bi.round).amount, null);
  assert.deepStrictEqual(inv.missing_prices, [bi.round]);
});

test('P11 регрессия типа Б: без галочки счёт построчно как до тикета', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_b1');
  [bi.light, bi.oneway].forEach(id => ctx.api.saveTariff(owner, '', id, 300));
  ctx.api.saveTariff(owner, '', bi.round, 500, 'дефолтная цена «Доставки» задана, но тип Б её не ловит');

  // Полный рейс ≥ порога → доставки нет
  const w1 = addWash(ctx, { client_id: 'cli_b1', wash_date: '2026-08-03', status: 'issued', kg: 31, issued_at: '2026-08-04 12:00:00' });
  addVisit(ctx, { client_id: 'cli_b1', date: '2026-08-04', picked_at: '2026-08-04 10:00:00', delivered_at: '2026-08-04 12:00:00' });
  addDirtyStorage(ctx, 'cli_b1', '2026-08-04', w1);
  // Ноги < порога → 2 × пороговая
  const w2 = addWash(ctx, { client_id: 'cli_b1', wash_date: '2026-08-05', status: 'issued', kg: 29, issued_at: '2026-08-06 12:00:00' });
  addVisit(ctx, { client_id: 'cli_b1', date: '2026-08-06', picked_at: '2026-08-06 10:00:00', delivered_at: '2026-08-06 12:00:00' });
  addDirtyStorage(ctx, 'cli_b1', '2026-08-06', w2);
  // Одна нога → oneway
  addVisit(ctx, { client_id: 'cli_b1', date: '2026-08-08', picked_at: '2026-08-08 10:00:00' });

  const inv = invoice(ctx, owner, 'cli_b1');
  assert.strictEqual(line(inv, bi.round), undefined, 'per_visit-позиция не попадает в пул ног');
  assert.strictEqual(line(inv, bi.light).qty, 2);
  assert.strictEqual(line(inv, bi.oneway).qty, 1);
  const tripLines = inv.lines.filter(l =>
    ctx.api.listBillingItems(owner).items.find(i => i.id === l.billing_item_id).kind === 'trip');
  assert.strictEqual(tripLines.length, 2);
});

test('P11: planned/cancelled/empty визиты не дают доставочных строк в обоих режимах', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_npd');
  addClient(ctx, 'cli_pdx', undefined, { paid_delivery: 'да' });
  ctx.api.saveTariff(owner, '', bi.round, 500);
  ctx.api.saveTariff(owner, '', bi.oneway, 300);

  ['cli_npd', 'cli_pdx'].forEach(cid => {
    addVisit(ctx, { client_id: cid, date: '2026-08-03', status: 'planned' });
    addVisit(ctx, { client_id: cid, date: '2026-08-04', status: 'cancelled', picked_at: '2026-08-04 10:00:00' });
    addVisit(ctx, { client_id: cid, date: '2026-08-05', status: 'empty', delivered_at: '2026-08-05 12:00:00' });
  });

  ['cli_npd', 'cli_pdx'].forEach(cid => {
    const inv = invoice(ctx, owner, cid);
    const tripLines = inv.lines.filter(l =>
      ctx.api.listBillingItems(owner).items.find(i => i.id === l.billing_item_id).kind === 'trip');
    assert.strictEqual(tripLines.length, 0, 'у ' + cid + ' нет доставочных строк');
  });
});

test('P11: лифт считается одинаково у типа А и типа Б', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_lb');
  addClient(ctx, 'cli_la', undefined, { paid_delivery: 'да' });
  ctx.api.saveTariff(owner, '', bi.lift, 300);
  ctx.api.saveTariff(owner, '', bi.round, 500);
  ctx.api.saveTariff(owner, '', bi.oneway, 100);

  ['cli_lb', 'cli_la'].forEach(cid => {
    addVisit(ctx, { client_id: cid, date: '2026-08-03', delivered_at: '2026-08-03 12:00:00', lift_floor: '4' });
  });

  const invB = invoice(ctx, owner, 'cli_lb');
  const invA = invoice(ctx, owner, 'cli_la');
  assert.strictEqual(line(invB, bi.lift).qty, 2);
  assert.strictEqual(line(invA, bi.lift).qty, 2);
  assert.strictEqual(line(invA, bi.round).qty, 1, 'у типа А тот же визит даёт и рейс');
  assert.strictEqual(line(invB, bi.round), undefined);
});

test('P11 миграция v12: позиция создаётся, идемпотентно, свежая установка — без дубля', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  const items = () => ctx.api.listBillingItems(owner).items;
  // Свежая установка: сид уже содержит позицию — прогон миграции no-op
  assert.strictEqual(items().filter(i => i.kind === 'trip' && i.per_visit === 'да').length, 1);
  ctx.db.migrateToV12_();
  assert.strictEqual(items().filter(i => i.per_visit === 'да').length, 1, 'повторный прогон без дубля');

  // Старая БД без позиции: удаляем и возвращаем sort'ы к раскладке до P11
  // (7 позиций: пороговая=5, oneway=6, lift=7)
  const found = ctx.db.findById_('BillingItems', bi.round);
  ctx.db.deleteRow_('BillingItems', found.rowNumber);
  [bi.oneway, bi.lift].forEach(function (id, i) {
    const f = ctx.db.findById_('BillingItems', id);
    f.obj.sort = String(6 + i);
    ctx.db.updateRow_('BillingItems', f.rowNumber, f.obj);
  });
  assert.strictEqual(items().filter(i => i.per_visit === 'да').length, 0);
  ctx.db.migrateToV12_();
  const after = items();
  assert.strictEqual(after.filter(i => i.kind === 'trip' && i.per_visit === 'да').length, 1, 'позиция создана');
  const created = after.find(i => i.per_visit === 'да');
  assert.strictEqual(created.name, 'Доставка');
  assert.strictEqual(created.unit, 'рейс');
  assert.strictEqual(created.active, 'да');
  // Сразу после пороговой: пороговая sort=5, новая sort=6, нижестоящие сдвинуты
  const light = after.find(i => i.id === bi.light);
  assert.strictEqual(Number(created.sort), Number(light.sort) + 1);
  const sorts = after.map(i => Number(i.sort)).sort((a, b) => a - b);
  assert.deepStrictEqual(sorts, [1, 2, 3, 4, 5, 6, 7, 8], 'sort непрерывен, без сдвиговых дыр');
  // Повторный прогон — без дубля
  ctx.db.migrateToV12_();
  assert.strictEqual(items().filter(i => i.per_visit === 'да').length, 1);
});

test('P11: per-клиентская цена на «Доставку» перекрывает дефолт', () => {
  const { ctx, owner, bi } = mkBillingCtx();
  addClient(ctx, 'cli_pa', undefined, { paid_delivery: 'да' });
  addClient(ctx, 'cli_pb', undefined, { paid_delivery: 'да' });
  ctx.api.saveTariff(owner, '', bi.round, 500);
  ctx.api.saveTariff(owner, 'cli_pa', bi.round, 700);

  ['cli_pa', 'cli_pb'].forEach(cid => {
    addVisit(ctx, { client_id: cid, date: '2026-08-03', delivered_at: '2026-08-03 12:00:00' });
  });

  assert.strictEqual(line(invoice(ctx, owner, 'cli_pa'), bi.round).price, 700, 'переопределение клиента');
  assert.strictEqual(line(invoice(ctx, owner, 'cli_pb'), bi.round).price, 500, 'дефолт прачки');
});
