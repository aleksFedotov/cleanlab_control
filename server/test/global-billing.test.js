// Тесты глобального прайса (v7): позиции BillingItems и дефолтные тарифы
// общие для всех прачек; клиентские переопределения цен остаются per-прачка.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, seedLaundry2 } = require('./helpers/serverMocks');

function billingCtx() {
  const ctx = makeCtx();
  const owner = loginOwner();
  const items = ctx.api.listBillingItems(owner).items;
  return { ctx, owner, robe: items.find(i => i.name.indexOf('Халат') !== -1).id };
}

test('позиция, созданная в прачке 1, видна и редактируется из прачки 2', () => {
  const { ctx, owner } = billingCtx();
  seedLaundry2();

  const created = ctx.api.saveBillingItem(owner, { name: 'Услуги (Плед)', kind: 'wash_pcs' });
  assert.ok(created.ok, created.error);
  assert.strictEqual(created.item.laundry_id, '', 'позиция глобальная');

  ctx.auth.switchLaundry(owner, '2');
  const fromL2 = ctx.api.listBillingItems(owner).items;
  assert.ok(fromL2.find(i => i.id === created.item.id), 'видна из прачки 2');

  const edited = ctx.api.saveBillingItem(owner, { id: created.item.id, kind: 'wash_pcs', name: 'Услуги (Плед новый)' });
  assert.ok(edited.ok, edited.error);

  ctx.auth.switchLaundry(owner, '1');
  const fromL1 = ctx.api.listBillingItems(owner).items;
  assert.strictEqual(fromL1.find(i => i.id === created.item.id).name, 'Услуги (Плед новый)');
});

test('дефолтный тариф глобальный; клиентское переопределение — per-прачка', () => {
  const { ctx, owner, robe } = billingCtx();
  seedLaundry2();
  ctx.db.appendRowTenant_('Clients', {
    id: 'cli_a', name: 'A', contact: '', address: '', type: 'отель', active: 'да',
    comment: '', item_types: '', accounting: '', inn: '', kpp: '', legal_address: ''
  }, '1');
  ctx.db.invalidateRefCache_();

  // Дефолт из прачки 1
  assert.ok(ctx.api.saveTariff(owner, '', robe, 100).ok);
  // Переопределение клиента прачки 1
  assert.ok(ctx.api.saveTariff(owner, 'cli_a', robe, 80).ok);

  ctx.auth.switchLaundry(owner, '2');
  const tariffsL2 = ctx.api.listTariffs(owner).tariffs;
  const def = tariffsL2.find(t => !t.client_id && t.billing_item_id === robe);
  assert.ok(def && def.price === '100', 'дефолт виден из прачки 2');
  assert.strictEqual(def.laundry_id, '', 'дефолт глобальный');
  assert.strictEqual(tariffsL2.filter(t => t.client_id === 'cli_a').length, 0,
    'чужое клиентское переопределение не утекает');

  // Правка дефолта из прачки 2 — та же строка
  assert.ok(ctx.api.saveTariff(owner, '', robe, 120).ok);
  ctx.auth.switchLaundry(owner, '1');
  const tariffsL1 = ctx.api.listTariffs(owner).tariffs;
  assert.strictEqual(tariffsL1.filter(t => !t.client_id && t.billing_item_id === robe).length, 1);
  assert.strictEqual(tariffsL1.find(t => !t.client_id && t.billing_item_id === robe).price, '120');
});

test('миграция v7: дубли позиций сливаются, ссылки ремапятся, идемпотентно', () => {
  const { ctx, robe } = billingCtx();
  // «Старый» per-прачечный дубль позиции «Халат» в прачке 2
  ctx.db.appendRowTenant_('BillingItems', {
    id: 'bi_dup_robe', name: 'Услуги прачечной (Халат)', unit: 'шт', kind: 'wash_pcs',
    oneway: '', max_kg: '', per_floor: '', ext_code: '', sort: '2', active: 'да'
  }, '2');
  ctx.db.appendRowTenant_('ClientTariffs', {
    id: 'ct_dup', client_id: 'cli_x', billing_item_id: 'bi_dup_robe', price: '90'
  }, '2');
  ctx.db.appendRowTenant_('ClientTariffs', {
    id: 'ct_def_dup', client_id: '', billing_item_id: 'bi_dup_robe', price: '100'
  }, '2');
  ctx.db.appendRowTenant_('ClientTariffs', {
    id: 'ct_def_canon', client_id: '', billing_item_id: robe, price: '110'
  }, '1');
  // Привязка типа белья к дублю
  ctx.db.appendRow_('ItemTypes', {
    id: 'itm_dup', name: 'Халат дубль', sort: '99', active: 'да', billing_item_id: 'bi_dup_robe'
  });
  ctx.db.invalidateRefCache_();

  ctx.db.migrateToV7_();

  const items = ctx.db.readAll_('BillingItems');
  assert.strictEqual(items.length, 7, 'дубль слит');
  assert.ok(items.every(i => i.laundry_id === ''), 'все позиции глобальные');
  assert.strictEqual(ctx.db.findById_('BillingItems', 'bi_dup_robe'), null);

  // Ссылки ремапнуты на канонический id
  const t = ctx.db.readAll_('ClientTariffs');
  assert.strictEqual(t.find(x => x.id === 'ct_dup').billing_item_id, robe, 'тариф клиента ремапнут');
  assert.strictEqual(ctx.db.findById_('ItemTypes', 'itm_dup').obj.billing_item_id, robe);
  // Дефолтные тарифы дедупнуты глобально: осталась одна строка на позицию
  const defRows = t.filter(x => !x.client_id && x.billing_item_id === robe);
  assert.strictEqual(defRows.length, 1, 'дефолт один глобально');
  assert.strictEqual(defRows[0].laundry_id, '');

  // Идемпотентность
  ctx.db.migrateToV7_();
  assert.strictEqual(ctx.db.readAll_('BillingItems').length, 7);
  assert.strictEqual(ctx.db.readAll_('ClientTariffs').filter(x => x.billing_item_id === robe).length,
    t.filter(x => x.billing_item_id === robe).length);
});
