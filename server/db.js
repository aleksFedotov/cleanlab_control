// Слой доступа к данным: SQLite (better-sqlite3) вместо SpreadsheetApp.
// Интерфейс повторяет src/Db.gs: те же функции, те же семантики
// (readAll только для справочников, журналы — через хвост, кэш справочников 5 мин).
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { HEADERS } = require('./schema');

const TAIL_ROWS = 500;
const REF_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут
const REF_CACHE_KEYS = { Settings: 'ref_settings', Clients: 'ref_clients', ItemTypes: 'ref_itemtypes' };

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cleanlab.sqlite');

let db = null;
// Кэш справочников: key → { value, expiresAt }. Аналог CacheService с TTL.
const refCache = new Map();

function open(dbPath = DB_PATH) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  createTables_(db);
  return db;
}

// Для тестов: открыть отдельную БД (напр. ':memory:') и вернуть её.
function openTest(dbPath = ':memory:') {
  const testDb = new Database(dbPath);
  testDb.pragma('journal_mode = WAL');
  createTables_(testDb);
  return testDb;
}

function createTables_(d) {
  for (const [name, cols] of Object.entries(HEADERS)) {
    const defs = cols.map(c => `"${c}" TEXT`).join(', ');
    d.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${defs})`);
    // Мини-миграция: добавляем колонки, появившиеся в HEADERS после создания БД
    const existing = d.prepare(`PRAGMA table_info("${name}")`).all().map(r => r.name);
    cols.filter(c => !existing.includes(c)).forEach(c => {
      d.exec(`ALTER TABLE "${name}" ADD COLUMN "${c}" TEXT`);
    });
  }
}

function cols_(sheetName) {
  const cols = HEADERS[sheetName];
  if (!cols) throw new Error(`Unknown sheet: ${sheetName}`);
  return cols;
}

function rowsToObjects_(headers, rows) {
  return rows.map(row => {
    const obj = {};
    headers.forEach(h => { obj[h] = row[h] === null || row[h] === undefined ? '' : row[h]; });
    return obj;
  });
}

// Все строки таблицы — только для справочников и setup. Для журналов запрещено.
function readAll_(sheetName, d = db) {
  const headers = cols_(sheetName);
  const rows = d.prepare(`SELECT ${headers.map(h => `"${h}"`).join(', ')} FROM "${sheetName}" ORDER BY rowid`).all();
  return rowsToObjects_(headers, rows);
}

// Последние maxRows строк журнала, в порядке «старые → новые».
function readTail_(sheetName, maxRows, d = db) {
  const headers = cols_(sheetName);
  const n = maxRows || TAIL_ROWS;
  const rows = d.prepare(
    `SELECT ${headers.map(h => `"${h}"`).join(', ')} FROM "${sheetName}" ORDER BY rowid DESC LIMIT ?`
  ).all(n);
  rows.reverse();
  return rowsToObjects_(headers, rows);
}

function appendRow_(sheetName, obj, d = db) {
  const headers = cols_(sheetName);
  const stmt = d.prepare(
    `INSERT INTO "${sheetName}" (${headers.map(h => `"${h}"`).join(', ')}) VALUES (${headers.map(() => '?').join(', ')})`
  );
  stmt.run(headers.map(h => (obj[h] !== undefined ? String(obj[h]) : '')));
}

// Генератор id вида wash_<n>: max по хвосту + 1.
function nextId_(sheetName, prefix, d = db) {
  let max = 0;
  readTail_(sheetName, 1000, d).forEach(row => {
    const m = String(row.id || '').match(/_(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + '_' + (max + 1);
}

// Строки с номерами: выборка по предикату из хвоста журнала.
// rowNumber = rowid (монотонно растёт, как номер строки в Sheets).
function findRowsBy_(sheetName, pred, maxRows, d = db) {
  const headers = cols_(sheetName);
  const n = maxRows || TAIL_ROWS;
  const rows = d.prepare(
    `SELECT rowid AS _rowid, ${headers.map(h => `"${h}"`).join(', ')} FROM "${sheetName}" ORDER BY rowid DESC LIMIT ?`
  ).all(n);
  rows.reverse();
  const out = [];
  rows.forEach(row => {
    const obj = {};
    headers.forEach(h => { obj[h] = row[h] === null || row[h] === undefined ? '' : row[h]; });
    if (pred(obj)) out.push({ rowNumber: row._rowid, obj });
  });
  return out;
}

function findById_(sheetName, id, d = db) {
  const found = findRowsBy_(sheetName, row => row.id === id, 1000, d);
  return found.length ? found[found.length - 1] : null;
}

function updateRow_(sheetName, rowNumber, obj, d = db) {
  const headers = cols_(sheetName);
  const stmt = d.prepare(
    `UPDATE "${sheetName}" SET ${headers.map(h => `"${h}" = ?`).join(', ')} WHERE rowid = ?`
  );
  stmt.run(...headers.map(h => (obj[h] !== undefined ? String(obj[h]) : '')), rowNumber);
}

function deleteRow_(sheetName, rowNumber, d = db) {
  d.prepare(`DELETE FROM "${sheetName}" WHERE rowid = ?`).run(rowNumber);
}

// JSON-массив строк из ячейки (Clients.item_types): битый/пустой → null.
function parseJsonList_(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) { return null; }
}

// --- Кэш справочников (Settings/Clients/ItemTypes), TTL 5 мин, сброс при записи ---

function cacheGet_(key) {
  const e = refCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { refCache.delete(key); return null; }
  return e.value;
}

function cachePut_(key, value) {
  refCache.set(key, { value, expiresAt: Date.now() + REF_CACHE_TTL_MS });
}

function invalidateRefCache_() {
  Object.keys(REF_CACHE_KEYS).forEach(k => refCache.delete(REF_CACHE_KEYS[k]));
}

function getSettings_(d = db) {
  const cached = cacheGet_(REF_CACHE_KEYS.Settings);
  if (cached) return cached;
  const settings = {};
  readAll_('Settings', d).forEach(row => { settings[row.key] = row.value; });
  cachePut_(REF_CACHE_KEYS.Settings, settings);
  return settings;
}

function getClients_(d = db) {
  const cached = cacheGet_(REF_CACHE_KEYS.Clients);
  if (cached) return cached;
  const clients = readAll_('Clients', d);
  cachePut_(REF_CACHE_KEYS.Clients, clients);
  return clients;
}

function getItemTypes_(d = db) {
  const cached = cacheGet_(REF_CACHE_KEYS.ItemTypes);
  if (cached) return cached;
  const types = readAll_('ItemTypes', d);
  cachePut_(REF_CACHE_KEYS.ItemTypes, types);
  return types;
}

// Для тестов: подменить module-level БД (напр. openTest(':memory:')) и сбросить кэш справочников.
function _setDbForTests(d) {
  db = d;
  refCache.clear();
}

module.exports = {
  TAIL_ROWS, open, openTest, _setDbForTests,
  readAll_, readTail_, appendRow_, nextId_, findRowsBy_, findById_,
  updateRow_, deleteRow_, parseJsonList_,
  invalidateRefCache_, getSettings_, getClients_, getItemTypes_
};
