// Тесты мультитенантности: изоляция данных прачек, switchLaundry владельца,
// персональные пользователи (в т.ч. задел роли client), TV-ключи per-tenant.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, seedUser, loginOwner, loginWorker, loginDriver, seedLaundry2, loginWorker2, loginDriver2, TODAY, TOMORROW } = require('./helpers/serverMocks');

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
  assert.strictEqual(day1.laundryName, 'CleanLab Pro');
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
  // listLaundries — owner-only (вход теперь по логину+паролю, публичный список не нужен)
  assert.ok(!ctx.api.listLaundries().ok);
  assert.ok(!ctx.api.listLaundries(loginWorker()).ok);
  const list = ctx.api.listLaundries(owner);
  assert.deepStrictEqual(list.laundries.map(l => l.id), ['1', '2']);
  // В ответе есть TV-ключи (у прачки 1 — 'tv-secret' из ENV-сида)
  assert.strictEqual(list.laundries[0].tvKey, 'tv-secret');
});

test('прачки из UI: createLaundry создаёт с TV-ключом; deactivateLaundry с запретами', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  // Только owner
  assert.ok(!ctx.api.createLaundry(loginWorker(), { name: 'X' }).ok);
  assert.ok(!ctx.api.createLaundry(owner, { name: ' ' }).ok);
  // Создание: id следующий по номеру, TV-ключ сгенерирован, табло отвечает по нему
  const created = ctx.api.createLaundry(owner, { name: 'Прачка 3' });
  assert.ok(created.ok);
  assert.strictEqual(created.laundry.id, '2');
  assert.ok(created.tvKey);
  const tv = ctx.api.getTvData(created.tvKey);
  assert.ok(tv.ok);
  assert.strictEqual(tv.laundryName, 'Прачка 3');
  // В списке появилась с ключом
  const ids = ctx.api.listLaundries(owner).laundries.map(l => l.id);
  assert.deepStrictEqual(ids, ['1', '2']);
  // Нельзя деактивировать активную прачку сессии
  assert.ok(!ctx.api.deactivateLaundry(owner, '1').ok);
  // Деактивация другой прачки: скрывается из списка, данные остаются
  assert.ok(ctx.api.deactivateLaundry(owner, '2').ok);
  assert.deepStrictEqual(ctx.api.listLaundries(owner).laundries.map(l => l.id), ['1']);
  assert.strictEqual(ctx.db.findById_('Laundries', '2').obj.active, 'нет');
  // Нельзя деактивировать последнюю активную прачку (даже после переключения)
  assert.ok(!ctx.api.deactivateLaundry(owner, '1').ok);
  // Не-owner не может деактивировать
  assert.ok(!ctx.api.deactivateLaundry(loginWorker(), '1').ok);
});

test('прачки: updateLaundry переименовывает (Laundries + Settings), пустое имя отклонено', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  assert.ok(!ctx.api.updateLaundry(loginWorker(), { id: '1', name: 'X' }).ok);
  assert.ok(!ctx.api.updateLaundry(owner, { id: '1', name: ' ' }).ok);
  assert.ok(!ctx.api.updateLaundry(owner, { id: '99', name: 'X' }).ok);
  assert.ok(ctx.api.updateLaundry(owner, { id: '1', name: 'Главная прачка' }).ok);
  assert.strictEqual(ctx.db.findById_('Laundries', '1').obj.name, 'Главная прачка');
  assert.strictEqual(ctx.db.getSettings_('1').LAUNDRY_NAME, 'Главная прачка');
  // Имя подтянулось в список и в день
  assert.strictEqual(ctx.api.listLaundries(owner).laundries[0].name, 'Главная прачка');
  assert.strictEqual(ctx.api.getDayList(owner, TODAY).laundryName, 'Главная прачка');
});

