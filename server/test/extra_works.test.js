// Тесты доп. работ водителя (P12): ввод водителем/владельцем, валидации,
// Telegram-уведомление, учёт в зарплате отдельной строкой, права, изоляция прачек.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, loginOwner, loginWorker, loginDriver, seedLaundry2, loginDriver2, TODAY, TOMORROW } = require('./helpers/serverMocks');

function seedClient(ctx, over = {}) {
  const res = ctx.api.saveClient(loginOwner(), Object.assign({ name: 'Отель А', type: 'отель' }, over));
  assert.ok(res.ok);
  return res.client.id;
}

function seedExtraWork(ctx, over = {}) {
  const entry = Object.assign({
    id: ctx.db.nextId_('ExtraWorks', 'exw'), user_id: 'usr_d1',
    date: TODAY, client_id: 'cli_x', amount: '500', comment: 'погрузка',
    created_by: 'test', created_at: TODAY + ' 12:00:00',
    edited_by: '', edited_at: ''
  }, over);
  ctx.db.appendRowTenant_('ExtraWorks', entry, over.laundry_id || '1');
  return entry;
}

function logsOf(ctx, action) {
  return ctx.db.readAll_('Log').filter(function (e) { return e.action === action; });
}

// --- addExtraWork (driver) ---

test('addExtraWork (driver): запись создана с его user_id, Telegram и Log есть', () => {
  const ctx = makeCtx();
  ctx.db.appendRow_('Settings', { key: 'OWNER_CHAT_ID', value: '998877' });
  ctx.db.invalidateRefCache_();
  const clientId = seedClient(ctx);
  const driver = loginDriver();

  const res = ctx.api.addExtraWork(driver, clientId, TODAY, 700, 'подъём нестандарта');
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.extraWork.user_id, 'usr_d1');
  assert.strictEqual(res.extraWork.client_id, clientId);
  assert.strictEqual(res.extraWork.amount, '700');
  assert.strictEqual(res.extraWork.edited_by, '');

  // Telegram ушёл владельцу
  const tg = ctx.fetches.filter(f => f.url.includes('bot-token'));
  assert.strictEqual(tg.length, 1);
  assert.ok(tg[0].payload.text.includes('Водитель'));
  assert.ok(tg[0].payload.text.includes('700 ₽'));
  assert.ok(tg[0].payload.text.includes('подъём нестандарта'));

  // Log
  const ev = logsOf(ctx, 'extra_work_add');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].entity, res.extraWork.id);
});

test('addExtraWork (driver): валидации — сумма, комментарий, клиент, дата', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const driver = loginDriver();

  assert.strictEqual(ctx.api.addExtraWork(driver, clientId, TODAY, 0, 'работа').error, 'Сумма: положительное число');
  assert.strictEqual(ctx.api.addExtraWork(driver, clientId, TODAY, -100, 'работа').error, 'Сумма: положительное число');
  assert.strictEqual(ctx.api.addExtraWork(driver, clientId, TODAY, '', 'работа').error, 'Сумма: положительное число');
  assert.strictEqual(ctx.api.addExtraWork(driver, clientId, TODAY, 100, '   ').error, 'Комментарий обязателен');
  assert.strictEqual(ctx.api.addExtraWork(driver, 'cli_нет', TODAY, 100, 'работа').error, 'Клиент не найден');
  assert.strictEqual(ctx.api.addExtraWork(driver, clientId, '12.08.2026', 100, 'работа').error, 'Некорректная дата');
  assert.strictEqual(ctx.api.addExtraWork(driver, clientId, TOMORROW, 100, 'работа').error, 'Дата не может быть в будущем');

  // Неактивный клиент
  const deadId = seedClient(ctx, { name: 'Отель Б' });
  assert.ok(ctx.api.deleteClient(loginOwner(), deadId).ok);
  assert.strictEqual(ctx.api.addExtraWork(driver, deadId, TODAY, 100, 'работа').error, 'Клиент неактивен');

  // Ни одной записи не создалось
  assert.strictEqual(ctx.db.readAllByTenant_('ExtraWorks', '1').length, 0);
});

