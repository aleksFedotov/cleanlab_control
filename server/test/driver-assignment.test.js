const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, loginOwner, loginWorker, loginDriver, seedUser, seedLaundry2, TODAY } = require('./helpers/serverMocks');

test('массовое назначение атомарно, изолировано и обрабатывает повторные id один раз', () => {
  const { ctx, owner, first, a, b, free } = fixture();
  assert.equal(ctx.api.assignDeliveryDrivers(first, [a.id], 'usr_d3').ok, false);
  for (const ids of [[], null, [null], [a.id, 'missing']]) {
    assert.equal(ctx.api.assignDeliveryDrivers(owner, ids, 'usr_d3').ok, false);
  }
  seedLaundry2();
  seedUser('inactive_batch', '1', 'Неактивный', 'driver', 'inactive_batch', 'pass');
  const inactive = ctx.db.findById_('Users', 'inactive_batch');
  inactive.obj.active = 'нет';
  ctx.db.updateRow_('Users', inactive.rowNumber, inactive.obj);
  // A real foreign row also must not be addressable by this owner.
  const foreignId = 'foreign_batch';
  ctx.db.appendRow_('Deliveries', { id: foreignId, laundry_id: '2', status: 'planned', date: TODAY });
  for (const driver of ['', 'usr_d2', 'usr_w1', 'inactive_batch', 'missing']) {
    assert.equal(ctx.api.assignDeliveryDrivers(owner, [a.id], driver).ok, false);
  }
  const before = ctx.db.readAll_('Deliveries');
  assert.equal(ctx.api.assignDeliveryDrivers(owner, [a.id, foreignId], 'usr_d3').ok, false);
  assert.deepEqual(ctx.db.readAll_('Deliveries'), before);
  const logsBefore = ctx.db.readAll_('Log').length;
  for (const status of ['cancelled', 'picked']) {
    const row = ctx.db.findById_('Deliveries', b.id);
    row.obj.status = status;
    ctx.db.updateRow_('Deliveries', row.rowNumber, row.obj);
    const snapshot = ctx.db.readAll_('Deliveries');
    assert.equal(ctx.api.assignDeliveryDrivers(owner, [free.id, b.id], 'usr_d1').ok, false);
    assert.deepEqual(ctx.db.readAll_('Deliveries'), snapshot);
  }
  assert.equal(ctx.db.readAll_('Log').length, logsBefore);
  const reset = ctx.db.findById_('Deliveries', b.id);
  reset.obj.status = 'planned';
  ctx.db.updateRow_('Deliveries', reset.rowNumber, reset.obj);
  assert.ok(ctx.api.driverAction(first, a.id, 'take_clean').ok);
  const started = ctx.db.readAll_('Deliveries');
  assert.equal(ctx.api.assignDeliveryDrivers(owner, [free.id, a.id], 'usr_d3').ok, false);
  assert.deepEqual(ctx.db.readAll_('Deliveries'), started);
  assert.ok(ctx.api.driverReturnClean(first, a.id).ok);
  const auditCount = ctx.db.readAll_('Log').length;
  const result = ctx.api.assignDeliveryDrivers(owner, [a.id, free.id, a.id], 'usr_d3');
  assert.equal(result.assigned, 2);
  assert.equal(ctx.db.findById_('Deliveries', free.id).obj.assigned_driver_id, 'usr_d3');
  assert.equal(ctx.db.findById_('Deliveries', a.id).obj.assigned_driver_id, 'usr_d3');
  assert.equal(ctx.db.findById_('Deliveries', b.id).obj.assigned_driver_id, 'usr_d3');
  const audit = ctx.db.readAll_('Log').slice(auditCount);
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map(event => event.entity).sort(), [a.id, free.id].sort());
  assert.ok(audit.every(event => event.action === 'visit_assign_driver' && event.laundry_id === '1'));
});

