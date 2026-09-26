// Тесты клиентского портала (тикет P1, этап 1): вход роли client +
// setClientAccess/resetClientPassword из карточки клиента.
const test = require('node:test');
const assert = require('node:assert');
const {
  makeCtx, loginOwner, seedLaundry2
} = require('./helpers/serverMocks');

function seedClient(ctx, owner, name) {
  const res = ctx.api.saveClient(owner, { name: name || 'Отель А', type: 'отель' });
  assert.ok(res.ok);
  return res.client.id;
}

function clientUsers(ctx) {
  return ctx.db.readAll_('Users').filter(function (u) { return u.role === 'client'; });
}

test('setClientAccess создаёт аккаунт; вход по логину/паролю ok, сессия с laundryId и clientId', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);

  const r = ctx.api.setClientAccess(owner, clientId, 'otel-a', 'secret-pass');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.user.role, 'client');
  assert.strictEqual(r.user.client_id, clientId);
  assert.strictEqual(clientUsers(ctx).length, 1);

  const login = ctx.auth.login('otel-a', 'secret-pass');
  assert.ok(login.ok, login.error);
  assert.strictEqual(login.role, 'client');
  assert.strictEqual(login.laundryId, '1');
  const session = ctx.auth.getSession_(login.token);
  assert.strictEqual(session.clientId, clientId);
  assert.strictEqual(session.laundryId, '1');
});

test('повторный setClientAccess для того же клиента — обновление, а не дубль', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  assert.ok(ctx.api.setClientAccess(owner, clientId, 'otel-a', 'pass-1').ok);

  const r = ctx.api.setClientAccess(owner, clientId, 'otel-a-2', 'pass-2');
  assert.ok(r.ok, r.error);
  assert.strictEqual(clientUsers(ctx).length, 1);
  assert.strictEqual(clientUsers(ctx)[0].login, 'otel-a-2');

  const old = ctx.auth.login('otel-a', 'pass-1');
  assert.strictEqual(old.ok, false);
  const fresh = ctx.auth.login('otel-a-2', 'pass-2');
  assert.ok(fresh.ok, fresh.error);
});

test('логин, занятый другим пользователем, отклоняется; свой прежний — можно', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const a = seedClient(ctx, owner, 'Отель А');
  const b = seedClient(ctx, owner, 'Отель Б');
  assert.ok(ctx.api.setClientAccess(owner, a, 'otel-a', 'pass-1').ok);

  const taken = ctx.api.setClientAccess(owner, b, 'otel-a', 'pass-2');
  assert.strictEqual(taken.ok, false);
  assert.strictEqual(taken.error, 'Логин уже занят');

  const own = ctx.api.setClientAccess(owner, a, 'otel-a', 'pass-3');
  assert.ok(own.ok, own.error);
});

test('clientId другой прачки не принимается (tenant-изоляция)', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  seedLaundry2();
  const mine = seedClient(ctx, owner, 'Отель А');
  const other = ctx.db.appendRowTenant_('Clients', {
    id: 'cli_2', name: 'Чужой клиент', contact: '', address: '', type: 'отель',
    active: 'да', comment: '', item_types: '', accounting: '', inn: '', kpp: '',
    legal_address: '', access_note: '', paid_delivery: ''
  }, '2');

  const r = ctx.api.setClientAccess(owner, other, 'chuzhoy', 'pass');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Клиент не найден');

  const okR = ctx.api.setClientAccess(owner, mine, 'moy', 'pass');
  assert.ok(okR.ok, okR.error);
});

test('resetClientPassword: старый пароль перестаёт работать, новый — работает', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  assert.ok(ctx.api.setClientAccess(owner, clientId, 'otel-a', 'old-pass').ok);

  const r = ctx.api.resetClientPassword(owner, clientId, 'new-pass');
  assert.ok(r.ok, r.error);

  assert.strictEqual(ctx.auth.login('otel-a', 'old-pass').ok, false);
  assert.ok(ctx.auth.login('otel-a', 'new-pass').ok);
});

test('resetClientPassword без аккаунта — «Доступ в портал не настроен»', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const r = ctx.api.resetClientPassword(owner, clientId, 'pass');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Доступ в портал не настроен');
});

test('деактивация аккаунта client обесценивает сессию', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  const created = ctx.api.setClientAccess(owner, clientId, 'otel-a', 'pass');
  assert.ok(created.ok);
  const token = ctx.auth.login('otel-a', 'pass').token;
  assert.ok(ctx.auth.getSession_(token));

  assert.ok(ctx.api.deactivateUser(owner, created.user.id).ok);
  assert.strictEqual(ctx.auth.getSession_(token), null);
  assert.strictEqual(ctx.auth.login('otel-a', 'pass').ok, false);
});

test('матрица прав: client не может существующие методы прачки', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);
  assert.ok(ctx.api.setClientAccess(owner, clientId, 'otel-a', 'pass').ok);
  const token = ctx.auth.login('otel-a', 'pass').token;

  assert.strictEqual(ctx.api.getDayReport(token).ok, false);
  assert.strictEqual(ctx.api.getDayReport(token).error, 'Нет доступа');
  assert.strictEqual(ctx.api.getWeekPlan(token).ok, false);
  assert.strictEqual(ctx.api.listUsers(token).ok, false);
  assert.strictEqual(ctx.api.saveClient(token, { name: 'X' }).ok, false);
});

test('setClientAccess валидирует пустые логин/пароль и пишет события в Log', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, owner);

  assert.strictEqual(ctx.api.setClientAccess(owner, clientId, '', 'p').error, 'Укажите логин');
  assert.strictEqual(ctx.api.setClientAccess(owner, clientId, 'l', '').error, 'Укажите пароль');

  assert.ok(ctx.api.setClientAccess(owner, clientId, 'otel-a', 'pass').ok);
  const events = ctx.db.readAll_('Log').filter(function (e) { return e.action === 'user_create'; });
  assert.strictEqual(events.length, 1);
});
