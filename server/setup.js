// Bootstrap БД (spec §10) — порт src/Setup.gs.
// Таблицы создаёт db.open()/openTest() по HEADERS (замена ensureSheet_).
// setup() идемпотентна: повторный запуск ничего не дублирует.
const { SCHEMA_VERSION, SHEETS, START_ITEM_TYPES } = require('./schema');
const db = require('./db');
const { nowStr_, todayStr_, logEvent } = require('./audit');
const { addDaysStr_, mondayOf_ } = require('./core');

function setup() {
  db.open();
  seedSettings_();
  seedItemTypes_();
}

// Дефолтные настройки (без секретов — они в ENV, spec §3.2).
function seedSettings_() {
  const defaults = {
    SCHEMA_VERSION: String(SCHEMA_VERSION),
    LAUNDRY_NAME: 'Прачечная PRO',
    DIGEST_TIME: '21:30'
  };
  const existing = {};
  db.readAll_(SHEETS.SETTINGS).forEach(function (row) { existing[row.key] = row.value; });
  Object.keys(defaults).forEach(function (key) {
    if (!(key in existing)) db.appendRow_(SHEETS.SETTINGS, { key: key, value: defaults[key] });
  });
}

// Стартовые типы белья — только если таблица пуста.
function seedItemTypes_() {
  if (db.readAll_(SHEETS.ITEM_TYPES).length > 0) return;
  START_ITEM_TYPES.forEach(function (name, i) {
    db.appendRow_(SHEETS.ITEM_TYPES, {
      id: 'itm_' + (i + 1), name: name, sort: i + 1, active: 'да'
    });
  });
}

// --- Демо-данные для ручной проверки user flow ---
// 5 развозов на каждый день текущей недели. Прошлые дни — выполненные
// (финальные статусы визитов + стирки issued для отчёта). Сегодня — все
// ключевые состояния цеха (planned/in_progress/done/partial/stored) и склада.
// Завтра — случаи «не готовы к развозу». Идемпотентно (флаг DEMO_SEEDED).

const DEMO_PER_DAY = 5;

