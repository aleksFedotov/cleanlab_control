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

function rowsToObjects_(headers, values) {
  return values
    .filter(function (row) { return row[0] !== '' && row[0] !== undefined; })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
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
