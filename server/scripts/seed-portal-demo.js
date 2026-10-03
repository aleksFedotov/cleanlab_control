// Демо-сид клиентского портала (P1) для ручной проверки.
// Запуск из server/:  node scripts/seed-portal-demo.js
//
// Делает «Демо-клиент 1» выделенным клиентом портал-демо:
//   - аккаунт портала: логин demo1, пароль demo1 (upsert, как из карточки клиента);
//   - контролируемая линейка заявок во всех ключевых статусах трека.
//
// ВАЖНО: все операционные строки этого клиента (визиты, стирки, склад, заявки)
// перед посевом УДАЛЯЮТСЯ. Иначе любой визит delivered/both после даты забора
// матчится треком как «визит выдачи» и сценарии схлопываются в «Доставлено».
// Справочник, тарифы, аккаунт и остальные демо-клиенты не трогаются.
// Скрипт идемпотентен: перезапуск пересоздаёт строки заново.
//
// Раскладка заявок (даты от сегодня, окна стирок [дата-1, дата] не пересекаются):
//   заявка sent на завтра + planned-визит завтра  → «Заявка принята» (правка открыта)
//   забор сегодня, грязное на складе, стирки нет  → «В прачечной, в очереди»
//   забор -3, стирка in_progress                  → «Стирается»
//   забор -6, стирка done + разбивка              → «Готово, на складе» + факт
//   забор -7, без стирки и склада                 → «На пути в прачечную»
//   забор -9, стирка issued, выдача -8 delivered  → «Доставлено» + факт
//   забор -12, стирка no_linen                    → «Бельё не передано»
// «Водитель направляется» возникает сам, когда владелец планирует визит на сегодня.

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cleanlab.sqlite');

const { SHEETS } = require('../schema');
const db = require('../db');
const { nowStr_, todayStr_ } = require('../audit');
const { addDaysStr_ } = require('../core');
const { setup, seedDemoData } = require('../setup');
const { setClientAccess } = require('../api/users');

const LAUNDRY = '1';
const LOGIN = 'demo1';
const PASSWORD = 'demo1';

function delBy_(sheet, pred) {
  db.findRowsBy_(sheet, pred, 100000).forEach(function (r) { db.deleteRow_(sheet, r.rowNumber); });
}

// Удалить ВСЕ операционные строки клиента (визиты, стирки + разбивки, склад,
// заявки) — клиент выделен под портал-демо, чужие/старые строки иначе ломают
// сценарии (любой delivered-визит после даты забора матчится треком как выдача).
// Справочник клиентов, тарифы и аккаунт Users не трогаем.
function wipeClientDemoRows_(clientId) {
  const seedRows = function (r) {
    return String(r.client_id) === String(clientId);
  };
  const washIds = db.findRowsBy_(SHEETS.WASHES, seedRows, 100000).map(function (r) { return r.obj.id; });
  delBy_(SHEETS.WASH_ITEMS, function (wi) { return washIds.indexOf(wi.wash_id) !== -1; });
  delBy_(SHEETS.WASHES, seedRows);
  const reqIds = db.findRowsBy_(SHEETS.REQUESTS, seedRows, 100000).map(function (r) { return r.obj.id; });
  delBy_(SHEETS.REQUEST_ITEMS, function (ri) { return reqIds.indexOf(ri.request_id) !== -1; });
  delBy_(SHEETS.REQUESTS, seedRows);
  delBy_(SHEETS.DELIVERIES, seedRows);
  delBy_(SHEETS.STORAGE, seedRows);
}

function mkVisit_(clientId, date, status, extra) {
  const v = {
    id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: date, client_id: clientId,
    ord: 1, status: status, delivered_at: '', pickup: '', driver_comment: '',
    created_by: 'seed-portal', created_at: date + ' 08:00:00',
    clean_taken_at: '', clean_bags: '', picked_at: '', dirty_handed_at: '',
    pickup_only: '', lift_floor: '', driver_id: '', laundry_id: LAUNDRY
  };
  Object.assign(v, extra || {});
  db.appendRow_(SHEETS.DELIVERIES, v);
  return v.id;
}

function mkRequest_(clientId, visitId, date, status, bags, comment, items) {
  const req = {
    id: db.nextId_(SHEETS.REQUESTS, 'req'), client_id: clientId,
    laundry_id: LAUNDRY, visit_id: visitId || '', desired_date: date,
    bags: String(bags || 0), comment: comment || '', status: status,
    created_by: 'seed-portal', created_at: date + ' 08:00:00', updated_at: date + ' 08:00:00'
  };
  db.appendRow_(SHEETS.REQUESTS, req);
  (items || []).forEach(function (it) {
    db.appendRow_(SHEETS.REQUEST_ITEMS, {
      id: db.nextId_(SHEETS.REQUEST_ITEMS, 'ri'),
      request_id: req.id, item_type_id: it[0], qty: String(it[1])
    });
  });
  return req.id;
}

function mkWash_(clientId, date, status, extra) {
  const w = {
    id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
    wash_date: date, issue_date: date, status: status,
    dirty_weight_kg: '', items_total: '', comment: '',
    created_by: 'seed-portal', created_at: date + ' 08:00:00',
    started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: '',
    bags: '', laundry_id: LAUNDRY
  };
  Object.assign(w, extra || {});
  db.appendRow_(SHEETS.WASHES, w);
  return w.id;
}

function mkWashItems_(washId, items) {
  items.forEach(function (it) {
    db.appendRow_(SHEETS.WASH_ITEMS, {
      id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'),
      wash_id: washId, item_type_id: it[0], qty: String(it[1]), storage_id: ''
    });
  });
}

