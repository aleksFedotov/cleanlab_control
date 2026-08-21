// Тесты мультитенантности: изоляция данных прачек, switchLaundry владельца,
// персональные пользователи (в т.ч. задел роли client), TV-ключи per-tenant.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, loginDriver, seedLaundry2, loginWorker2, loginDriver2, TODAY, TOMORROW } = require('./helpers/serverMocks');

// Клиент + стирка + визит в активной прачке владельца
function seedWash(ctx, owner, name) {
  const clientId = ctx.api.saveClient(owner, { name: name }).client.id;
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  return { clientId, washId };
}

test('изоляция: worker прачки 1 не видит и не меняет данные прачки 2', async () => {
  const ctx = makeCtx();
  seedLaundry2();
  const owner = loginOwner();
  // Наполняем прачку 1
  const l1 = seedWash(ctx, owner, 'Клиент прачки 1');
  ctx.api.addDeliveryVisit(owner, l1.clientId, TOMORROW);
  // Переключаемся на прачку 2 и наполняем её
  assert.ok(ctx.auth.switchLaundry(owner, '2').ok);
  const l2 = seedWash(ctx, owner, 'Клиент прачки 2');
  ctx.api.addDeliveryVisit(owner, l2.clientId, TOMORROW);

  const worker1 = loginWorker();
  const worker2 = loginWorker2();

  // День: каждый видит только свою стирку
  const day1 = ctx.api.getDayList(worker1, TODAY);
  assert.deepStrictEqual(day1.washes.map(w => w.id), [l1.washId]);
  const day2 = ctx.api.getDayList(worker2, TODAY);
  assert.deepStrictEqual(day2.washes.map(w => w.id), [l2.washId]);
  assert.strictEqual(day1.laundryName, 'Прачечная PRO');
  assert.strictEqual(day2.laundryName, 'Прачка 2');

  // Чужую стирку нельзя начать/завершить/перенести — она «не найдена»
  assert.ok(!ctx.api.startWash(worker1, l2.washId, 5).ok);
  assert.ok(!ctx.api.deferWash(worker1, l2.washId, '2026-08-14', 'x').ok);
  assert.ok(!ctx.api.confirmStorageCheck(worker1, l2.washId, 'no_dirty').ok);
  assert.strictEqual(ctx.db.findById_('Washes', l2.washId).obj.status, 'planned');

  // Развозы: worker не имеет доступа, но и owner прачки 1 видит только свои визиты
  ctx.auth.switchLaundry(owner, '1');
  const visits1 = ctx.api.getDeliveryVisits(owner, TOMORROW);
  assert.deepStrictEqual(visits1.visits.map(v => v.client_id), [l1.clientId]);

  // Склад: завершаем стирки в обеих прачках — записи не смешиваются
  ctx.api.startWash(worker1, l1.washId);
  ctx.api.completeWash(worker1, l1.washId, [{ item_type_id: 'itm_1', qty: 2 }], 5, null, 1);
  ctx.api.startWash(worker2, l2.washId);
  ctx.api.completeWash(worker2, l2.washId, [{ item_type_id: 'itm_1', qty: 3 }], 7, null, 2);
  ctx.auth.switchLaundry(owner, '1');
  const st1 = ctx.api.getStorage(owner);
  assert.strictEqual(st1.clean.length, 1);
  assert.strictEqual(st1.clean[0].wash_id, l1.washId);
  ctx.auth.switchLaundry(owner, '2');
  const st2 = ctx.api.getStorage(owner);
  assert.strictEqual(st2.clean.length, 1);
  assert.strictEqual(st2.clean[0].wash_id, l2.washId);

  // Смены: закрытие в прачке 1 не трогает смену прачки 2
  ctx.auth.switchLaundry(owner, '1');
  const closed = await ctx.api.closeShift(worker1);
  assert.ok(closed.ok);
  const shifts = ctx.db.readAll_('Shifts');
  const sh1 = shifts.find(s => s.laundry_id === '1');
  const sh2 = shifts.find(s => s.laundry_id === '2');
  assert.strictEqual(sh1.status, 'closed');
  assert.ok(!sh2 || sh2.status !== 'closed');
});

test('owner: switchLaundry меняет активную прачку; worker — не может', () => {
  const ctx = makeCtx();
  seedLaundry2();
  const owner = loginOwner();
  // По умолчанию активна первая прачка
  assert.strictEqual(ctx.auth.getSession_(owner).laundryId, '1');
  const res = ctx.auth.switchLaundry(owner, '2');
  assert.ok(res.ok);
  assert.strictEqual(ctx.auth.getSession_(owner).laundryId, '2');
  // Несуществующую прачку выбрать нельзя
  assert.ok(!ctx.auth.switchLaundry(owner, '99').ok);
  // Работник не может переключаться
  assert.ok(!ctx.auth.switchLaundry(loginWorker(), '2').ok);
  // listLaundries публичен
  const list = ctx.api.listLaundries();
  assert.deepStrictEqual(list.laundries ? list.laundries.map(l => l.id) : list.map(l => l.id), ['1', '2']);
});

