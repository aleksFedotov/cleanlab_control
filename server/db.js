// Слой доступа к данным: SQLite (better-sqlite3) вместо SpreadsheetApp.
// Интерфейс повторяет src/Db.gs: те же функции, те же семантики
// (readAll только для справочников, журналы — через хвост, кэш справочников 5 мин).
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { HEADERS, START_BILLING_ITEMS } = require('./schema');
const { config } = require('./config');
const { hashPassword } = require('./util/passwords');

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
  migrateToV2_(db);
  migrateToV3_(db);
  migrateToV4_(db);
  return db;
}

// Для тестов: открыть отдельную БД (напр. ':memory:') и вернуть её.
function openTest(dbPath = ':memory:') {
  const testDb = new Database(dbPath);
  testDb.pragma('journal_mode = WAL');
  createTables_(testDb);
  migrateToV2_(testDb);
  migrateToV3_(testDb);
  migrateToV4_(testDb);
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

// Разовый сид мультитенантности: срабатывает только на пустой Laundries.
// Все существующие данные → прачка 1; пользователи создаются из ENV (config).
// Вторая прачка — только если задан LAUNDRY2_NAME.
function migrateToV2_(d) {
  if (readAll_('Laundries', d).length > 0) return;
  appendRow_('Laundries', { id: '1', name: config.LAUNDRY_NAME, active: 'да' }, d);
  ['Washes', 'Shifts', 'Deliveries', 'Storage', 'Clients', 'Log'].forEach(name => {
    d.exec(`UPDATE "${name}" SET laundry_id = '1' WHERE laundry_id IS NULL OR laundry_id = ''`);
  });
  // Per-tenant настройки прачки 1 (глобальные строки Settings остаются дефолтами)
  setTenantSetting_('1', 'LAUNDRY_NAME', config.LAUNDRY_NAME, d);
  if (config.TV_KEY) setTenantSetting_('1', 'TV_KEY', config.TV_KEY, d);
  let nextUserId = 1;
  const addUser = function (laundryId, name, role, pin) {
    if (!pin) return;
    appendRow_('Users', {
      id: 'usr_' + nextUserId++, laundry_id: laundryId, name: name,
      role: role, pin: String(pin), active: 'да', client_id: ''
    }, d);
  };
  addUser('', 'Владелец', 'owner', config.OWNER_PIN);
  addUser('1', 'Работник', 'worker', config.WORKER_PIN);
  addUser('1', 'Водитель', 'driver', config.DRIVER_PIN);
  if (config.LAUNDRY2_NAME) {
    appendRow_('Laundries', { id: '2', name: config.LAUNDRY2_NAME, active: 'да' }, d);
    setTenantSetting_('2', 'LAUNDRY_NAME', config.LAUNDRY2_NAME, d);
    if (config.TV_KEY_2) setTenantSetting_('2', 'TV_KEY', config.TV_KEY_2, d);
    addUser('2', 'Работник', 'worker', config.LAUNDRY2_WORKER_PIN);
    addUser('2', 'Водитель', 'driver', config.LAUNDRY2_DRIVER_PIN);
  }
  invalidateRefCache_();
}

// Миграция на логин+пароль (v3): upsert владельца из ENV OWNER_LOGIN/OWNER_PASSWORD.
// Идемпотентно: если обе переменные заданы, создаёт owner-пользователя или
// обновляет ему pass_hash и возвращает active=да (напр. после смены пароля в ENV).
// Без ENV — no-op (пользователей с пустым паролем не создаём).
function migrateToV3_(d) {
  if (!config.OWNER_LOGIN || !config.OWNER_PASSWORD) return;
  const passHash = hashPassword(config.OWNER_PASSWORD);
  const found = findRowsBy_('Users', function (u) {
    return u.role === 'owner' && u.login === config.OWNER_LOGIN;
  }, 100, d)[0];
  if (found) {
    found.obj.pass_hash = passHash;
    found.obj.active = 'да';
    updateRow_('Users', found.rowNumber, found.obj, d);
  } else {
    appendRow_('Users', {
      id: nextId_('Users', 'usr', d), laundry_id: '', name: 'Владелец',
      role: 'owner', pin: '', active: 'да', client_id: '',
      login: config.OWNER_LOGIN, pass_hash: passHash
    }, d);
  }
}

// Миграция v4 (P2, прайс): стартовое наполнение BillingItems на каждую прачку.
// Идемпотентно: прачка с хотя бы одной позицией прайса пропускается.
// Проверка — по ВСЕЙ таблице: findRowsBy_ читает только хвост (LIMIT n),
// поэтому с ним страж не видел позиции ранних прачек и пересидил их на
// каждом перезапуске (баг «прайс дублируется»).
function migrateToV4_(d = db) {
  const seeded = {};
  readAll_('BillingItems', d).forEach(r => { seeded[String(r.laundry_id)] = true; });
  readAll_('Laundries', d).forEach(laundry => {
    if (seeded[String(laundry.id)]) return;
    START_BILLING_ITEMS.forEach(function (item, idx) {
      appendRow_('BillingItems', {
        id: nextId_('BillingItems', 'bi', d),
        laundry_id: String(laundry.id),
        name: item.name,
        unit: item.unit,
        kind: item.kind,
        oneway: item.oneway || '',
        max_kg: item.max_kg || '',
        per_floor: item.per_floor || '',
        ext_code: '',
        sort: String(idx + 1),
        active: 'да'
      }, d);
    });
  });
}

// Per-tenant настройка: upsert строки Settings с laundry_id.
function setTenantSetting_(laundryId, key, value, d = db) {
  const found = findRowsBy_('Settings', function (r) {
    return r.key === key && r.laundry_id === String(laundryId);
  }, 10, d);
  if (found.length) {
    found[0].obj.value = String(value);
    updateRow_('Settings', found[0].rowNumber, found[0].obj, d);
  } else {
    appendRow_('Settings', { key: key, value: String(value), laundry_id: String(laundryId) }, d);
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

// --- Тенантные варианты: фильтр по laundry_id (колонка есть у операционных таблиц) ---

function readAllByTenant_(sheetName, laundryId, d = db) {
  const headers = cols_(sheetName);
  const rows = d.prepare(
    `SELECT ${headers.map(h => `"${h}"`).join(', ')} FROM "${sheetName}" WHERE laundry_id = ? ORDER BY rowid`
  ).all(String(laundryId));
  return rowsToObjects_(headers, rows);
}

// Последние maxRows строк журнала прачки, в порядке «старые → новые».
function readTailByTenant_(sheetName, maxRows, laundryId, d = db) {
  const headers = cols_(sheetName);
  const n = maxRows || TAIL_ROWS;
  const rows = d.prepare(
    `SELECT ${headers.map(h => `"${h}"`).join(', ')} FROM "${sheetName}" WHERE laundry_id = ? ORDER BY rowid DESC LIMIT ?`
  ).all(String(laundryId), n);
  rows.reverse();
  return rowsToObjects_(headers, rows);
}

// findRowsBy_ с обязательным фильтром по прачке (предикат применяется поверх).
function findRowsByTenant_(sheetName, pred, maxRows, laundryId, d = db) {
  return findRowsBy_(sheetName, function (row) {
    return row.laundry_id === String(laundryId) && pred(row);
  }, maxRows, d);
}

// appendRow_ с простановкой laundry_id (только для таблиц, где колонка есть).
function appendRowTenant_(sheetName, obj, laundryId, d = db) {
  obj.laundry_id = String(laundryId);
  appendRow_(sheetName, obj, d);
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
  // Ключи кэша per-tenant (`ref_clients:1` и т.п.) — чистим весь префикс ref_
  for (const k of [...refCache.keys()]) if (k.startsWith('ref_')) refCache.delete(k);
}

// Настройки: глобальные строки (laundry_id пуст) + перекрытие per-tenant.
function getSettings_(laundryId, d = db) {
  const key = REF_CACHE_KEYS.Settings + ':' + (laundryId || '');
  const cached = cacheGet_(key);
  if (cached) return cached;
  const settings = {};
  const tenantRows = [];
  readAll_('Settings', d).forEach(row => {
    if (laundryId && row.laundry_id === String(laundryId)) tenantRows.push(row);
    else if (!row.laundry_id) settings[row.key] = row.value;
  });
  tenantRows.forEach(row => { settings[row.key] = row.value; });
  cachePut_(key, settings);
  return settings;
}

// Клиенты прачки; без laundryId — все (setup/миграции).
function getClients_(laundryId, d = db) {
  const key = REF_CACHE_KEYS.Clients + ':' + (laundryId || '');
  const cached = cacheGet_(key);
  if (cached) return cached;
  const clients = laundryId
    ? readAllByTenant_('Clients', laundryId, d)
    : readAll_('Clients', d);
  cachePut_(key, clients);
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
  readAllByTenant_, readTailByTenant_, findRowsByTenant_, appendRowTenant_,
  setTenantSetting_, migrateToV2_, migrateToV3_, migrateToV4_,
  invalidateRefCache_, getSettings_, getClients_, getItemTypes_
};