test('пользователи: updateUser правит логин/роль, защита от себя; reactivateUser возвращает доступ', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const u = ctx.api.createUser(owner, { laundryId: '1', name: 'Пётр', role: 'worker', login: 'petr', password: 'p1' }).user;
  // Только owner
  assert.ok(!ctx.api.updateUser(loginWorker(), { id: u.id, name: 'X' }).ok);
  // Правка имени и логина; старый логин перестаёт работать, новый — работает
  assert.ok(ctx.api.updateUser(owner, { id: u.id, name: 'Пётр Иванов', login: 'petr2' }).ok);
  assert.ok(!ctx.auth.login('petr', 'p1').ok);
  assert.ok(ctx.auth.login('petr2', 'p1').ok); // пароль не тронут
  // Конфликт логина с другим пользователем отклонён; с самим собой — ок
  assert.ok(!ctx.api.updateUser(owner, { id: u.id, login: 'worker1' }).ok);
  assert.ok(ctx.api.updateUser(owner, { id: u.id, login: 'petr2' }).ok);
  // Смена роли worker → driver
  assert.ok(ctx.api.updateUser(owner, { id: u.id, role: 'driver' }).ok);
  assert.strictEqual(ctx.auth.login('petr2', 'p1').role, 'driver');
  assert.ok(!ctx.api.updateUser(owner, { id: u.id, role: 'admin' }).ok);
  // Нельзя менять роль самому себе и отключать себя
  const me = ctx.db.readAll_('Users').find(x => x.login === 'boss');
  assert.ok(!ctx.api.updateUser(owner, { id: me.id, role: 'worker' }).ok);
  assert.ok(!ctx.api.deactivateUser(owner, me.id).ok);
  // Отключение и возврат доступа
  assert.ok(ctx.api.deactivateUser(owner, u.id).ok);
  assert.ok(!ctx.auth.login('petr2', 'p1').ok);
  // Неактивный виден в списке (помечен active=нет)
  const listed = ctx.api.listUsers(owner, '1').users.find(x => x.id === u.id);
  assert.strictEqual(listed.active, 'нет');
  assert.ok(ctx.api.reactivateUser(owner, u.id).ok);
  assert.ok(ctx.auth.login('petr2', 'p1').ok);
  // Роль client при правке требует clientId
  assert.ok(!ctx.api.updateUser(owner, { id: u.id, role: 'client' }).ok);
  const clientId = ctx.api.saveClient(owner, { name: 'Отель А' }).client.id;
  assert.ok(ctx.api.updateUser(owner, { id: u.id, role: 'client', clientId: clientId }).ok);
  assert.strictEqual(ctx.db.findById_('Users', u.id).obj.client_id, clientId);
});

test('логин: неверный пароль и чужая учётка не пускают, сообщение одно на все ошибки', () => {
  const ctx = makeCtx();
  seedLaundry2();
  assert.strictEqual(ctx.auth.login('worker1', 'не-то').error, 'Неверный логин или пароль');
  assert.strictEqual(ctx.auth.login('нет-такого', 'worker-pass').error, 'Неверный логин или пароль');
  assert.strictEqual(ctx.auth.login('boss', 'worker-pass').error, 'Неверный логин или пароль');
  // Своя пара логин+пароль работает независимо от прачки
  assert.ok(ctx.auth.login('worker2', 'worker2-pass').ok);
});

test('сессия персистентна: валидна после переоткрытия БД (симуляция рестарта)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanlab-')), 'test.sqlite');
  const ctx = makeCtx();
  const h1 = ctx.db.openTest(tmp);
  ctx.db._setDbForTests(h1);
  seedUser('usr_w1', '1', 'Работник', 'worker', 'w', 'p');
  const token = ctx.auth.login('w', 'p').token;
  // «Рестарт»: новый handle к тому же файлу БД (in-memory Map сессий не пережил бы его)
  h1.close();
  const h2 = ctx.db.openTest(tmp);
  ctx.db._setDbForTests(h2);
  const s = ctx.auth.getSession_(token);
  assert.ok(s);
  assert.strictEqual(s.name, 'Работник');
  assert.strictEqual(s.laundryId, '1');
  h2.close();
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

