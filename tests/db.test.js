// Тесты T2: идемпотентность setup(), выборки «с хвоста», генераторы id, кэш справочников.
const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./helpers/loadGs');

// --- Мок GAS: таблица как массив строк на лист ---
class FakeSheet {
  constructor(name) { this._name = name; this.data = []; }
  getName() { return this._name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.length ? this.data[0].length : 0; }
  getRange(row, col, numRows, numCols) {
    const sheet = this;
    const rows = numRows || 1;
    const cols = numCols || 1;
    return {
      getValue() { return sheet.data[row - 1] ? sheet.data[row - 1][col - 1] : undefined; },
      getValues() {
        const out = [];
        for (let r = 0; r < rows; r++) {
          const src = sheet.data[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < cols; c++) line.push(src[col - 1 + c] !== undefined ? src[col - 1 + c] : '');
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        values.forEach((vals, r) => {
          sheet.data[row - 1 + r] = sheet.data[row - 1 + r] || [];
          vals.forEach((v, c) => { sheet.data[row - 1 + r][col - 1 + c] = v; });
        });
      }
    };
  }
  appendRow(row) { this.data.push(row.slice()); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(name) { return this.sheets.find(s => s.getName() === name) || null; }
  insertSheet(name) { const sh = new FakeSheet(name); this.sheets.push(sh); return sh; }
}

function makeCtx() {
  const ss = new FakeSpreadsheet();
  const cacheStore = new Map();
  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => cacheStore.set(k, v),
        remove: k => cacheStore.delete(k)
      })
    },
    Utilities: { formatDate: () => '2026-08-12 10:00:00' },
    Session: { getScriptTimeZone: () => 'Europe/Moscow' }
  };
  ['Schema.gs', 'Db.gs', 'Setup.gs', 'Audit.gs'].forEach(f => loadGs(f, sandbox));
  return { ctx: sandbox, ss, cacheStore };
}

test('setup() создаёт все 9 листов, сидит ItemTypes и Settings', () => {
  const { ctx, ss } = makeCtx();
  ctx.setup();
  assert.deepStrictEqual(ss.sheets.map(s => s.getName()),
    ['Settings', 'Clients', 'ItemTypes', 'Washes', 'WashItems', 'Shifts', 'Deliveries', 'Storage', 'Log']);
  assert.strictEqual(ctx.readAll_('ItemTypes').length, 11);
  const settings = ctx.readAll_('Settings');
  const map = Object.fromEntries(settings.map(r => [r.key, r.value]));
  assert.strictEqual(map.SCHEMA_VERSION, '1');
  assert.ok(map.DIGEST_TIME);
});

test('setup() идемпотентна: повторный запуск не дублирует данные', () => {
  const { ctx, ss } = makeCtx();
  ctx.setup();
  ctx.setup();
  assert.strictEqual(ss.sheets.length, 9);
  assert.strictEqual(ctx.readAll_('ItemTypes').length, 11);
  assert.strictEqual(ctx.readAll_('Settings').length, 3);
  // Заголовки не перезаписываются поверх существующих данных
  assert.strictEqual(ss.getSheetByName('Washes').getLastRow(), 1);
});

test('readTail_ возвращает последние N строк, старые → новые', () => {
  const { ctx } = makeCtx();
  ctx.setup();
  for (let i = 1; i <= 10; i++) {
    ctx.appendRow_('Washes', { id: `wash_${i}`, wash_date: '2026-08-12', status: 'planned' });
  }
  const tail = ctx.readTail_('Washes', 3);
  assert.deepStrictEqual(tail.map(r => r.id), ['wash_8', 'wash_9', 'wash_10']);
  assert.strictEqual(tail[0].status, 'planned');
  // Больше, чем есть строк — вернутся все
  assert.strictEqual(ctx.readTail_('Washes', 100).length, 10);
});

test('nextId_ инкрементирует max по хвосту', () => {
  const { ctx } = makeCtx();
  ctx.setup();
  assert.strictEqual(ctx.nextId_('Washes', 'wash'), 'wash_1');
  ctx.appendRow_('Washes', { id: 'wash_41', status: 'planned' });
  ctx.appendRow_('Washes', { id: 'wash_7', status: 'planned' });
  assert.strictEqual(ctx.nextId_('Washes', 'wash'), 'wash_42');
});

test('кэш справочников: попадание, сброс invalidateRefCache_', () => {
  const { ctx, cacheStore } = makeCtx();
  ctx.setup();
  const types1 = ctx.getItemTypes_();
  assert.strictEqual(types1.length, 11);
  assert.ok(cacheStore.has('ref_itemtypes'));
  // Пишем напрямую в лист — кэш отдаёт старое
  ctx.appendRow_('ItemTypes', { id: 'itm_99', name: 'тест', sort: 99, active: 'да' });
  assert.strictEqual(ctx.getItemTypes_().length, 11);
  // После сброса — свежие данные
  ctx.invalidateRefCache_();
  assert.strictEqual(ctx.getItemTypes_().length, 12);
  assert.strictEqual(ctx.getSettings_().SCHEMA_VERSION, '1');
});

test('logEvent пишет строку в Log с JSON-деталями', () => {
  const { ctx } = makeCtx();
  ctx.setup();
  ctx.logEvent('worker', 'wash_start', 'wash_1', { weight: 12.5 });
  const log = ctx.readAll_('Log');
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].actor, 'worker');
  assert.strictEqual(log[0].action, 'wash_start');
  assert.deepStrictEqual(JSON.parse(log[0].details), { weight: 12.5 });
});
