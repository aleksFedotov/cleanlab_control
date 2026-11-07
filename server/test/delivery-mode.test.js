const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, loginOwner, loginDriver, loginWorker, seedUser, seedLaundry2,
  loginDriver2, TODAY, TOMORROW } = require('./helpers/serverMocks');

function fixture() {
  const ctx = makeCtx();
  const owner = loginOwner();
  const first = loginDriver();
  seedUser('second', '1', 'Второй', 'driver', 'second', 'driver-pass');
  const second = ctx.auth.login('second', 'driver-pass').token;
  function visit(name, date = TODAY) {
    const c = ctx.api.saveClient(owner, { name, type: 'отель' }).client;
    const v = ctx.api.addDeliveryVisit(owner, c.id, date).visit;
    assert.ok(ctx.api.addManualClean(owner, c.id, 10, 5, 2, 'Остаток').ok);
    return v;
  }
  return { ctx, owner, first, second, visit };
}

test('без настроек общий развоз восстанавливает прежний доступ и общий груз', () => {
  const { ctx, owner, first, second, visit } = fixture();
  const a = visit('Общая точка');
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode, 'shared');
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).default_mode, 'shared');
  assert.equal(ctx.api.getDriverRoute(owner, TODAY).default_mode, 'shared');
  assert.equal(ctx.api.getDriverRoute(first, TODAY).default_mode, undefined);
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d1').ok);
  for (const driver of [first, second]) assert.deepEqual(ctx.api.getDriverRoute(driver, TODAY).visits.map(v => v.id), [a.id]);
  assert.equal(ctx.api.driverTakeAllClean(second, TODAY).taken, 1);
  assert.equal(ctx.api.getDriverRoute(first, TODAY).cargo.clean_bags, 2);
  assert.ok(ctx.api.driverAction(first, a.id, 'both', 4).ok);
  assert.equal(ctx.api.driverHandover(second).handed, 1);
  assert.equal(ctx.db.findById_('Deliveries', a.id).obj.driver_id, 'usr_d1');
  assert.equal(ctx.api.getMyPayroll(first, TODAY, TODAY).ok, true);
});

test('режим даты независим от дефолта, истории и других дат; назначения сохраняются', () => {
  const { ctx, owner, first, second, visit } = fixture();
  const a = visit('Назначенная');
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d1').ok);
  assert.ok(ctx.api.setDeliveryMode(owner, TODAY, 'assigned').ok);
  assert.equal(ctx.api.getDriverRoute(second, TODAY).visits.length, 0);
  assert.ok(ctx.api.setDeliveryMode(owner, TODAY, 'shared').ok);
  assert.equal(ctx.db.findById_('Deliveries', a.id).obj.assigned_driver_id, 'usr_d1');
  assert.equal(ctx.api.getDriverRoute(second, TODAY).visits.length, 1);
  assert.ok(ctx.api.setDefaultDeliveryMode(owner, 'assigned').ok);
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode, 'shared'); // explicit override
  assert.equal(ctx.api.getDeliveryVisits(owner, TOMORROW).mode, 'assigned');
  assert.equal(ctx.api.getDeliveryVisits(owner, '2026-08-11').mode, 'shared');
  assert.equal(ctx.api.getDriverRoute(first, TODAY).mode, 'shared');
  const audit = ctx.db.readAll_('Log').filter(e => e.action.startsWith('delivery_'));
  assert.equal(audit.length, 3);
});

