// Тесты зарплат (P3): водитель по точкам/подъёмам, работник по табелю,
// корректировки, права и изоляция прачек.
const test = require('node:test');
const assert = require('node:assert');
const { makeCtx, seedUser, loginOwner, loginWorker, loginDriver, seedLaundry2, loginDriver2, TODAY, TOMORROW } = require('./helpers/serverMocks');

// Визит развоза напрямую в БД (как seedVisit в workhours.test.js + lift_floor).
function seedVisit(ctx, o) {
  ctx.db.appendRowTenant_('Deliveries', {
    id: ctx.db.nextId_('Deliveries', 'del'), date: o.date, client_id: o.client_id || 'cli_1',
    ord: 1, status: o.status || 'delivered', delivered_at: o.delivered_at || '',
    pickup: o.picked_at ? 'да' : '', driver_comment: '', created_by: 'test',
    created_at: o.date + ' 08:00:00', clean_taken_at: '', clean_bags: '',
    picked_at: o.picked_at || '', dirty_handed_at: '', pickup_only: o.pickup_only || '',
    lift_floor: o.lift_floor || ''
  }, o.laundry_id || '1');
}

// Часы работника напрямую в БД
function seedHours(ctx, userId, date, hours, laundryId) {
  ctx.db.appendRowTenant_('WorkHours', {
    id: ctx.db.nextId_('WorkHours', 'wh'), user_id: userId, date: date,
    hours: String(hours), updated_by: 'test', updated_at: date + ' 20:00:00'
  }, laundryId || '1');
}

function employeeOf(res, userId) {
  return res.employees.filter(e => e.user_id === userId)[0];
}

test('getPayroll: водитель по дефолтам — 20 точек × 250 + 3 этажа × 100 = 5300', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';

  // 20 выполненных точек за период
  for (let i = 0; i < 20; i++) seedVisit(ctx, { date: TODAY, delivered_at: ts });
  // 3 этажа суммарно: 3-й у одного клиента (1) + 4-й у другого (2)
  seedVisit(ctx, { date: TODAY, client_id: 'cli_a', delivered_at: ts, lift_floor: '3' });
  seedVisit(ctx, { date: TODAY, client_id: 'cli_b', delivered_at: ts, lift_floor: '4' });

  const res = ctx.api.getPayroll(owner, TODAY, TODAY);
  assert.ok(res.ok);
  const d = employeeOf(res, 'usr_d1');
  assert.ok(d, 'водитель в расчёте');
  assert.strictEqual(d.points, 22);
  assert.strictEqual(d.lift_floors, 3);
  assert.strictEqual(d.point_rate, 250);
  assert.strictEqual(d.lift_floor_rate, 100);
  assert.strictEqual(d.amount_points, 5500);
  assert.strictEqual(d.amount_lifts, 300);
  assert.strictEqual(d.total, 5800);
  assert.strictEqual(d.rate_missing, false);

  // Ровно 20 точек без подъёмов → 5300 в изоляции
  const res2 = ctx.api.getPayroll(owner, TOMORROW, TOMORROW);
  assert.strictEqual(employeeOf(res2, 'usr_d1').total, 0);
});

test('getPayroll: pickup_only — точка; empty и cancelled — нет', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';

  seedVisit(ctx, { date: TODAY, status: 'picked', picked_at: ts, pickup_only: 'да' }); // точка
  seedVisit(ctx, { date: TODAY, status: 'empty', delivered_at: ts });                  // не точка
  seedVisit(ctx, { date: TODAY, status: 'empty', picked_at: ts });                     // тоже не точка
  seedVisit(ctx, { date: TODAY, status: 'cancelled', delivered_at: ts, picked_at: ts }); // не точка
  seedVisit(ctx, { date: TODAY, status: 'planned' });                                  // не выполнен

  const d = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d.points, 1);
  assert.strictEqual(d.total, 250);
});