test('addExtraWork (driver): userId-аргумент игнорируется — всегда за себя', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const driver = loginDriver();

  const res = ctx.api.addExtraWork(driver, clientId, TODAY, 300, 'вынос', 'usr_w1');
  assert.ok(res.ok);
  assert.strictEqual(res.extraWork.user_id, 'usr_d1');
});

test('addExtraWork (owner): вносит за водителя; за работника/без цели — ошибка', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const owner = loginOwner();

  const okRes = ctx.api.addExtraWork(owner, clientId, TODAY, 400, 'погрузка', 'usr_d1');
  assert.ok(okRes.ok);
  assert.strictEqual(okRes.extraWork.user_id, 'usr_d1');

  assert.strictEqual(ctx.api.addExtraWork(owner, clientId, TODAY, 400, 'погрузка').error, 'Нет доступа');
  assert.strictEqual(ctx.api.addExtraWork(owner, clientId, TODAY, 400, 'погрузка', 'usr_w1').error, 'Цель — водитель прачки');
  assert.strictEqual(ctx.api.addExtraWork(owner, clientId, TODAY, 400, 'погрузка', 'usr_d2').error, 'Нет доступа');
  // owner за водителя — Telegram не шлём
  assert.strictEqual(ctx.fetches.filter(f => f.url.includes('bot-token')).length, 0);
});

test('addExtraWork (worker): нет доступа', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  assert.strictEqual(ctx.api.addExtraWork(loginWorker(), clientId, TODAY, 100, 'работа').error, 'Нет доступа');
});

// --- Зарплата ---

test('getPayroll: extras в total и extras_total, отдельно от корректировок', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  const driver = loginDriver();

  ctx.api.addExtraWork(driver, clientId, TODAY, 500, 'погрузка');
  ctx.api.addExtraWork(driver, clientId, TODAY, 200, 'вынос');
  ctx.api.addExtraWork(driver, clientId, TODAY, 300, 'подъём', undefined); // driver за себя
  ctx.api.savePayAdjustment(owner, 'usr_d1', TODAY, -150, 'штраф');
  ctx.api.savePayAdjustment(owner, 'usr_w1', TODAY, 1000, 'премия');

  const res = ctx.api.getPayroll(owner, TODAY, TODAY);
  assert.ok(res.ok);
  const d = res.employees.filter(e => e.user_id === 'usr_d1')[0];
  assert.strictEqual(d.extras_total, 1000);
  assert.strictEqual(d.adjustments_total, -150);
  assert.strictEqual(d.total, 850);
  const day = d.days.filter(x => x.date === TODAY)[0];
  assert.strictEqual(day.extras, 1000);

  const w = res.employees.filter(e => e.user_id === 'usr_w1')[0];
  assert.strictEqual(w.extras_total, 0);
  assert.strictEqual(w.adjustments_total, 1000);
});

test('getPayroll: доп. работа у работника считается так же (роль в computePayroll не важна)', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx);
  // owner вносит только за водителей (addExtraWork); у работника — прямой сид,
  // расчёт роль не различает.
  seedExtraWork(ctx, { user_id: 'usr_w1', client_id: clientId, amount: '600' });

  const res = ctx.api.getPayroll(owner, TODAY, TODAY);
  const w = res.employees.filter(e => e.user_id === 'usr_w1')[0];
  assert.strictEqual(w.extras_total, 600);
  assert.strictEqual(w.total, 600);
});

test('getMyPayroll: extras_total присутствует и совпадает', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const driver = loginDriver();
  ctx.api.addExtraWork(driver, clientId, TODAY, 450, 'погрузка');

  const res = ctx.api.getMyPayroll(driver, TODAY, TODAY);
  assert.ok(res.ok);
  assert.strictEqual(res.extras_total, 450);
  assert.strictEqual(res.total, 450);
  const day = res.days.filter(x => x.date === TODAY)[0];
  assert.strictEqual(day.extras, 450);
});