test('дефолт меняет сегодняшний и будущие неначатые дни без отдельной настройки', () => {
  const { ctx, owner, first, visit } = fixture();
  const a = visit('Сегодня');
  assert.ok(ctx.api.setDefaultDeliveryMode(owner, 'assigned').ok);
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode, 'assigned');
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d1').ok);
  assert.ok(ctx.api.driverAction(first, a.id, 'empty').ok);
  const finance = ctx.api.getFinanceSummary(owner, TODAY, TODAY);
  const payroll = ctx.api.getPayroll(owner, TODAY, TODAY);
  assert.ok(ctx.api.setDefaultDeliveryMode(owner, 'shared').ok);
  assert.deepEqual(ctx.api.getFinanceSummary(owner, TODAY, TODAY), finance);
  assert.deepEqual(ctx.api.getPayroll(owner, TODAY, TODAY), payroll);
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode, 'assigned');
  assert.equal(ctx.api.getDeliveryVisits(owner, TOMORROW).mode, 'shared');
  assert.ok(ctx.api.getDeliveryVisits(owner, TODAY).mode_locked);
});

test('режим фиксируется только при успехе; возврат и исправление не снимают фиксацию', () => {
  const { ctx, owner, first, visit } = fixture();
  const a = visit('Груз');
  assert.equal(ctx.api.driverAction(first, a.id, 'deliver_clean').ok, false);
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode_locked, false);
  assert.equal(ctx.api.driverTakeClean(first, ['missing']).taken, 0);
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode_locked, false);
  assert.equal(ctx.api.driverTakeClean(first, [a.id]).taken, 1);
  assert.ok(ctx.api.getDeliveryVisits(owner, TODAY).mode_locked);
  assert.equal(ctx.api.setDeliveryMode(owner, TODAY, 'assigned').ok, false);
  assert.ok(ctx.api.driverReturnClean(first, a.id).ok);
  assert.equal(ctx.api.setDeliveryMode(owner, TODAY, 'assigned').ok, false);
  assert.ok(ctx.api.driverAction(first, a.id, 'empty').ok);
  assert.ok(ctx.api.correctVisit(first, a.id, 'undo_empty').ok);
  assert.equal(ctx.api.setDeliveryMode(owner, TODAY, 'assigned').ok, false);
  assert.ok(ctx.api.setDefaultDeliveryMode(owner, 'assigned').ok);
  assert.equal(ctx.api.getDriverRoute(first, TODAY).mode, 'shared');
});

test('при переключении до действия доступ перепроверяется; начатый визит нельзя перенести', () => {
  const { ctx, owner, second, visit } = fixture();
  const a = visit('Гонка');
  assert.equal(ctx.api.getDriverRoute(second, TODAY).visits.length, 1);
  assert.ok(ctx.api.setDeliveryMode(owner, TODAY, 'assigned').ok);
  assert.equal(ctx.api.driverAction(second, a.id, 'take_clean').ok, false);
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode_locked, false);
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, 'second').ok);
  assert.ok(ctx.api.driverAction(second, a.id, 'take_clean').ok);
  assert.equal(ctx.api.moveDeliveryVisit(owner, a.id, TOMORROW).ok, false);
  assert.equal(ctx.api.setDeliveryMode(owner, TODAY, 'shared').ok, false);
});

test('ошибка записи откатывает фиксацию режима вместе с погрузкой', () => {
  const { ctx, owner, first, visit } = fixture();
  const a = visit('Откат транзакции');
  const storage = ctx.db.readAll_('Storage');
  const originalUpdate = ctx.db.updateRow_;
  ctx.db.updateRow_ = function (sheet, ...args) {
    if (sheet === 'Deliveries') throw new Error('write failed');
    return originalUpdate(sheet, ...args);
  };
  try {
    assert.throws(() => ctx.api.driverAction(first, a.id, 'take_clean'), /write failed/);
  } finally {
    ctx.db.updateRow_ = originalUpdate;
  }
  assert.deepEqual(ctx.db.readAll_('Storage'), storage);
  assert.equal(ctx.db.findById_('Deliveries', a.id).obj.clean_taken_at, '');
  assert.equal(ctx.api.getDeliveryVisits(owner, TODAY).mode_locked, false);
  assert.ok(ctx.api.setDeliveryMode(owner, TODAY, 'assigned').ok);
});