function fixture() {
  const ctx = makeCtx();
  const owner = loginOwner();
  const first = loginDriver();
  seedUser('usr_d3', '1', 'Второй водитель', 'driver', 'driver3', 'driver-pass');
  const second = ctx.auth.login('driver3', 'driver-pass').token;
  function visit(name, driverId) {
    const client = ctx.api.saveClient(owner, { name, type: 'отель' }).client;
    const v = ctx.api.addDeliveryVisit(owner, client.id, TODAY).visit;
    if (driverId) assert.ok(ctx.api.assignDeliveryDriver(owner, v.id, driverId).ok);
    assert.ok(ctx.api.addManualClean(owner, client.id, 10, 5, 2, 'Тестовый остаток').ok);
    return v;
  }
  return { ctx, owner, first, second, a: visit('А', 'usr_d1'), b: visit('Б', 'usr_d3'), free: visit('Без назначения') };
}

test('маршруты разделены: неназначенное видно только владельцу, ответ не содержит данные учёток', () => {
  const { ctx, owner, first, second, a, b, free } = fixture();
  assert.deepEqual(ctx.api.getDriverRoute(first, TODAY).visits.map(v => v.id), [a.id]);
  assert.deepEqual(ctx.api.getDriverRoute(second, TODAY).visits.map(v => v.id), [b.id]);
  const all = ctx.api.getDeliveryVisits(owner, TODAY);
  assert.deepEqual(all.visits.map(v => v.id), [a.id, b.id, free.id]);
  assert.deepEqual(all.drivers, [{ id: 'usr_d1', name: 'Водитель' }, { id: 'usr_d3', name: 'Второй водитель' }]);
  assert.equal(all.visits[1].assigned_driver_name, 'Второй водитель');
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, '').ok);
  assert.equal(ctx.api.getDriverRoute(first, TODAY).visits.length, 0);
});

test('чужую и неназначенную точку нельзя изменить по известному id', () => {
  const { ctx, first, b, free } = fixture();
  const before = ctx.db.readAll_('Deliveries');
  const storage = ctx.db.readAll_('Storage');
  for (const visit of [b, free]) {
    for (const action of ['take_clean', 'pickup_dirty', 'deliver_clean', 'both', 'empty']) {
      assert.equal(ctx.api.driverAction(first, visit.id, action, 5).ok, false);
    }
    assert.equal(ctx.api.setVisitLiftFloor(first, visit.id, 8).ok, false);
    assert.equal(ctx.api.correctVisit(first, visit.id, 'undo_pickup').ok, false);
    assert.equal(ctx.api.driverReturnClean(first, visit.id).ok, false);
  }
  assert.deepEqual(ctx.db.readAll_('Deliveries'), before);
  assert.deepEqual(ctx.db.readAll_('Storage'), storage);
});

test('выборочная и массовая погрузка, груз и сдача грязного изолированы по водителю', () => {
  const { ctx, first, second, a, b, free } = fixture();
  assert.equal(ctx.api.driverTakeClean(first, [a.id, b.id, free.id]).taken, 1);
  assert.equal(ctx.api.driverTakeAllClean(second, TODAY).taken, 1);
  assert.equal(ctx.api.getDriverRoute(first, TODAY).cargo.clean_bags, 2);
  assert.equal(ctx.api.getDriverRoute(second, TODAY).cargo.clean_bags, 2);
  assert.ok(ctx.api.driverAction(first, a.id, 'both', 3).ok);
  assert.ok(ctx.api.driverAction(second, b.id, 'both', 4).ok);
  assert.equal(ctx.api.driverHandover(first).handed, 1);
  assert.equal(ctx.api.getDriverRoute(first, TODAY).cargo.dirty_points, 0);
  assert.equal(ctx.api.getDriverRoute(second, TODAY).cargo.dirty_points, 1);
  assert.equal(ctx.db.findById_('Deliveries', b.id).obj.dirty_handed_at, '');
  assert.equal(ctx.api.driverHandover(second).handed, 1);
  assert.equal(ctx.db.findById_('Deliveries', free.id).obj.clean_taken_at, '');
});

