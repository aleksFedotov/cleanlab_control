// Слой доступа к данным (spec §3.9, §10).
// Журнальные листы никогда не читаются целиком: выборки «снизу вверх», последние N строк.
var TAIL_ROWS = 500;
var REF_CACHE_TTL_SEC = 300; // 5 минут
var REF_CACHE_KEYS = { Settings: 'ref_settings', Clients: 'ref_clients', ItemTypes: 'ref_itemtypes' };

function getSheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function getHeaders_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

// Sheets может хранить дату/время как Date (автоформат ячеек): при чтении
// нормализуем обратно в строки схемы, иначе сравнения дат молча не срабатывают.
function normVal_(header, v) {
  if (Object.prototype.toString.call(v) !== '[object Date]') return v;
  var tz = Session.getScriptTimeZone();
  if (header === 'closed_at') return Utilities.formatDate(v, tz, 'HH:mm');
  if (header === 'ts' || /_at$/.test(header)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
  return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
}

function rowsToObjects_(headers, values) {
  return values
    .filter(function (row) { return row[0] !== '' && row[0] !== undefined; })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = normVal_(h, row[i]); });
      return obj;
    });
}

// Все строки листа — только для справочников и Setup. Для журналов запрещено.
function readAll_(sheetName) {
  var sh = getSheet_(sheetName);
  if (sh.getLastRow() < 2) return [];
  var headers = getHeaders_(sh);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  return rowsToObjects_(headers, values);
}

// Последние maxRows строк журнального листа, в порядке «старые → новые».
function readTail_(sheetName, maxRows) {
  var sh = getSheet_(sheetName);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var headers = getHeaders_(sh);
  var n = Math.min(maxRows || TAIL_ROWS, lastRow - 1);
  var values = sh.getRange(lastRow - n + 1, 1, n, headers.length).getValues();
  return rowsToObjects_(headers, values);
}

function appendRow_(sheetName, obj) {
  var sh = getSheet_(sheetName);
  var headers = getHeaders_(sh);
  sh.appendRow(headers.map(function (h) {
    return obj[h] !== undefined ? obj[h] : '';
  }));
}

// Генератор id вида wash_<n>: max по хвосту + 1.
function nextId_(sheetName, prefix) {
  var max = 0;
  readTail_(sheetName, 1000).forEach(function (row) {
    var m = String(row.id || '').match(/_(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + '_' + (max + 1);
}

// Строки с номерами: выборка по предикату из хвоста журнального листа.
function findRowsBy_(sheetName, pred, maxRows) {
  var sh = getSheet_(sheetName);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var headers = getHeaders_(sh);
  var n = Math.min(maxRows || TAIL_ROWS, lastRow - 1);
  var firstRow = lastRow - n + 1;
  var values = sh.getRange(firstRow, 1, n, headers.length).getValues();
  var out = [];
  values.forEach(function (row, i) {
    if (row[0] === '' || row[0] === undefined) return;
    var obj = {};
    headers.forEach(function (h, c) { obj[h] = normVal_(h, row[c]); });
    if (pred(obj)) out.push({ rowNumber: firstRow + i, obj: obj });
  });
  return out;
}

function findById_(sheetName, id) {
  var found = findRowsBy_(sheetName, function (row) { return row.id === id; }, 1000);
  return found.length ? found[found.length - 1] : null;
}

function updateRow_(sheetName, rowNumber, obj) {
  var sh = getSheet_(sheetName);
  var headers = getHeaders_(sh);
  sh.getRange(rowNumber, 1, 1, headers.length).setValues([headers.map(function (h) {
    return obj[h] !== undefined ? obj[h] : '';
  })]);
}

function deleteRow_(sheetName, rowNumber) {
  getSheet_(sheetName).deleteRow(rowNumber);
}

// --- Кэш справочников (Settings/Clients/ItemTypes), TTL 5 мин, сброс при записи ---

function cacheGet_(key) {
  var s = CacheService.getScriptCache().get(key);
  return s ? JSON.parse(s) : null;
}

function cachePut_(key, value) {
  CacheService.getScriptCache().put(key, JSON.stringify(value), REF_CACHE_TTL_SEC);
}

function invalidateRefCache_() {
  var cache = CacheService.getScriptCache();
  Object.keys(REF_CACHE_KEYS).forEach(function (k) { cache.remove(REF_CACHE_KEYS[k]); });
}

function getSettings_() {
  var cached = cacheGet_(REF_CACHE_KEYS.Settings);
  if (cached) return cached;
  var settings = {};
  readAll_(SHEETS.SETTINGS).forEach(function (row) { settings[row.key] = row.value; });
  cachePut_(REF_CACHE_KEYS.Settings, settings);
  return settings;
}

function getClients_() {
  var cached = cacheGet_(REF_CACHE_KEYS.Clients);
  if (cached) return cached;
  var clients = readAll_(SHEETS.CLIENTS);
  cachePut_(REF_CACHE_KEYS.Clients, clients);
  return clients;
}

function getItemTypes_() {
  var cached = cacheGet_(REF_CACHE_KEYS.ItemTypes);
  if (cached) return cached;
  var types = readAll_(SHEETS.ITEM_TYPES);
  cachePut_(REF_CACHE_KEYS.ItemTypes, types);
  return types;
}