function main() {
  db.open();
  setup();
  seedDemoData(LAUNDRY); // идемпотентно: нужен сам клиент и справочники

  const client = db.getClients_(LAUNDRY).filter(function (c) {
    return c.name === 'Демо-клиент 1';
  })[0];
  if (!client) throw new Error('Демо-клиент 1 не найден даже после seedDemoData');
  const cid = client.id;

  wipeClientDemoRows_(cid);

  const today = todayStr_();
  const d = function (off) { return addDaysStr_(today, off); };

  // Аккаунт портала (upsert, как кнопка в карточке клиента)
  const session = { userId: 'seed-portal', name: 'seed', role: 'owner', laundryId: LAUNDRY };
  const acc = setClientAccess(session, cid, LOGIN, PASSWORD);
  if (!acc.ok) throw new Error('setClientAccess: ' + acc.error);

  // 1. Заявка на завтра + planned-визит (предвыбор даты, правка открыта).
  // Заявка привязана к визиту — так её видит водитель в маршруте (мешки, позиции).
  const vTomorrow = mkVisit_(cid, d(1), 'planned');
  mkRequest_(cid, vTomorrow, d(1), 'sent', 3, 'Забрать у администратора на ресепшне',
    [['itm_1', 10], ['itm_2', 20]]);

  // 2. Забор сегодня, стирка заведена (planned) — «В прачечной, в очереди».
  // Открытую dirty-запись склада НЕ сидим: трек ищет её без верхней границы
  // даты, и она перекрыла бы «На пути в прачечную» у более старой заявки.
  const vToday = mkVisit_(cid, today, 'picked', {
    pickup: 'да', picked_at: today + ' 09:10:00', dirty_handed_at: today + ' 11:00:00'
  });
  mkRequest_(cid, vToday, today, 'picked', 2, '', [['itm_3', 15], ['itm_5', 10]]);
  mkWash_(cid, today, 'planned');

  // 3. Забор -3, стирка идёт — «Стирается»
  const v3 = mkVisit_(cid, d(-3), 'picked', {
    pickup: 'да', picked_at: d(-3) + ' 09:20:00', dirty_handed_at: d(-3) + ' 11:00:00'
  });
  mkRequest_(cid, v3, d(-3), 'picked', 4, '', [['itm_1', 12], ['itm_2', 18], ['itm_7', 5]]);
  mkWash_(cid, d(-3), 'in_progress', { started_at: d(-3) + ' 13:00:00' });

  // 4. Забор -6, постирано — «Готово, на складе» + фактический пересчёт
  const v6 = mkVisit_(cid, d(-6), 'picked', {
    pickup: 'да', picked_at: d(-6) + ' 09:15:00', dirty_handed_at: d(-6) + ' 11:00:00'
  });
  mkRequest_(cid, v6, d(-6), 'picked', 3, '', [['itm_1', 20], ['itm_2', 32]]);
  const w6 = mkWash_(cid, d(-6), 'done', {
    dirty_weight_kg: '18.5', items_total: '52', bags: '3',
    started_at: d(-6) + ' 12:00:00', done_at: d(-6) + ' 15:30:00'
  });
  mkWashItems_(w6, [['itm_1', 20], ['itm_2', 32]]);

  // 5. Забор -7, грязное ещё везут — «На пути в прачечную»
  const v7 = mkVisit_(cid, d(-7), 'picked', {
    pickup: 'да', picked_at: d(-7) + ' 16:40:00'
  });
  mkRequest_(cid, v7, d(-7), 'picked', 1, '', [['itm_4', 8]]);

  // 6. Забор -9, чистое выдано визитом -8 — «Доставлено» + факт
  const v9 = mkVisit_(cid, d(-9), 'picked', {
    pickup: 'да', picked_at: d(-9) + ' 09:05:00', dirty_handed_at: d(-9) + ' 11:00:00'
  });
  mkRequest_(cid, v9, d(-9), 'picked', 4, '', [['itm_2', 25], ['itm_8', 6]]);
  const w9 = mkWash_(cid, d(-9), 'issued', {
    issue_date: d(-8), dirty_weight_kg: '22', items_total: '31', bags: '4',
    started_at: d(-9) + ' 12:00:00', done_at: d(-9) + ' 15:00:00', issued_at: d(-8) + ' 10:30:00'
  });
  mkWashItems_(w9, [['itm_2', 25], ['itm_8', 6]]);
  mkVisit_(cid, d(-8), 'delivered', {
    clean_taken_at: d(-8) + ' 10:30:00', clean_bags: '4', delivered_at: d(-8) + ' 12:15:00'
  });

  // 7. Забор -12, бельё не передано — особый статус
  const v12 = mkVisit_(cid, d(-12), 'picked', {
    pickup: 'да', picked_at: d(-12) + ' 09:30:00'
  });
  mkRequest_(cid, v12, d(-12), 'picked', 2, '', [['itm_1', 10]]);
  mkWash_(cid, d(-12), 'no_linen', { comment: 'Бельё не передано при заборе' });

  db.invalidateRefCache_();

  console.log('seed-portal-demo: готово');
  console.log('  Клиент: «Демо-клиент 1» (' + cid + '), прачка ' + LAUNDRY);
  console.log('  Вход в портал: ' + LOGIN + ' / ' + PASSWORD);
  console.log('  Заявки: 7 шт. — sent(завтра), в очереди(сегодня), стирается(-3),');
  console.log('          готово(-6), на пути в прачечную(-7), доставлено(-9), не передано(-12)');
  console.log('  Старые авто-демо строки этого клиента удалены (остальные клиенты не тронуты).');
}

main();
