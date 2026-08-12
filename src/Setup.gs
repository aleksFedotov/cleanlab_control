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