test('getPayroll: подъёмы — этажи выше 2-го, ≤2 не считаются', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';

  seedVisit(ctx, { date: TODAY, delivered_at: ts, lift_floor: '3' });  // +1
  seedVisit(ctx, { date: TODAY, delivered_at: ts, lift_floor: '4' });  // +2
  seedVisit(ctx, { date: TODAY, delivered_at: ts, lift_floor: '6' });  // +4
  seedVisit(ctx, { date: TODAY, delivered_at: ts, lift_floor: '2' });  // 0
  seedVisit(ctx, { date: TODAY, delivered_at: ts, lift_floor: '' });   // 0

  const d = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d.lift_floors, 7);
  assert.strictEqual(d.amount_lifts, 700);
  assert.strictEqual(d.total, 5 * 250 + 700);
});

test('getPayroll: override PayRates point_rate=280 перекрывает дефолт', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';
  seedVisit(ctx, { date: TODAY, delivered_at: ts, lift_floor: '3' });

  const saved = ctx.api.savePayRate(owner, 'usr_d1', { point_rate: 280 });
  assert.ok(saved.ok);
  assert.ok(saved.rate.id.indexOf('pr_') === 0);

  const d = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d.point_rate, 280);
  assert.strictEqual(d.lift_floor_rate, 100, 'остальное — по дефолтам');
  assert.strictEqual(d.total, 280 + 100);

  // upsert: повторное сохранение не плодит строки
  ctx.api.savePayRate(owner, 'usr_d1', { point_rate: 300 });
  assert.strictEqual(ctx.db.readAllByTenant_('PayRates', '1').length, 1);
  const list = ctx.api.listPayRates(owner);
  assert.ok(list.ok);
  assert.strictEqual(list.rates.length, 1);
  assert.strictEqual(list.rates[0].name, 'Водитель');
  assert.strictEqual(list.rates[0].point_rate, '300');
});

test('getPayroll: работник — 4000/12 × 7.5 ч = 2500', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  seedHours(ctx, 'usr_w1', TODAY, 5);
  seedHours(ctx, 'usr_w1', TOMORROW, 2.5);

  const w = employeeOf(ctx.api.getPayroll(owner, TODAY, TOMORROW), 'usr_w1');
  assert.ok(w);
  assert.strictEqual(w.hours, 7.5);
  assert.strictEqual(w.shift_base, 4000);
  assert.strictEqual(w.shift_norm_hours, 12);
  assert.strictEqual(w.amount_shift, 2500);
  assert.strictEqual(w.total, 2500);
  assert.strictEqual(w.days.length, 2);
});

test('getPayroll: округление один раз на итоге периода', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  seedHours(ctx, 'usr_w1', TODAY, 7.55); // 4000/12 × 7.55 = 2516.66…

  const w = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_w1');
  assert.strictEqual(w.total, 2517);
  // дневная разбивка — без округления
  assert.ok(Math.abs(w.days[0].amount - 2516.6667) < 0.01);
});

test('getPayroll: корректировки +/− в периоде учитываются, вне периода — нет', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  seedHours(ctx, 'usr_w1', TODAY, 12); // 4000

  assert.ok(ctx.api.savePayAdjustment(owner, 'usr_w1', TODAY, 500, 'премия').ok);
  assert.ok(ctx.api.savePayAdjustment(owner, 'usr_w1', TODAY, -300, 'штраф').ok);
  assert.ok(ctx.api.savePayAdjustment(owner, 'usr_w1', '2026-08-01', 1000, 'вне периода').ok);

  const w = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_w1');
  assert.strictEqual(w.adjustments_total, 200);
  assert.strictEqual(w.total, 4200);

  // Удаление корректировки
  const adjId = ctx.db.readAllByTenant_('PayAdjustments', '1')[0].id;
  assert.ok(ctx.api.deletePayAdjustment(owner, adjId).ok);
  const w2 = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_w1');
  assert.strictEqual(w2.adjustments_total, -300);

  // Валидация
  assert.ok(!ctx.api.savePayAdjustment(owner, 'usr_w1', '12.08.2026', 100, '').ok);
  assert.ok(!ctx.api.savePayAdjustment(owner, 'usr_w1', TODAY, 'много', '').ok);
  assert.ok(!ctx.api.deletePayAdjustment(owner, 'adj_999').ok);
});