test('rate-limit: после 5 неудачных попыток логин блокируется на 5 минут', () => {
  const ctx = makeCtx();
  for (let i = 0; i < 5; i++) assert.ok(!ctx.auth.login('worker1', 'не-то').ok);
  // Даже верный пароль не пускает, пока идёт блок
  assert.strictEqual(ctx.auth.login('worker1', 'worker-pass').error, 'Неверный логин или пароль');
  // Другой логин не затронут
  assert.ok(ctx.auth.login('boss', 'boss-pass').ok);
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

test('пользователи: логин глобально уникален; resetUserPassword; деактивация закрывает вход', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  // Обычный работник прачки 1
  const u = ctx.api.createUser(owner, { laundryId: '1', name: 'Пётр', role: 'worker', login: 'petr', password: 'p1' });
  assert.ok(u.ok);
  assert.ok(ctx.auth.login('petr', 'p1').ok);
  // Дубль логина отклонён — глобально, в любой прачке и роли
  assert.ok(!ctx.api.createUser(owner, { laundryId: '1', name: 'Иван', role: 'driver', login: 'petr', password: 'p2' }).ok);
  assert.ok(!ctx.api.createUser(owner, { name: 'Второй владелец', role: 'owner', login: 'boss', password: 'p2' }).ok);
  // Роль client требует clientId; вход для неё не настроен
  assert.ok(!ctx.api.createUser(owner, { laundryId: '1', name: 'Клиент', role: 'client', login: 'k1', password: 'p3' }).ok);
  const clientId = ctx.api.saveClient(owner, { name: 'Отель А' }).client.id;
  const cu = ctx.api.createUser(owner, { laundryId: '1', name: 'Клиент', role: 'client', login: 'k1', password: 'p3', clientId: clientId });
  assert.ok(cu.ok);
  assert.strictEqual(cu.user.client_id, clientId);
  const login = ctx.auth.login('k1', 'p3');
  assert.ok(!login.ok);
  assert.ok(/не настроен/.test(login.error));
  // listUsers не отдаёт pass_hash и pin
  const users = ctx.api.listUsers(owner, '1').users;
  assert.ok(users.some(x => x.name === 'Пётр'));
  users.forEach(function (x) {
    assert.strictEqual(x.pass_hash, undefined);
    assert.strictEqual(x.pin, undefined);
  });
  // Сброс пароля: старый не работает, новый работает (только owner)
  assert.ok(!ctx.api.resetUserPassword(loginWorker(), u.user.id, 'новый').ok);
  assert.ok(ctx.api.resetUserPassword(owner, u.user.id, 'новый').ok);
  assert.ok(!ctx.auth.login('petr', 'p1').ok);
  assert.ok(ctx.auth.login('petr', 'новый').ok);
  // Деактивация закрывает вход
  assert.ok(ctx.api.deactivateUser(owner, u.user.id).ok);
  assert.ok(!ctx.auth.login('petr', 'новый').ok);
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

test('telegram: привязка чата по одноразовому 6-значному коду (per-tenant)', async () => {
  const ctx = makeCtx();
  seedLaundry2();
  const owner = loginOwner();
  // Код привязан к активной прачке владельца
  ctx.auth.switchLaundry(owner, '2');
  const code = ctx.api.makeTelegramBindCode(owner).code;
  assert.ok(/^\d{6}$/.test(code));
  // Неверный код — отказ, привязки нет
  const bad = code === '000000' ? '999999' : '000000';
  await ctx.telegram.handleUpdate_({ message: { text: bad, chat: { id: 555 } } });
  assert.ok(ctx.fetches[0].payload.text.includes('Неверный или просроченный код'));
  assert.strictEqual(ctx.telegram.getOwnerChatId_('2'), '');
  // Валидный код → chat_id пишется в Settings прачки 2; код одноразовый
  await ctx.telegram.handleUpdate_({ message: { text: code, chat: { id: 555 } } });
  assert.ok(ctx.fetches[1].payload.text.includes('Прачка 2'));
  assert.strictEqual(ctx.telegram.getOwnerChatId_('2'), '555');
  assert.strictEqual(ctx.telegram.getOwnerChatId_('1'), '');
  await ctx.telegram.handleUpdate_({ message: { text: code, chat: { id: 777 } } });
  assert.ok(ctx.fetches[2].payload.text.includes('Неверный или просроченный код'));
  // makeTelegramBindCode — только owner
  assert.ok(!ctx.api.makeTelegramBindCode(loginWorker()).ok);
});