test('переназначение до работы разрешено, после погрузки заблокировано, возврат открывает переназначение', () => {
  const { ctx, owner, first, second, a } = fixture();
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d3').ok);
  assert.equal(ctx.api.driverAction(first, a.id, 'take_clean').ok, false);
  assert.ok(ctx.api.driverAction(second, a.id, 'take_clean').ok);
  assert.equal(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d1').ok, false);
  assert.equal(ctx.api.assignDeliveryDriver(owner, a.id, '').ok, false);
  assert.ok(ctx.api.driverReturnClean(second, a.id).ok);
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d1').ok);
  assert.ok(ctx.api.driverAction(first, a.id, 'pickup_dirty').ok);
  assert.equal(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d3').ok, false);
  assert.ok(ctx.api.correctVisit(first, a.id, 'undo_pickup').ok);
  assert.equal(ctx.db.findById_('Deliveries', a.id).obj.assigned_driver_id, 'usr_d1');
  assert.ok(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d3').ok);
});

test('назначение доступно только владельцу, активному водителю своей прачки и существующей точке', () => {
  const { ctx, owner, first, a } = fixture();
  seedLaundry2();
  seedUser('inactive', '1', 'Неактивный', 'driver', 'inactive', 'pass');
  const inactive = ctx.db.findById_('Users', 'inactive');
  inactive.obj.active = 'нет';
  ctx.db.updateRow_('Users', inactive.rowNumber, inactive.obj);
  for (const user of ['usr_d2', 'usr_w1', 'inactive', 'missing']) {
    assert.equal(ctx.api.assignDeliveryDriver(owner, a.id, user).ok, false);
  }
  assert.equal(ctx.api.assignDeliveryDriver(first, a.id, 'usr_d1').ok, false);
  assert.equal(ctx.api.assignDeliveryDriver(loginWorker(), a.id, 'usr_d1').ok, false);
  assert.equal(ctx.api.assignDeliveryDriver(owner, 'missing', 'usr_d1').ok, false);
  assert.equal(ctx.api.assignDeliveryDriver(owner, a.id, null).ok, false);
  assert.ok(ctx.api.removeDeliveryVisit(owner, a.id).ok);
  assert.equal(ctx.api.assignDeliveryDriver(owner, a.id, 'usr_d3').ok, false);
});

test('действие владельца сохраняет назначенного исполнителя для зарплаты и статистики', () => {
  const { ctx, owner, a } = fixture();
  assert.ok(ctx.api.driverAction(owner, a.id, 'pickup_dirty', 5).ok);
  assert.equal(ctx.db.findById_('Deliveries', a.id).obj.driver_id, 'usr_d1');
  const payroll = ctx.api.getPayroll(owner, TODAY, TODAY);
  const first = payroll.employees.find(u => u.user_id === 'usr_d1');
  const second = payroll.employees.find(u => u.user_id === 'usr_d3');
  assert.equal(first.points, 1);
  assert.equal(second.points, 0);
});

test('старые записи с исполнителем видны ему; старый груз без исполнителя назначает владелец', () => {
  const { ctx, owner, first, second, free } = fixture();
  const old = ctx.db.findById_('Deliveries', free.id);
  old.obj.driver_id = 'usr_d1';
  old.obj.status = 'picked';
  old.obj.picked_at = TODAY + ' 10:00:00';
  ctx.db.updateRow_('Deliveries', old.rowNumber, old.obj);
  assert.ok(ctx.api.getDriverRoute(first, TODAY).visits.some(v => v.id === free.id));
  assert.ok(!ctx.api.getDriverRoute(second, TODAY).visits.some(v => v.id === free.id));
  assert.equal(ctx.api.getDriverRoute(first, TODAY).cargo.dirty_points, 1);
  assert.equal(ctx.api.driverHandover(first).handed, 1);
  old.obj.driver_id = '';
  old.obj.status = 'planned';
  old.obj.picked_at = '';
  old.obj.clean_taken_at = TODAY + ' 09:00:00';
  old.obj.clean_bags = '3';
  ctx.db.updateRow_('Deliveries', old.rowNumber, old.obj);
  assert.ok(ctx.api.assignDeliveryDriver(owner, free.id, 'usr_d3').ok);
  assert.equal(ctx.api.getDriverRoute(second, TODAY).cargo.clean_bags, 3);
  assert.equal(ctx.api.assignDeliveryDriver(owner, free.id, 'usr_d1').ok, false);
});