test('getPayroll: права — worker и driver получают «Нет доступа»', () => {
  const ctx = makeCtx();
  assert.strictEqual(ctx.api.getPayroll(loginWorker(), TODAY, TODAY).error, 'Нет доступа');
  assert.strictEqual(ctx.api.getPayroll(loginDriver(), TODAY, TODAY).error, 'Нет доступа');
  assert.ok(!ctx.api.listPayRates(loginWorker()).ok);
  assert.ok(!ctx.api.savePayRate(loginWorker(), 'usr_d1', { point_rate: 1 }).ok);
  assert.ok(!ctx.api.savePayAdjustment(loginDriver(), 'usr_d1', TODAY, 100, '').ok);
});

test('getPayroll: изоляция прачек — данные чужой прачки не видны', () => {
  const ctx = makeCtx();
  seedLaundry2();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';

  // Активность только на прачке 2
  seedVisit(ctx, { date: TODAY, delivered_at: ts, laundry_id: '2' });
  seedHours(ctx, 'usr_w2', TODAY, 12, '2');

  const res = ctx.api.getPayroll(owner, TODAY, TODAY); // активная прачка owner — 1
  const d1 = employeeOf(res, 'usr_d1');
  assert.strictEqual(d1.points, 0);
  assert.strictEqual(d1.total, 0);
  assert.ok(!employeeOf(res, 'usr_d2'), 'водитель чужой прачки не попадает в расчёт');
  assert.ok(!employeeOf(res, 'usr_w2'), 'работник чужой прачки не попадает в расчёт');

  // Ставки/корректировки сотруднику чужой прачки — «Нет доступа»
  assert.strictEqual(ctx.api.savePayRate(owner, 'usr_d2', { point_rate: 1 }).error, 'Нет доступа');
  assert.strictEqual(ctx.api.savePayAdjustment(owner, 'usr_w2', TODAY, 100, '').error, 'Нет доступа');

  // Водитель прачки 2 видит свои точки через getMyPayroll
  const mine = ctx.api.getMyPayroll(loginDriver2(), TODAY, TODAY);
  assert.ok(mine.ok);
  assert.strictEqual(mine.points, 1);
  assert.strictEqual(mine.total, 250);
});

test('getMyPayroll: водитель видит только своё, работнику — «Нет доступа»', () => {
  const ctx = makeCtx();
  const ts = TODAY + ' 12:00:00';
  seedVisit(ctx, { date: TODAY, delivered_at: ts, lift_floor: '5' }); // точка + 3 этажа

  const mine = ctx.api.getMyPayroll(loginDriver(), TODAY, TODAY);
  assert.ok(mine.ok);
  assert.strictEqual(mine.points, 1);
  assert.strictEqual(mine.lift_floors, 3);
  assert.strictEqual(mine.total, 250 + 300);
  assert.ok(!mine.employees, 'чужих данных нет');

  assert.strictEqual(ctx.api.getMyPayroll(loginWorker(), TODAY, TODAY).error, 'Нет доступа');
  assert.ok(!ctx.api.getMyPayroll(loginDriver(), TOMORROW, TODAY).ok);
});

test('getPayroll: стёртый дефолт ставки — сотрудник с total 0 и rate_missing', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';
  seedVisit(ctx, { date: TODAY, delivered_at: ts });

  // Стираем дефолт прачки: ключ есть, значение пустое
  ctx.db.setTenantSetting_('1', 'PAY_POINT_RATE', '');
  ctx.db.invalidateRefCache_();

  const d = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.ok(d, 'водитель не пропущен молча');
  assert.strictEqual(d.point_rate, 0);
  assert.strictEqual(d.points, 1);
  assert.strictEqual(d.total, 0);
  assert.strictEqual(d.rate_missing, true);

  // Override в PayRates спасает расчёт даже при стёртом дефолте
  ctx.api.savePayRate(owner, 'usr_d1', { point_rate: 250 });
  const d2 = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d2.total, 250);
  assert.strictEqual(d2.rate_missing, false);
});

