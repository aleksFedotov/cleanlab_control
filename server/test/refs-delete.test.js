// Тесты физического удаления справочников (purgeClient / deleteItemType)
// и возврата клиента из архива. Поверх SQLite, хелперы — как в api.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, TODAY, TOMORROW } = require('./helpers/serverMocks');

function seedClient(ctx, over = {}) {
  const res = ctx.api.saveClient(loginOwner(), Object.assign({ name: 'Отель Б', type: 'отель' }, over));
  assert.ok(res.ok);
  return res.client.id;
}

function pieceItemId(ctx, owner) {
  const items = ctx.api.listBillingItems(owner).items;
  return items.find((b) => b.kind === 'wash_pcs').id;
}

test('purgeClient: чистый клиент удаляется, тарифы и привязки чистятся каскадно', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  const bid = pieceItemId(ctx, owner);
  assert.ok(ctx.api.saveTariff(owner, clientId, bid, '25').ok);
  assert.ok(ctx.api.saveClientItemBilling(owner, clientId, 'itm_1', bid).ok);

  const res = ctx.api.purgeClient(owner, clientId);
  assert.ok(res.ok);
  const refs = ctx.api.getRefs(owner);
  assert.ok(!refs.clients.some((c) => c.id === clientId));
  // Каскад: ни тарифов, ни привязок этого клиента не осталось
  const tariffs = ctx.api.listTariffs(owner, clientId).tariffs;
  assert.ok(!tariffs.some((t) => t.client_id === clientId));
  assert.strictEqual(ctx.api.listClientItemBilling(owner, clientId).bindings.length, 0);
});

test('purgeClient: клиент со стиркой/визитом не удаляется — только архив', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  assert.ok(ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).ok); // стирка + визит
  const res = ctx.api.purgeClient(owner, clientId);
  assert.ok(!res.ok);
  assert.match(res.error, /архив/);
  // Клиент на месте
  assert.ok(ctx.api.getRefs(owner).clients.some((c) => c.id === clientId));
});

test('purgeClient: worker не может', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  assert.ok(!ctx.api.purgeClient(loginWorker(), clientId).ok);
});

test('клиент возвращается из архива через saveClient active=да', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  ctx.api.deleteClient(owner, clientId);
  assert.strictEqual(ctx.api.getRefs(owner).clients.find((c) => c.id === clientId).active, 'нет');
  const res = ctx.api.saveClient(owner, { id: clientId, active: 'да' });
  assert.ok(res.ok);
  assert.strictEqual(ctx.api.getRefs(owner).clients.find((c) => c.id === clientId).active, 'да');
});

test('deleteItemType: неиспользуемый вид удаляется; worker не может', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const created = ctx.api.saveItemType(owner, { name: 'временный вид' });
  assert.ok(created.ok);
  assert.ok(!ctx.api.deleteItemType(loginWorker(), created.itemType.id).ok);
  assert.ok(ctx.api.deleteItemType(owner, created.itemType.id).ok);
  assert.ok(!ctx.api.getRefs(owner).itemTypes.some((t) => t.id === created.itemType.id));
});

test('deleteItemType: вид привязан у клиента — отказ, только архив', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const created = ctx.api.saveItemType(owner, { name: 'привязанный вид' });
  const clientId = seedClient(ctx, { item_types: [created.itemType.id] });
  assert.ok(clientId);
  const res = ctx.api.deleteItemType(owner, created.itemType.id);
  assert.ok(!res.ok);
  assert.match(res.error, /архив/);
});

test('deleteItemType: per-клиентская привязка к позиции счёта — отказ', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const created = ctx.api.saveItemType(owner, { name: 'вид с привязкой' });
  const clientId = seedClient(ctx);
  const bid = pieceItemId(ctx, owner);
  assert.ok(ctx.api.saveClientItemBilling(owner, clientId, created.itemType.id, bid).ok);
  assert.ok(!ctx.api.deleteItemType(owner, created.itemType.id).ok);
});
