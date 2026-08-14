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
// На каждый день текущей недели — 10 визитов развоза. Для сегодня/завтра
// раскладываем состояния склада и стирок по всем случаям спеки:
// чистое на складе, грязное на складе, пусто, стирки planned/in_progress/done/
// partial/stored, «не готовы к развозу» всех трёх причин. Прошлые дни недели
// закрыты финальными статусами визитов (delivered/picked/both/empty).
// Идемпотентно: повторный запуск пропускается (флаг DEMO_SEEDED в Settings).
function seedDemoData() {
  return withLock_(function () {
    if (getSettings_().DEMO_SEEDED === 'да') {
      Logger.log('seedDemoData: уже выполнено (флаг DEMO_SEEDED в Settings)');
      return 0;
    }

    // Минимум 12 активных клиентов — при нехватке добиваем демо-клиентами
    var clients = getClients_().filter(function (c) { return c.active === 'да'; });
    for (var i = clients.length + 1; i <= 12; i++) {
      var cid = 'cli_demo_' + i;
      appendRow_(SHEETS.CLIENTS, {
        id: cid, name: 'Демо-клиент ' + i, contact: '+7 900 000-00-' + (10 + i),
        address: 'ул. Демонстрационная, ' + i, type: 'отель', storage: '',
        active: 'да', comment: 'демо'
      });
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

    var FINAL = ['delivered', 'picked', 'both', 'empty'];
    var visitsByDate = {};
    var created = 0;
    for (var di = 0; di < 7; di++) {
      var d = addDaysStr_(mon, di);
      visitsByDate[d] = [];
      for (var j = 0; j < 10; j++) {
        var c = clients[(di * 10 + j) % clients.length];
        visitsByDate[d].push(c.id);
        if (have[c.id + '|' + d]) continue;
        var past = d < today;
        var st = past ? FINAL[j % FINAL.length] : 'planned';
        appendRow_(SHEETS.DELIVERIES, {
          id: nextId_(SHEETS.DELIVERIES, 'del'), date: d, client_id: c.id,
          ord: j + 1, status: st,
          delivered_at: past ? d + ' 12:00:00' : '',
          pickup: (st === 'picked' || st === 'both') ? 'да' : '',
          driver_comment: '', created_by: 'seed', created_at: nowStr_()
        });
        created++;
      }
    }

    function mkWash(clientId, status, kg, items) {
      var doneLike = ['done', 'stored', 'issued', 'partial'].indexOf(status) !== -1;
      var w = {
        id: nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
        wash_date: today, issue_date: tomorrow, status: status,
        dirty_weight_kg: '', items_total: items || '', comment: 'демо',
        created_by: 'seed', created_at: nowStr_(),
        started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
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

    // Сценарии для сегодняшних визитов (все случаи экрана работника и водителя)
    var t = visitsByDate[today];
    mkStorage(t[0], 'dirty'); mkWash(t[0], 'planned');            // грязное ждёт стирки
    mkWash(t[1], 'in_progress');                                   // стирка идёт (грязное уже забрано)
    var wDone = mkWash(t[2], 'done', 18.5, 52);                    // постирано → чистое на складе
    mkStorage(t[2], 'clean', 18.5, 52, wDone);
    appendRow_(SHEETS.WASH_ITEMS, { id: 'wi_demo_1', wash_id: wDone, item_type_id: 'itm_1', qty: 20 });
    appendRow_(SHEETS.WASH_ITEMS, { id: 'wi_demo_2', wash_id: wDone, item_type_id: 'itm_2', qty: 32 });
    var wPart = mkWash(t[3], 'partial', 7, 20);                    // частично: чистое есть, клиент НЕ готов
    mkStorage(t[3], 'clean', 7, 20, wPart);
    // t[4]: ничего — ни чистого, ни грязного (случай empty)
    mkStorage(t[5], 'clean', 11, 30);                              // чистое без стирки (накоплено)
    mkStorage(t[6], 'clean', 9, 24);                               // водитель: выдать + забрать (both)
    var wStored = mkWash(t[7], 'stored', 14, 38);                  // готово, лежит на складе
    mkStorage(t[7], 'clean', 14, 38, wStored);
    mkStorage(t[8], 'dirty');                                      // грязное есть, в стирку ещё не ставили
    // t[9]: ничего

    // «Не готовы к завтрашнему развозу» — все три причины
    var m = visitsByDate[tomorrow];
    mkWash(m[0], 'in_progress');                                   // washing_incomplete
    var wPart2 = mkWash(m[1], 'partial', 5, 12);                   // partial
    mkStorage(m[1], 'clean', 5, 12, wPart2);
    // m[2]: намеренно без чистого — no_clean

    appendRow_(SHEETS.SETTINGS, { key: 'DEMO_SEEDED', value: 'да' });
    invalidateRefCache_();
    logEvent('owner', 'seed_demo', '-', { visits: created });
    Logger.log('seedDemoData: создано визитов ' + created);
    return created;
  });
}