function seedDemoData() {
  if (db.getSettings_().DEMO_SEEDED === 'да') {
    console.log('seedDemoData: уже выполнено (флаг DEMO_SEEDED в Settings)');
    return 0;
  }

  // Минимум 12 активных клиентов — при нехватке добиваем демо-клиентами.
  // Первым трем задаём настройки новых фич: свои виды белья и режим учёта.
  const CLIENT_TYPES = ['отель', 'ресторан', 'спа', 'прочее'];
  const clients = db.getClients_().filter(function (c) { return c.active === 'да'; });
  for (let i = clients.length + 1; i <= 12; i++) {
    const cid = 'cli_demo_' + i;
    const row = {
      id: cid, name: 'Демо-клиент ' + i, contact: '+7 900 000-00-' + (10 + i),
      address: 'ул. Демонстрационная, ' + i, type: CLIENT_TYPES[i % CLIENT_TYPES.length],
      storage: i % 3 === 0 ? 'да' : 'нет',
      active: 'да', comment: '', item_types: '', accounting: ''
    };
    if (i === 1) row.item_types = JSON.stringify(['itm_1', 'itm_2', 'itm_4', 'itm_5']);
    if (i === 2) row.accounting = 'weight';
    if (i === 3) row.accounting = 'count';
    db.appendRow_(SHEETS.CLIENTS, row);
    clients.push({ id: cid, active: 'да' });
  }
  db.invalidateRefCache_();

  const today = todayStr_();
  const mon = mondayOf_(today);
  const tomorrow = addDaysStr_(today, 1);

  // Существующие визиты не дублируем
  const have = {};
  db.readTail_(SHEETS.DELIVERIES, 5000).forEach(function (v) {
    if (v.status !== 'cancelled') have[v.client_id + '|' + v.date] = true;
  });

  const FINAL = ['delivered', 'picked', 'both', 'empty', 'delivered'];
  const visitsByDate = {};
  let created = 0;
  for (let di = 0; di < 7; di++) {
    const d = addDaysStr_(mon, di);
    visitsByDate[d] = [];
    for (let j = 0; j < DEMO_PER_DAY; j++) {
      const c = clients[(di * DEMO_PER_DAY + j) % clients.length];
      visitsByDate[d].push(c.id);
      if (have[c.id + '|' + d]) continue;
      const past = d < today;
      const st = past ? FINAL[j] : 'planned';
      db.appendRow_(SHEETS.DELIVERIES, {
        id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: d, client_id: c.id,
        ord: j + 1, status: st,
        delivered_at: past ? d + ' 12:00:00' : '',
        pickup: (st === 'picked' || st === 'both') ? 'да' : '',
        driver_comment: '', created_by: 'seed', created_at: nowStr_()
      });
      created++;
      // Прошлые дни: выданным визитам — выполненная стирка, чтобы отчёт не был пустым
      if (past && (st === 'delivered' || st === 'both')) {
        const wid = db.nextId_(SHEETS.WASHES, 'wash');
        const kg = 10 + ((di * DEMO_PER_DAY + j) * 7) % 30;
        db.appendRow_(SHEETS.WASHES, {
          id: wid, client_id: c.id, wash_date: d, issue_date: d, status: 'issued',
          dirty_weight_kg: kg, items_total: 20 + j * 4, comment: '',
          created_by: 'seed', created_at: d + ' 08:00:00',
          started_at: d + ' 09:00:00', done_at: d + ' 11:00:00', issued_at: d + ' 12:00:00',
          deferred_from: '', deferred_reason: '', bags: 2 + (j % 3)
        });
        db.appendRow_(SHEETS.WASH_ITEMS, {
          id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: wid,
          item_type_id: 'itm_' + (1 + (j % 3)), qty: 10 + j * 2
        });
      }
    }
  }

  function mkWash(clientId, status, kg, items, bags) {
    const doneLike = ['done', 'stored', 'issued', 'partial'].indexOf(status) !== -1;
    const w = {
      id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: today, issue_date: tomorrow, status: status,
      dirty_weight_kg: '', items_total: items || '', comment: '',
      created_by: 'seed', created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: '',
      bags: bags || ''
    };
    if (status === 'in_progress' || doneLike) w.started_at = today + ' 09:00:00';
    if (doneLike) { w.done_at = today + ' 11:00:00'; w.dirty_weight_kg = kg || ''; }
    db.appendRow_(SHEETS.WASHES, w);
    return w.id;
  }
  function mkStorage(clientId, kind, kg, items, washId) {
    db.appendRow_(SHEETS.STORAGE, {
      id: db.nextId_(SHEETS.STORAGE, 'st'), client_id: clientId, kind: kind,
      weight_kg: kg || '', items_total: items || '', wash_id: washId || '',
      created_at: nowStr_(), consumed_at: ''
    });
  }

  // Сценарии для сегодняшних визитов: все ключевые состояния цеха
  const t = visitsByDate[today];
  mkStorage(t[0], 'dirty'); mkWash(t[0], 'planned');            // грязное ждёт стирки
  mkWash(t[1], 'in_progress');                                   // стирка идёт
  const wDone = mkWash(t[2], 'done', 18.5, 52, 4);               // постирано → чистое на складе
  mkStorage(t[2], 'clean', 18.5, 52, wDone);
  db.appendRow_(SHEETS.WASH_ITEMS, { id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: wDone, item_type_id: 'itm_1', qty: 20 });
  db.appendRow_(SHEETS.WASH_ITEMS, { id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: wDone, item_type_id: 'itm_2', qty: 32 });
  const wPart = mkWash(t[3], 'partial', 7, 20, 2);               // частично: клиент НЕ готов
  mkStorage(t[3], 'clean', 7, 20, wPart);
  const wStored = mkWash(t[4], 'stored', 14, 38, 3);             // готово, лежит на складе
  mkStorage(t[4], 'clean', 14, 38, wStored);

  // «Не готовы к завтрашнему развозу»: стирка идёт и частичная
  const m = visitsByDate[tomorrow];
  mkWash(m[0], 'in_progress');                                   // washing_incomplete
  const wPart2 = mkWash(m[1], 'partial', 5, 12, 1);              // partial
  mkStorage(m[1], 'clean', 5, 12, wPart2);

  db.appendRow_(SHEETS.SETTINGS, { key: 'DEMO_SEEDED', value: 'да' });
  db.invalidateRefCache_();
  logEvent('owner', 'seed_demo', '-', { visits: created });
  console.log('seedDemoData: создано визитов ' + created);
  return created;
}

// Полная очистка данных (кроме Settings и заголовков).
// PIN-коды и настройки не трогает — они в ENV и Settings.
function wipeAllData() {
  // Удаляем все строки через findRowsBy_ (rowNumber = rowid)
  [SHEETS.CLIENTS, SHEETS.ITEM_TYPES, SHEETS.WASHES, SHEETS.WASH_ITEMS,
   SHEETS.SHIFTS, SHEETS.DELIVERIES, SHEETS.STORAGE, SHEETS.LOG].forEach(function (name) {
    db.findRowsBy_(name, function () { return true; }, 100000)
      .forEach(function (r) { db.deleteRow_(name, r.rowNumber); });
  });
  // Сбросить флаг демо, чтобы seedDemoData можно было запустить заново
  const found = db.findRowsBy_(SHEETS.SETTINGS, function (r) { return r.key === 'DEMO_SEEDED'; }, 1)[0];
  if (found) db.deleteRow_(SHEETS.SETTINGS, found.rowNumber);
  db.invalidateRefCache_();
  seedItemTypes_(); // вернуть стартовый справочник видов белья
  console.log('wipeAllData: данные очищены');
}

// Очистить базу и заново заполнить демо-данными — одна кнопка.
function resetDemoData() {
  wipeAllData();
  return seedDemoData();
}

module.exports = { setup, seedSettings_, seedItemTypes_, seedDemoData, wipeAllData, resetDemoData };