test('listPayAdjustments: список прачки с именами, фильтры, права', () => {
  const ctx = makeCtx();
  seedLaundry2();
  const owner = loginOwner();

  ctx.api.savePayAdjustment(owner, 'usr_w1', TODAY, 500, 'премия');
  ctx.api.savePayAdjustment(owner, 'usr_w1', TOMORROW, -300, 'штраф');
  ctx.api.savePayAdjustment(owner, 'usr_d1', TODAY, 200, 'подъёмы до P2');
  // Корректировка на чужой прачке (напрямую в БД — API её не пропустит)
  ctx.db.appendRowTenant_('PayAdjustments', {
    id: 'adj_x1', user_id: 'usr_w2', date: TODAY, amount: '999',
    comment: 'чужая', created_by: 'Владелец 2', created_at: TODAY + ' 10:00:00'
  }, '2');

  // Все корректировки своей прачки, с именами, в порядке записи
  const all = ctx.api.listPayAdjustments(owner);
  assert.ok(all.ok);
  assert.strictEqual(all.adjustments.length, 3, 'чужая прачка не видна');
  const a0 = all.adjustments[0];
  assert.ok(a0.id.indexOf('adj_') === 0);
  assert.strictEqual(a0.user_id, 'usr_w1');
  assert.strictEqual(a0.name, 'Работник');
  assert.strictEqual(a0.date, TODAY);
  assert.strictEqual(a0.amount, 500);
  assert.strictEqual(a0.comment, 'премия');
  assert.ok(a0.created_by.indexOf('Владелец') === 0);
  assert.ok(a0.created_at);

  // Фильтр по user_id
  const byUser = ctx.api.listPayAdjustments(owner, 'usr_d1');
  assert.strictEqual(byUser.adjustments.length, 1);
  assert.strictEqual(byUser.adjustments[0].amount, 200);

  // Фильтр по периоду
  const byPeriod = ctx.api.listPayAdjustments(owner, '', TOMORROW, TOMORROW);
  assert.deepStrictEqual(byPeriod.adjustments.map(a => a.amount), [-300]);
  const range = ctx.api.listPayAdjustments(owner, 'usr_w1', TODAY, TOMORROW);
  assert.strictEqual(range.adjustments.length, 2);

  // Права и валидация
  assert.strictEqual(ctx.api.listPayAdjustments(loginWorker()).error, 'Нет доступа');
  assert.strictEqual(ctx.api.listPayAdjustments(loginDriver()).error, 'Нет доступа');
  assert.ok(!ctx.api.listPayAdjustments(owner, '', TOMORROW, TODAY).ok);
  assert.ok(!ctx.api.listPayAdjustments(owner, '', '12.08.2026', '').ok);
});

test('getPayroll: owner и неактивные сотрудники в расчёт не входят', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  // Неактивный работник
  seedUser('usr_off', '1', 'Уволенный', 'worker', 'off1', 'off-pass');
  const row = ctx.db.findById_('Users', 'usr_off');
  row.obj.active = 'нет';
  ctx.db.updateRow_('Users', row.rowNumber, row.obj);

  const res = ctx.api.getPayroll(owner, TODAY, TODAY);
  assert.ok(res.ok);
  assert.ok(res.employees.every(e => e.role !== 'owner'));
  assert.ok(!employeeOf(res, 'usr_off'));
  assert.deepStrictEqual(res.employees.map(e => e.user_id).sort(), ['usr_d1', 'usr_w1']);
});

// --- P3.1: дефолтные ставки прачки (listPaySettings/savePaySettings) ---

test('listPaySettings: встроенные дефолты, затем значения из Settings', () => {
  const ctx = makeCtx();
  const owner = loginOwner();

  const def = ctx.api.listPaySettings(owner);
  assert.ok(def.ok);
  assert.deepStrictEqual(def.settings, {
    point_rate: 250, lift_floor_rate: 100, shift_base: 4000, shift_norm_hours: 12
  });

  ctx.db.setTenantSetting_('1', 'PAY_POINT_RATE', '300');
  ctx.db.invalidateRefCache_();
  const r = ctx.api.listPaySettings(owner);
  assert.strictEqual(r.settings.point_rate, 300);
  assert.strictEqual(r.settings.lift_floor_rate, 100);

  assert.strictEqual(ctx.api.listPaySettings(loginWorker()).error, 'Нет доступа');
  assert.strictEqual(ctx.api.listPaySettings(loginDriver()).error, 'Нет доступа');
});

