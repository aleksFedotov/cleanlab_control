// Bootstrap таблицы (spec §10). Идемпотентна: повторный запуск ничего не дублирует.
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (k) {
    ensureSheet_(ss, SHEETS[k], HEADERS[SHEETS[k]]);
  });
  seedSettings_();
  seedItemTypes_();
}

// Создаёт лист при отсутствии; пишет заголовки, если первая строка пустая.
function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0 || sh.getRange(1, 1).getValue() === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

// Одноразовая миграция: добавить колонку bags в Washes (запустить вручную после деплоя).
// Идемпотентна: если колонка уже есть, ничего не делает. Db читает строки по заголовкам.
function migrateAddBagsColumn() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.WASHES);
  var headers = getHeaders_(sh);
  if (headers.indexOf('bags') !== -1) {
    Logger.log('migrateAddBagsColumn: колонка уже есть');
    return;
  }
  sh.getRange(1, headers.length + 1).setValue('bags');
  Logger.log('migrateAddBagsColumn: колонка bags добавлена');
}

// Одноразовая миграция: добавить колонки item_types и accounting в Clients
// (запустить вручную после деплоя). Идемпотентна. Db читает строки по заголовкам.
// item_types — JSON-массив id типов белья клиента (пусто = все типы);
// accounting — weight | count | both (пусто = both).
function migrateAddClientSettings() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CLIENTS);
  var headers = getHeaders_(sh);
  ['item_types', 'accounting'].forEach(function (col) {
    if (headers.indexOf(col) !== -1) {
      Logger.log('migrateAddClientSettings: колонка ' + col + ' уже есть');
      return;
    }
    sh.getRange(1, headers.length + 1).setValue(col);
    headers.push(col);
    Logger.log('migrateAddClientSettings: колонка ' + col + ' добавлена');
  });
}

// Одноразовая миграция: добавить колонки груза водителя в Deliveries
// (запустить вручную после деплоя). Идемпотентна.
// clean_taken_at/clean_bags — чистое у водителя; picked_at/dirty_handed_at — грязное у водителя.
function migrateAddVisitCargo() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.DELIVERIES);
  var headers = getHeaders_(sh);
  ['clean_taken_at', 'clean_bags', 'picked_at', 'dirty_handed_at'].forEach(function (col) {
    if (headers.indexOf(col) !== -1) {
      Logger.log('migrateAddVisitCargo: колонка ' + col + ' уже есть');
      return;
    }
    sh.getRange(1, headers.length + 1).setValue(col);
    headers.push(col);
    Logger.log('migrateAddVisitCargo: колонка ' + col + ' добавлена');
  });
}

// Дефолтные настройки (без секретов — они в Script Properties, spec §3.2).
function seedSettings_() {
  var defaults = {
    SCHEMA_VERSION: String(SCHEMA_VERSION),
    LAUNDRY_NAME: 'Прачка360',
    DIGEST_TIME: '21:30'
  };
  var existing = {};
  readAll_(SHEETS.SETTINGS).forEach(function (row) { existing[row.key] = row.value; });
  Object.keys(defaults).forEach(function (key) {
    if (!(key in existing)) appendRow_(SHEETS.SETTINGS, { key: key, value: defaults[key] });
  });
}

// Стартовые типы белья — только если лист пуст.
function seedItemTypes_() {
  if (readAll_(SHEETS.ITEM_TYPES).length > 0) return;
  START_ITEM_TYPES.forEach(function (name, i) {
    appendRow_(SHEETS.ITEM_TYPES, {
      id: 'itm_' + (i + 1), name: name, sort: i + 1, active: 'да'
    });
  });
}

// --- Демо-данные для ручной проверки user flow (запуск вручную из редактора GAS) ---
// 5 развозов на каждый день текущей недели. Прошлые дни — выполненные
// (финальные статусы визитов + стирки issued для отчёта). Сегодня — все
// ключевые состояния цеха (planned/in_progress/done/partial/stored) и склада.
// Завтра — случаи «не готовы к развозу». Идемпотентно (флаг DEMO_SEEDED).

