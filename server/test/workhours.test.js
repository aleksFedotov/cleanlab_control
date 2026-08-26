// Тесты табеля: учёт часов работников (WorkHours) и авто-статистика точек развоза.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, seedUser, loginOwner, loginWorker, loginWorker2, seedLaundry2, TODAY, TOMORROW } = require('./helpers/serverMocks');

// Визит развоза напрямую в БД с нужными треками/статусом
function seedVisit(ctx, date, status, deliveredAt, pickedAt, laundryId) {
  ctx.db.appendRowTenant_('Deliveries', {
    id: ctx.db.nextId_('Deliveries', 'del'), date: date, client_id: 'cli_1',
    ord: 1, status: status, delivered_at: deliveredAt || '', pickup: pickedAt ? 'да' : '',
    driver_comment: '', created_by: 'test', created_at: date + ' 08:00:00',
    clean_taken_at: '', clean_bags: '', picked_at: pickedAt || '', dirty_handed_at: '', pickup_only: ''
  }, laundryId || '1');
}

test('setWorkHours: работник ставит часы себе, upsert по дате, 0 — удаляет', () => {
  const ctx = makeCtx();
  const worker = loginWorker();

  // Поставить за сегодня (userId можно опустить — сервер подставит из сессии)
  const res = ctx.api.setWorkHours(worker, '', TODAY, 8);
  assert.ok(res.ok);
  assert.strictEqual(res.entry.hours, '8');

  // Повтор за ту же дату — обновление, а не новая строка
  const res2 = ctx.api.setWorkHours(worker, 'usr_w1', TODAY, 6.5);
  assert.ok(res2.ok);
  assert.strictEqual(res2.entry.id, res.entry.id);
  assert.strictEqual(res2.entry.hours, '6.5');
  assert.strictEqual(ctx.db.readAll_('WorkHours').length, 1);

  // Будущая дата разрешена
  assert.ok(ctx.api.setWorkHours(worker, 'usr_w1', TOMORROW, 4).ok);

  // 0 / пусто — удаление отметки
  const cleared = ctx.api.setWorkHours(worker, 'usr_w1', TODAY, 0);
  assert.ok(cleared.ok && cleared.cleared);
  assert.strictEqual(ctx.db.readAll_('WorkHours').length, 1); // остался только TOMORROW

  // Валидация
  assert.ok(!ctx.api.setWorkHours(worker, 'usr_w1', '12.08.2026', 8).ok);
  assert.ok(!ctx.api.setWorkHours(worker, 'usr_w1', TODAY, 25).ok);
  assert.ok(!ctx.api.setWorkHours(worker, 'usr_w1', TODAY, -1).ok);
  assert.ok(!ctx.api.setWorkHours(worker, 'usr_w1', TODAY, 'много').ok);
});

test('setWorkHours: права — работник только себе, владелец любому работнику прачки', () => {
  const ctx = makeCtx();
  seedLaundry2();
  const worker = loginWorker();
  const owner = loginOwner();

  // Работник не может ставить другому
  seedUser('usr_w3', '1', 'Ещё работник', 'worker', 'worker3', 'pass3');
  assert.ok(!ctx.api.setWorkHours(worker, 'usr_w3', TODAY, 8).ok);
  // …и не может «себе», но с чужим userId другой прачки
  assert.ok(!ctx.api.setWorkHours(worker, 'usr_w2', TODAY, 8).ok);

  // Владелец правит часами работника своей прачки
  const res = ctx.api.setWorkHours(owner, 'usr_w1', TODAY, 7);
  assert.ok(res.ok);
  assert.strictEqual(res.entry.hours, '7');
  assert.ok(res.entry.updated_by.indexOf('owner') !== -1);

  // Владелец не может работнику чужой прачки и не-работнику (водитель)
  assert.ok(!ctx.api.setWorkHours(owner, 'usr_w2', TODAY, 8).ok);
  assert.ok(!ctx.api.setWorkHours(owner, 'usr_d1', TODAY, 8).ok);
  // Водитель не отмечает часы
  assert.ok(!ctx.api.setWorkHours(ctx.auth.login('driver1', 'driver-pass').token, 'usr_d1', TODAY, 8).ok);
});