test('savePaySettings: новый дефолт действует, override в PayRates важнее', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';
  seedVisit(ctx, { date: TODAY, delivered_at: ts });

  const r = ctx.api.savePaySettings(owner, { point_rate: 300, junk: 'ignored' });
  assert.ok(r.ok);
  const d = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d.point_rate, 300);
  assert.strictEqual(d.total, 300);
  assert.strictEqual(d.rate_missing, false);

  // Индивидуальный override перекрывает новый дефолт
  ctx.api.savePayRate(owner, 'usr_d1', { point_rate: 280 });
  const d2 = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d2.point_rate, 280);
  assert.strictEqual(d2.total, 280);

  // Событие в Log
  const ev = ctx.db.readAll_('Log').filter(e => e.action === 'pay_settings_set');
  assert.strictEqual(ev.length, 1);
  assert.ok(ev[0].details.indexOf('point_rate') !== -1);

  // Права
  assert.strictEqual(ctx.api.savePaySettings(loginWorker(), { point_rate: 1 }).error, 'Нет доступа');
  assert.strictEqual(ctx.api.savePaySettings(loginDriver(), { point_rate: 1 }).error, 'Нет доступа');
});

test('savePaySettings: пустое значение удаляет ключ → встроенный дефолт, не rate_missing', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';
  seedVisit(ctx, { date: TODAY, delivered_at: ts });

  ctx.api.savePaySettings(owner, { point_rate: 300 });
  assert.strictEqual(employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1').point_rate, 300);

  // Очищаем поле — ключ Settings удаляется, действует встроенный дефолт 250
  const r = ctx.api.savePaySettings(owner, { point_rate: '' });
  assert.ok(r.ok);
  const rows = ctx.db.findRowsByTenant_('Settings', s => s.key === 'PAY_POINT_RATE', 10, '1');
  assert.strictEqual(rows.length, 0, 'ключ удалён, а не записан пустым');
  const d = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d.point_rate, 250);
  assert.strictEqual(d.rate_missing, false);
});

test('savePaySettings: нечисло/отрицательное — ошибка, настройка не меняется', () => {
  const ctx = makeCtx();
  const owner = loginOwner();

  assert.ok(!ctx.api.savePaySettings(owner, { point_rate: 'abc' }).ok);
  assert.ok(!ctx.api.savePaySettings(owner, { point_rate: -5 }).ok);
  const rows = ctx.db.findRowsByTenant_('Settings', s => s.key.indexOf('PAY_') === 0, 10, '1');
  assert.strictEqual(rows.length, 0);
  assert.deepStrictEqual(ctx.api.listPaySettings(owner).settings, {
    point_rate: 250, lift_floor_rate: 100, shift_base: 4000, shift_norm_hours: 12
  });
});

test('savePaySettings: тенантность — ставки прачки 2 не влияют на прачку 1', () => {
  const ctx = makeCtx();
  seedLaundry2();
  const owner = loginOwner();
  const ts = TODAY + ' 12:00:00';
  seedVisit(ctx, { date: TODAY, delivered_at: ts });

  // Ставка прачки 2 напрямую в БД
  ctx.db.setTenantSetting_('2', 'PAY_POINT_RATE', '999');
  ctx.db.invalidateRefCache_();

  const d = employeeOf(ctx.api.getPayroll(owner, TODAY, TODAY), 'usr_d1');
  assert.strictEqual(d.point_rate, 250);

  // Сохранение на прачке 1 не трогает прачку 2
  ctx.api.savePaySettings(owner, { point_rate: 300 });
  const rows2 = ctx.db.findRowsByTenant_('Settings', s => s.key === 'PAY_POINT_RATE', 10, '2');
  assert.strictEqual(rows2.length, 1);
  assert.strictEqual(rows2[0].obj.value, '999');
});