var DEMO_PER_DAY = 5;

function seedDemoData() {
  return withLock_(function () {
    if (getSettings_().DEMO_SEEDED === 'да') {
      Logger.log('seedDemoData: уже выполнено (флаг DEMO_SEEDED в Settings)');
      return 0;
    }

    // Минимум 12 активных клиентов — при нехватке добиваем демо-клиентами.
    // Первым трем задаём настройки новых фич: свои виды белья и режим учёта.
    var CLIENT_TYPES = ['отель', 'ресторан', 'спа', 'прочее'];
    var clients = getClients_().filter(function (c) { return c.active === 'да'; });
    for (var i = clients.length + 1; i <= 12; i++) {
      var cid = 'cli_demo_' + i;
      var row = {
        id: cid, name: 'Демо-клиент ' + i, contact: '+7 900 000-00-' + (10 + i),
        address: 'ул. Демонстрационная, ' + i, type: CLIENT_TYPES[i % CLIENT_TYPES.length],
        storage: i % 3 === 0 ? 'да' : 'нет',
        active: 'да', comment: '', item_types: '', accounting: ''
      };
      if (i === 1) row.item_types = JSON.stringify(['itm_1', 'itm_2', 'itm_4', 'itm_5']);
      if (i === 2) row.accounting = 'weight';
      if (i === 3) row.accounting = 'count';
      appendRow_(SHEETS.CLIENTS, row);
      clients.push({ id: cid, active: 'да' });
    }
    invalidateRefCache_();

    var today = todayStr_();
    var mon = mondayOf_(today);
    var tomorrow = addDaysStr_(today, 1);

    // Существующие визиты не дублируем
    var have = {};
    readTail_(SHEETS.DELIVERIES, 5000).forEach(function (v) {
      if (v.status !== 'cancelled') have[v.client_id + '|' + v.date] = true;
    });

    var FINAL = ['delivered', 'picked', 'both', 'empty', 'delivered'];
    var visitsByDate = {};
    var created = 0;
    for (var di = 0; di < 7; di++) {
      var d = addDaysStr_(mon, di);
      visitsByDate[d] = [];
      for (var j = 0; j < DEMO_PER_DAY; j++) {
        var c = clients[(di * DEMO_PER_DAY + j) % clients.length];
        visitsByDate[d].push(c.id);
        if (have[c.id + '|' + d]) continue;
        var past = d < today;
        var st = past ? FINAL[j] : 'planned';
        appendRow_(SHEETS.DELIVERIES, {
          id: nextId_(SHEETS.DELIVERIES, 'del'), date: d, client_id: c.id,
          ord: j + 1, status: st,
          delivered_at: past ? d + ' 12:00:00' : '',
          pickup: (st === 'picked' || st === 'both') ? 'да' : '',
          driver_comment: '', created_by: 'seed', created_at: nowStr_()
        });
        created++;
        // Прошлые дни: выданным визитам — выполненная стирка, чтобы отчёт не был пустым
        if (past && (st === 'delivered' || st === 'both')) {
          var wid = nextId_(SHEETS.WASHES, 'wash');
          var kg = 10 + ((di * DEMO_PER_DAY + j) * 7) % 30;
          appendRow_(SHEETS.WASHES, {
            id: wid, client_id: c.id, wash_date: d, issue_date: d, status: 'issued',
            dirty_weight_kg: kg, items_total: 20 + j * 4, comment: '',
            created_by: 'seed', created_at: d + ' 08:00:00',
            started_at: d + ' 09:00:00', done_at: d + ' 11:00:00', issued_at: d + ' 12:00:00',
            deferred_from: '', deferred_reason: '', bags: 2 + (j % 3)
          });
          appendRow_(SHEETS.WASH_ITEMS, {
            id: nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: wid,
            item_type_id: 'itm_' + (1 + (j % 3)), qty: 10 + j * 2
          });
        }
      }
    }

    function mkWash(clientId, status, kg, items, bags) {
      var doneLike = ['done', 'stored', 'issued', 'partial'].indexOf(status) !== -1;
      var w = {
        id: nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
        wash_date: today, issue_date: tomorrow, status: status,
        dirty_weight_kg: '', items_total: items || '', comment: '',
        created_by: 'seed', created_at: nowStr_(),
        started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: '',
        bags: bags || ''
      };
      if (status === 'in_progress' || doneLike) w.started_at = today + ' 09:00:00';
      if (doneLike) { w.done_at = today + ' 11:00:00'; w.dirty_weight_kg = kg || ''; }
      appendRow_(SHEETS.WASHES, w);
      return w.id;
    }
    function mkStorage(clientId, kind, kg, items, washId) {
      appendRow_(SHEETS.STORAGE, {
        id: nextId_(SHEETS.STORAGE, 'st'), client_id: clientId, kind: kind,
        weight_kg: kg || '', items_total: items || '', wash_id: washId || '',
        created_at: nowStr_(), consumed_at: ''
      });
    }

    // Сценарии для сегодняшних визитов: все ключевые состояния цеха
    var t = visitsByDate[today];
    mkStorage(t[0], 'dirty'); mkWash(t[0], 'planned');            // грязное ждёт стирки
    mkWash(t[1], 'in_progress');                                   // стирка идёт
    var wDone = mkWash(t[2], 'done', 18.5, 52, 4);                 // постирано → чистое на складе
    mkStorage(t[2], 'clean', 18.5, 52, wDone);
    appendRow_(SHEETS.WASH_ITEMS, { id: nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: wDone, item_type_id: 'itm_1', qty: 20 });
    appendRow_(SHEETS.WASH_ITEMS, { id: nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: wDone, item_type_id: 'itm_2', qty: 32 });
    var wPart = mkWash(t[3], 'partial', 7, 20, 2);                 // частично: клиент НЕ готов
    mkStorage(t[3], 'clean', 7, 20, wPart);
    var wStored = mkWash(t[4], 'stored', 14, 38, 3);               // готово, лежит на складе
    mkStorage(t[4], 'clean', 14, 38, wStored);

    // «Не готовы к завтрашнему развозу»: стирка идёт и частичная
    var m = visitsByDate[tomorrow];
    mkWash(m[0], 'in_progress');                                   // washing_incomplete
    var wPart2 = mkWash(m[1], 'partial', 5, 12, 1);                // partial
    mkStorage(m[1], 'clean', 5, 12, wPart2);

    appendRow_(SHEETS.SETTINGS, { key: 'DEMO_SEEDED', value: 'да' });
    invalidateRefCache_();
    logEvent('owner', 'seed_demo', '-', { visits: created });
    Logger.log('seedDemoData: создано визитов ' + created);
    return created;
  });
}

// Полная очистка данных (кроме Settings и заголовков). Запуск вручную из редактора.
// PIN-коды и настройки не трогает — они в Script Properties и Settings.
function wipeAllData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEETS.CLIENTS, SHEETS.ITEM_TYPES, SHEETS.WASHES, SHEETS.WASH_ITEMS,
   SHEETS.SHIFTS, SHEETS.DELIVERIES, SHEETS.STORAGE, SHEETS.LOG].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  // Сбросить флаг демо, чтобы seedDemoData можно было запустить заново
  readAll_(SHEETS.SETTINGS).forEach(function (row) {
    if (row.key === 'DEMO_SEEDED') {
      var found = findRowsBy_(SHEETS.SETTINGS, function (r) { return r.key === 'DEMO_SEEDED'; }, 1)[0];
      if (found) deleteRow_(SHEETS.SETTINGS, found.rowNumber);
    }
  });
  invalidateRefCache_();
  seedItemTypes_(); // вернуть стартовый справочник видов белья
  Logger.log('wipeAllData: данные очищены');
}

// Очистить базу и заново заполнить демо-данными — одна кнопка.
function resetDemoData() {
  wipeAllData();
  return seedDemoData();
}
