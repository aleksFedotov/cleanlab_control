// Сид сценария «дубль на складе» для ручной проверки защиты от повторного ввода:
// у клиента бельё постирано накануне (стирка вчера, статус stored, чистое на складе),
// а на завтра стоит визит развоза. Сегодня авто-карточка создаётся как чек-поинт
// «проверить склад»: работник подтверждает already_clean вместо повторной стирки.
// До фикса работник был вынужден «постирать» карточку повторно (дубль на складе
// и в счёте); теперь есть баннеры и отмена ошибочного «В работу».
//
// Запуск:  node scripts/seed-dup-scenario.js [имя клиента]
// Путь к БД: DB_PATH из env, иначе server/data/cleanlab.sqlite.
// Идемпотентно: повторный запуск с тем же именем ничего не дублирует.

const db = require('../db');
const { SHEETS } = require('../schema');

const CLIENT_NAME = process.argv[2] || 'Нотебург (тест дубля)';
const tz = process.env.APP_TZ || 'Europe/Moscow';
function dayStr(offset) {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d);
}
const TODAY = dayStr(0);
const YESTERDAY = dayStr(-1);
const TOMORROW = dayStr(1);

db.open();
const laundry = db.readAll_('Laundries').filter(function (l) { return l.active === 'да'; })[0];
if (!laundry) { console.error('Нет активной прачки'); process.exit(1); }
const laundryId = laundry.id;
console.log('Прачка: [' + laundryId + '] ' + laundry.name + ', даты: вчера ' + YESTERDAY +
  ', сегодня ' + TODAY + ', завтра ' + TOMORROW);

// Клиент (или существующий с таким именем)
let client = db.getClients_(laundryId).filter(function (c) { return c.name === CLIENT_NAME; })[0];
if (!client) {
  client = {
    id: db.nextId_(SHEETS.CLIENTS, 'cli'), name: CLIENT_NAME, contact: '', address: 'ул. Тестовая, 1',
    type: 'отель', active: 'да', comment: 'сид seed-dup-scenario', item_types: '', accounting: '',
    inn: '', kpp: '', legal_address: '', laundry_id: laundryId, access_note: '', paid_delivery: ''
  };
  db.appendRowTenant_(SHEETS.CLIENTS, client, laundryId);
  db.invalidateRefCache_();
  console.log('Клиент создан: ' + client.id);
} else {
  console.log('Клиент уже есть: ' + client.id);
}

// Стирка «постирана вчера» (stored, без даты выдачи → «На складе»)
let wash = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
  return w.client_id === client.id && w.wash_date === YESTERDAY && w.status === 'stored';
}, 10, laundryId).map(function (r) { return r.obj; })[0];
if (!wash) {
  wash = {
    id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: client.id,
    wash_date: YESTERDAY, issue_date: '', status: 'stored',
    dirty_weight_kg: '33', items_total: '64', comment: '', created_by: 'seed',
    created_at: YESTERDAY + ' 18:00', started_at: YESTERDAY + ' 10:00',
    done_at: YESTERDAY + ' 18:00', issued_at: '', deferred_from: '', deferred_reason: '',
    bags: '2', laundry_id: laundryId
  };
  db.appendRowTenant_(SHEETS.WASHES, wash, laundryId);
  db.appendRow_(SHEETS.WASH_ITEMS, {
    id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: wash.id,
    item_type_id: 'itm_2', qty: '64', storage_id: ''
  });
  // Открытая clean-запись склада — чистое лежит на полке
  db.appendRowTenant_(SHEETS.STORAGE, {
    id: db.nextId_(SHEETS.STORAGE, 'st'), client_id: client.id, kind: 'clean',
    weight_kg: '33', items_total: '64', bags: '',
    wash_id: wash.id, visit_id: '', created_at: YESTERDAY + ' 18:00', consumed_at: '',
    laundry_id: laundryId
  }, laundryId);
  console.log('Стирка вчерашняя (stored) + clean на складе: ' + wash.id + ' — 33 кг, 64 шт, 2 меш.');
} else {
  console.log('Вчерашняя stored-стирка уже есть: ' + wash.id);
}

// Визит развоза на завтра
const visit = db.findRowsByTenant_(SHEETS.DELIVERIES, function (d) {
  return d.client_id === client.id && d.date === TOMORROW;
}, 10, laundryId)[0];
if (!visit) {
  const v = {
    id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: TOMORROW, client_id: client.id,
    ord: '', status: 'planned', delivered_at: '', pickup: '', driver_comment: '',
    created_by: 'seed', created_at: TODAY + ' 09:00', clean_taken_at: '', clean_bags: '',
    picked_at: '', dirty_handed_at: '', pickup_only: '', lift_floor: '', driver_id: '',
    laundry_id: laundryId
  };
  db.appendRowTenant_(SHEETS.DELIVERIES, v, laundryId);
  console.log('Визит развоза на завтра: ' + v.id);
} else {
  console.log('Визит на завтра уже есть: ' + visit.obj.id);
}

console.log('\nПроверка:');
console.log('1. Войти работником (worker1) и открыть день «' + TODAY + '»:');
console.log('   у «' + CLIENT_NAME + '» должна быть карточка с подписью «Бельё уже чистое» —');
console.log('   это чек-поинт проверки склада, а не новая стирка.');
console.log('2. «Проверить на складе» → «Есть чистое бельё» → карточка уходит в «Готово»,');
console.log('   цифры (33 кг · 64 шт · 2 меш.) переносятся со склада, смена закрывается.');
console.log('3. Отмена ошибочного старта: «Начать стирку» → карточка «в работе» →');
console.log('   «Проверить на складе» → «Есть чистое бельё»: грязное возвращается на склад,');
console.log('   дубля чистого не появляется (на складе остаётся одна позиция).');
console.log('4. В модалках «В работу» и «Завершить стирку» виден жёлтый баннер про чистое на складе.');