test('груз, возврат и сдача грязного учитывают режим каждого дня, а не открытой даты', () => {
  const { ctx, owner, first, second, visit } = fixture();
  const common = visit('Общий');
  const assigned = visit('Личный', TOMORROW);
  assert.ok(ctx.api.setDeliveryMode(owner, TOMORROW, 'assigned').ok);
  assert.ok(ctx.api.assignDeliveryDriver(owner, assigned.id, 'usr_d1').ok);
  assert.ok(ctx.api.driverAction(second, common.id, 'take_clean').ok);
  assert.ok(ctx.api.driverAction(first, assigned.id, 'take_clean').ok);
  assert.equal(ctx.api.getDriverRoute(second, TOMORROW).cargo.clean_bags, 2);
  assert.equal(ctx.api.getDriverRoute(first, TODAY).cargo.clean_bags, 4);
  assert.equal(ctx.api.driverReturnClean(second, assigned.id).ok, false);
  assert.ok(ctx.api.driverReturnClean(first, common.id).ok);
  assert.ok(ctx.api.driverAction(first, common.id, 'pickup_dirty').ok);
  assert.ok(ctx.api.driverAction(first, assigned.id, 'pickup_dirty').ok);
  assert.equal(ctx.api.driverHandover(second).handed, 1);
  assert.equal(ctx.api.getDriverRoute(first, TODAY).cargo.dirty_points, 1);
  assert.equal(ctx.api.driverHandover(first).handed, 1);
});

test('режимы доступны только владельцу и изолированы по прачечной; входные данные проверяются', () => {
  const { ctx, owner, first } = fixture();
  seedLaundry2();
  assert.ok(ctx.api.setDefaultDeliveryMode(owner, 'assigned').ok);
  assert.equal(ctx.api.getDriverRoute(loginDriver2(), TODAY).mode, 'shared');
  for (const token of [first, loginWorker(), 'missing']) {
    assert.equal(ctx.api.setDeliveryMode(token, TODAY, 'shared').ok, false);
    assert.equal(ctx.api.setDefaultDeliveryMode(token, 'shared').ok, false);
  }
  for (const mode of ['', null, 'wrong', {}, 1]) {
    assert.equal(ctx.api.setDefaultDeliveryMode(owner, mode).ok, false);
    assert.equal(ctx.api.setDeliveryMode(owner, TODAY, mode).ok, false);
  }
  for (const date of ['', null, '2026-02-31', '2026-13-01', '12.08.2026']) {
    assert.equal(ctx.api.setDeliveryMode(owner, date, 'shared').ok, false);
  }
});

test('обновление сохраняет режим начатых дней, не меняет визиты и идемпотентно', () => {
  const ctx = makeCtx();
  const d = ctx.db.openTest(':memory:');
  d.prepare('DELETE FROM Settings WHERE key = ?').run('DELIVERY_MODES_INITIALIZED');
  const insert = d.prepare('INSERT INTO Deliveries (id, laundry_id, date, status, assigned_driver_id) VALUES (?, ?, ?, ?, ?)');
  insert.run('a', '1', TODAY, 'picked', 'usr_d1');
  insert.run('b', '2', TODAY, 'picked', '');
  insert.run('c', '1', TOMORROW, 'planned', 'usr_d1');
  const before = d.prepare('SELECT * FROM Deliveries').all();
  ctx.db.migrateDeliveryModes_(d);
  const rows = d.prepare("SELECT * FROM Settings WHERE key LIKE 'DELIVERY_MODE_DAY_%' ORDER BY laundry_id").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].value), { mode: 'assigned', locked: true, explicit: false });
  assert.deepEqual(JSON.parse(rows[1].value), { mode: 'shared', locked: true, explicit: false });
  assert.deepEqual(d.prepare('SELECT * FROM Deliveries').all(), before);
  ctx.db.migrateDeliveryModes_(d);
  assert.deepEqual(d.prepare("SELECT * FROM Settings WHERE key LIKE 'DELIVERY_MODE_DAY_%' ORDER BY laundry_id").all(), rows);
  d.close();
});