test('getWorkHours: работник видит только своё, владелец — всех + список работников', () => {
  const ctx = makeCtx();
  seedUser('usr_w3', '1', 'Ещё работник', 'worker', 'worker3', 'pass3');
  const worker = loginWorker();
  const owner = loginOwner();

  ctx.api.setWorkHours(worker, 'usr_w1', TODAY, 8);
  ctx.api.setWorkHours(owner, 'usr_w3', TODAY, 5);

  const mine = ctx.api.getWorkHours(worker, TODAY, TODAY);
  assert.ok(mine.ok);
  assert.strictEqual(mine.entries.length, 1);
  assert.strictEqual(mine.entries[0].user_id, 'usr_w1');
  assert.ok(!mine.workers); // работнику список работников не нужен

  const all = ctx.api.getWorkHours(owner, TODAY, TODAY);
  assert.ok(all.ok);
  assert.strictEqual(all.entries.length, 2);
  assert.deepStrictEqual(all.workers.map(w => w.id).sort(), ['usr_w1', 'usr_w3']);

  // Период фильтрует
  assert.strictEqual(ctx.api.getWorkHours(owner, TOMORROW, TOMORROW).entries.length, 0);
  assert.ok(!ctx.api.getWorkHours(owner, '2026-13-01', TODAY).ok);
  assert.ok(!ctx.api.getWorkHours(owner, TOMORROW, TODAY).ok);
});

test('getWorkHours/setWorkHours: изоляция прачек', () => {
  const ctx = makeCtx();
  seedLaundry2();
  const worker1 = loginWorker();
  const worker2 = loginWorker2();
  ctx.api.setWorkHours(worker1, 'usr_w1', TODAY, 8);
  ctx.api.setWorkHours(worker2, 'usr_w2', TODAY, 6);

  const w2 = ctx.api.getWorkHours(worker2, TODAY, TODAY);
  assert.strictEqual(w2.entries.length, 1);
  assert.strictEqual(w2.entries[0].hours, '6');

  // Владелец видит работников только активной прачки
  const owner = loginOwner();
  const all = ctx.api.getWorkHours(owner, TODAY, TODAY);
  assert.deepStrictEqual(all.entries.map(e => e.user_id), ['usr_w1']);
  assert.deepStrictEqual(all.workers.map(w => w.id), ['usr_w1']);
});

test('getDeliveryPointStats: разбивка total/only_delivery/only_pickup/both', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';

  seedVisit(ctx, TODAY, 'both', ts, ts);              // доставка + забор
  seedVisit(ctx, TODAY, 'delivered', ts, '');         // только доставка
  seedVisit(ctx, TODAY, 'picked', '', ts);            // только забор
  seedVisit(ctx, TODAY, 'empty', ts, '');             // «ничего нет» — не точка
  seedVisit(ctx, TODAY, 'planned', '', '');           // не выполнен
  seedVisit(ctx, TODAY, 'cancelled', '', '');         // отменён — не считается
  seedVisit(ctx, TOMORROW, 'delivered', ts, '');      // другой день

  const res = ctx.api.getDeliveryPointStats(owner, TODAY, TODAY);
  assert.ok(res.ok);
  assert.strictEqual(res.days.length, 1);
  const d = res.days[0];
  assert.strictEqual(d.date, TODAY);
  assert.strictEqual(d.total, 3);
  assert.strictEqual(d.both, 1);
  assert.strictEqual(d.only_delivery, 1);
  assert.strictEqual(d.only_pickup, 1);

  // Период захватывает оба дня, сортировка по дате
  const range = ctx.api.getDeliveryPointStats(owner, TODAY, TOMORROW);
  assert.strictEqual(range.days.length, 2);
  assert.strictEqual(range.days[1].total, 1);

  // Валидация и права
  assert.ok(!ctx.api.getDeliveryPointStats(owner, TOMORROW, TODAY).ok);
  assert.ok(!ctx.api.getDeliveryPointStats(loginWorker(), TODAY, TODAY).ok);
});