test('getMyPayroll: чужие extras не попадают водителю', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  seedExtraWork(ctx, { user_id: 'usr_w1', amount: '900' });

  const res = ctx.api.getMyPayroll(loginDriver(), TODAY, TODAY);
  assert.ok(res.ok);
  assert.strictEqual(res.extras_total, 0);
});

// --- editExtraWork (owner) ---

test('editExtraWork (owner): поля обновлены, edited_by/edited_at, лог старое→новое', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const clientId2 = seedClient(ctx, { name: 'Отель Б' });
  const driver = loginDriver();
  const owner = loginOwner();

  const created = ctx.api.addExtraWork(driver, clientId, TODAY, 500, 'погрузка');
  const id = created.extraWork.id;

  const res = ctx.api.editExtraWork(owner, id, { amount: 650, comment: 'погрузка + вынос', client_id: clientId2 });
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.extraWork.amount, '650');
  assert.strictEqual(res.extraWork.comment, 'погрузка + вынос');
  assert.strictEqual(res.extraWork.client_id, clientId2);
  assert.strictEqual(res.extraWork.created_by, 'Водитель'); // created_* не тронуты
  assert.ok(res.extraWork.edited_by);
  assert.ok(res.extraWork.edited_at);

  const ev = logsOf(ctx, 'extra_work_edit');
  assert.strictEqual(ev.length, 1);
  const details = JSON.parse(ev[0].details);
  assert.strictEqual(details.old.amount, '500');
  assert.strictEqual(details.now.amount, '650');

  // Валидации действуют и на правку
  assert.strictEqual(ctx.api.editExtraWork(owner, id, { amount: -5 }).error, 'Сумма: положительное число');
  assert.strictEqual(ctx.api.editExtraWork(owner, id, { comment: ' ' }).error, 'Комментарий обязателен');
  assert.strictEqual(ctx.api.editExtraWork(owner, id, { date: TOMORROW }).error, 'Дата не может быть в будущем');
});

test('editExtraWork: только owner; чужая прачка — «не найдена»', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const driver = loginDriver();
  const owner = loginOwner();
  const created = ctx.api.addExtraWork(driver, clientId, TODAY, 500, 'погрузка');
  const id = created.extraWork.id;

  assert.strictEqual(ctx.api.editExtraWork(driver, id, { amount: 100 }).error, 'Нет доступа');
  assert.strictEqual(ctx.api.editExtraWork(loginWorker(), id, { amount: 100 }).error, 'Нет доступа');

  seedLaundry2();
  const driver2 = loginDriver2();
  assert.strictEqual(ctx.api.editExtraWork(driver2, id, { amount: 100 }).error, 'Нет доступа');
  assert.strictEqual(ctx.api.editExtraWork(owner, 'exw_нет', { amount: 100 }).error, 'Доп. работа не найдена');
});

// --- deleteExtraWork ---