test('чужой PIN не пускает: PIN прачки 1 не работает в прачке 2', () => {
  const ctx = makeCtx();
  seedLaundry2();
  assert.ok(!ctx.auth.login('2', '2222').ok);
  assert.ok(!ctx.auth.login('1', '5555').ok);
  assert.ok(ctx.auth.login('2', '5555').ok);
});

test('Log.actor содержит имя и роль пользователя', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = ctx.api.saveClient(owner, { name: 'Отель А' }).client.id;
  ctx.api.addToDelivery(owner, clientId, TODAY, TOMORROW);
  const ev = ctx.db.readAll_('Log').find(e => e.action === 'wash_create');
  assert.ok(/Владелец \(owner\)/.test(ev.actor));
  assert.strictEqual(ev.laundry_id, '1');
});

test('пользователи: createUser проверяет уникальность PIN; роль client не входит', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  // Обычный работник прачки 1
  const u = ctx.api.createUser(owner, { laundryId: '1', name: 'Пётр', role: 'worker', pin: '7777' });
  assert.ok(u.ok);
  assert.ok(ctx.auth.login('1', '7777').ok);
  // Дубль PIN в той же прачке отклонён
  assert.ok(!ctx.api.createUser(owner, { laundryId: '1', name: 'Иван', role: 'driver', pin: '7777' }).ok);
  // PIN владельца занять нельзя
  assert.ok(!ctx.api.createUser(owner, { laundryId: '1', name: 'Иван', role: 'driver', pin: '1111' }).ok);
  // PIN owner глобально уникален
  assert.ok(!ctx.api.createUser(owner, { name: 'Второй владелец', role: 'owner', pin: '7777' }).ok);
  // Роль client требует clientId; вход для неё не настроен
  assert.ok(!ctx.api.createUser(owner, { laundryId: '1', name: 'Клиент', role: 'client', pin: '8888' }).ok);
  const clientId = ctx.api.saveClient(owner, { name: 'Отель А' }).client.id;
  const cu = ctx.api.createUser(owner, { laundryId: '1', name: 'Клиент', role: 'client', pin: '8888', clientId: clientId });
  assert.ok(cu.ok);
  assert.strictEqual(cu.user.client_id, clientId);
  const login = ctx.auth.login('1', '8888');
  assert.ok(!login.ok);
  assert.ok(/не настроен/.test(login.error));
  // Список и деактивация
  const users = ctx.api.listUsers(owner, '1').users;
  assert.ok(users.some(x => x.name === 'Пётр'));
  assert.ok(ctx.api.deactivateUser(owner, u.user.id).ok);
  assert.ok(!ctx.auth.login('1', '7777').ok);
  // Не-owner не может управлять пользователями
  assert.ok(!ctx.api.listUsers(loginWorker(), '1').ok);
});

test('TV-ключи per-tenant: ключ выдаёт данные только своей прачки', () => {
  const ctx = makeCtx();
  seedLaundry2();
  // У прачки 2 свой TV_KEY (у прачки 1 — 'tv-secret' из ENV-сида)
  ctx.db.setTenantSetting_('2', 'TV_KEY', 'tv-secret-2');
  ctx.db.invalidateRefCache_();
  const owner = loginOwner();
  seedWash(ctx, owner, 'Клиент прачки 1');
  ctx.auth.switchLaundry(owner, '2');
  seedWash(ctx, owner, 'Клиент прачки 2');

  const tv1 = ctx.api.getTvData('tv-secret');
  assert.ok(tv1.ok);
  assert.strictEqual(tv1.counters.total, 1);
  assert.strictEqual(tv1.washes[0].client, 'Клиент прачки 1');
  const tv2 = ctx.api.getTvData('tv-secret-2');
  assert.ok(tv2.ok);
  assert.strictEqual(tv2.counters.total, 1);
  assert.strictEqual(tv2.washes[0].client, 'Клиент прачки 2');
  assert.strictEqual(tv2.laundryName, 'Прачка 2');
  assert.ok(!ctx.api.getTvData('чужой-ключ').ok);
});

test('telegram: при двух прачках бот просит уточнить номер, «PIN 2» привязывает к прачке 2', async () => {
  const ctx = makeCtx();
  seedLaundry2();
  // PIN без номера → список прачок
  await ctx.telegram.handleUpdate_({ message: { text: '1111', chat: { id: 555 } } });
  assert.ok(ctx.fetches[0].payload.text.includes('несколько'));
  // «PIN 2» → привязка к прачке 2
  await ctx.telegram.handleUpdate_({ message: { text: '1111 2', chat: { id: 555 } } });
  assert.ok(ctx.fetches[1].payload.text.includes('Прачка 2'));
  assert.strictEqual(ctx.telegram.getOwnerChatId_('2'), '555');
  assert.strictEqual(ctx.telegram.getOwnerChatId_('1'), '');
});