test('deleteExtraWork: driver свою — ok, чужую — «Нет доступа»; owner любую; чужая прачка — «не найдена»', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx);
  const driver = loginDriver();
  const owner = loginOwner();

  const mine = ctx.api.addExtraWork(driver, clientId, TODAY, 300, 'вынос');
  const other = ctx.api.addExtraWork(owner, clientId, TODAY, 300, 'вынос', 'usr_d1');
  // запись другого сотрудника (usr_w1) — для driver чужая
  ctx.db.appendRowTenant_('ExtraWorks', {
    id: ctx.db.nextId_('ExtraWorks', 'exw'), user_id: 'usr_w1', date: TODAY,
    client_id: clientId, amount: '100', comment: 'чужая', created_by: 'test',
    created_at: TODAY + ' 10:00:00', edited_by: '', edited_at: ''
  }, '1');

  const w1id = ctx.db.readAllByTenant_('ExtraWorks', '1')
    .filter(x => x.user_id === 'usr_w1')[0].id;
  assert.strictEqual(ctx.api.deleteExtraWork(driver, w1id).error, 'Нет доступа');

  const del = ctx.api.deleteExtraWork(driver, mine.extraWork.id);
  assert.ok(del.ok);
  assert.strictEqual(logsOf(ctx, 'extra_work_del').length, 1);

  const delOwner = ctx.api.deleteExtraWork(owner, other.extraWork.id);
  assert.ok(delOwner.ok);

  seedLaundry2();
  const driver2 = loginDriver2();
  ctx.db.appendRowTenant_('ExtraWorks', {
    id: 'exw_l2', user_id: 'usr_d2', date: TODAY, client_id: 'cli_l2',
    amount: '100', comment: 'прачка 2', created_by: 'test',
    created_at: TODAY + ' 10:00:00', edited_by: '', edited_at: ''
  }, '2');
  assert.strictEqual(ctx.api.deleteExtraWork(owner, 'exw_l2').error, 'Доп. работа не найдена');
  assert.strictEqual(ctx.db.readAllByTenant_('ExtraWorks', '2').length, 1);
});

// --- listExtraWorks ---

test('listExtraWorks: driver только свои; owner фильтры; client_name/user_name подмешаны', () => {
  const ctx = makeCtx();
  const clientId = seedClient(ctx, { name: 'Отель А' });
  const owner = loginOwner();
  const driver = loginDriver();

  ctx.api.addExtraWork(driver, clientId, TODAY, 500, 'погрузка');
  ctx.db.appendRowTenant_('ExtraWorks', {
    id: ctx.db.nextId_('ExtraWorks', 'exw'), user_id: 'usr_w1', date: TODAY,
    client_id: clientId, amount: '100', comment: 'работника', created_by: 'boss',
    created_at: TODAY + ' 09:00:00', edited_by: '', edited_at: ''
  }, '1');

  // driver видит только свои
  const mine = ctx.api.listExtraWorks(driver, null, TODAY, TODAY);
  assert.ok(mine.ok);
  assert.strictEqual(mine.extraWorks.length, 1);
  assert.strictEqual(mine.extraWorks[0].user_name, 'Водитель');
  assert.strictEqual(mine.extraWorks[0].client_name, 'Отель А');

  // driver не вытащит чужие через userId
  const asWorker = ctx.api.listExtraWorks(driver, 'usr_w1', TODAY, TODAY);
  assert.strictEqual(asWorker.extraWorks.length, 1);
  assert.strictEqual(asWorker.extraWorks[0].user_id, 'usr_d1');

  // owner — все + фильтр по сотруднику
  const all = ctx.api.listExtraWorks(owner, null, TODAY, TODAY);
  assert.strictEqual(all.extraWorks.length, 2);
  const byWorker = ctx.api.listExtraWorks(owner, 'usr_w1', TODAY, TODAY);
  assert.strictEqual(byWorker.extraWorks.length, 1);

  // фильтр по периоду
  const none = ctx.api.listExtraWorks(owner, null, TOMORROW, TOMORROW);
  assert.strictEqual(none.extraWorks.length, 0);

  assert.strictEqual(ctx.api.listExtraWorks(loginWorker(), null, TODAY, TODAY).error, 'Нет доступа');
});

// --- listClientsBrief ---

test('listClientsBrief: только id+name активных; worker — нет доступа', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = seedClient(ctx, { name: 'Отель А' });
  const deadId = seedClient(ctx, { name: 'Отель Б' });
  assert.ok(ctx.api.deleteClient(owner, deadId).ok);

  const res = ctx.api.listClientsBrief(loginDriver());
  assert.ok(res.ok);
  assert.strictEqual(res.clients.length, 1);
  assert.strictEqual(res.clients[0].id, clientId);
  assert.deepStrictEqual(Object.keys(res.clients[0]).sort(), ['id', 'name']);

  assert.strictEqual(ctx.api.listClientsBrief(loginWorker()).error, 'Нет доступа');
});
