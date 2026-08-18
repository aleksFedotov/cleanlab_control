// Общие моки GAS-сервисов для Node-тестов API.
const { loadGs } = require('./loadGs');

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
  deleteRow(rowNumber) { this.data.splice(rowNumber - 1, 1); }
  deleteRows(row, howMany) { this.data.splice(row - 1, howMany); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(name) { return this.sheets.find(s => s.getName() === name) || null; }
  insertSheet(name) { const sh = new FakeSheet(name); this.sheets.push(sh); return sh; }
}

// Фиксированное «сейчас»: 2026-08-12 21:30 Europe/Moscow.
// Даты, отличные от «сейчас», форматируем по-настоящему (Europe/Moscow = UTC+3),
// чтобы тестировать нормализацию Date из ячеек Sheets.
function fakeFormatDate(date, tz, fmt) {
  const isNow = Math.abs(Date.now() - date.getTime()) < 60000;
  if (isNow) {
    if (fmt === 'HH:mm') return '21:30';
    if (fmt === 'yyyy-MM-dd') return '2026-08-12';
    return '2026-08-12 21:30:00';
  }
  const m = new Date(date.getTime() + 3 * 3600 * 1000);
  const p = n => (n < 10 ? '0' : '') + n;
  const ymd = `${m.getUTCFullYear()}-${p(m.getUTCMonth() + 1)}-${p(m.getUTCDate())}`;
  if (fmt === 'yyyy-MM-dd') return ymd;
  if (fmt === 'HH:mm') return `${p(m.getUTCHours())}:${p(m.getUTCMinutes())}`;
  return `${ymd} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}:${p(m.getUTCSeconds())}`;
}

function makeApiCtx(props = {}) {
  const ss = new FakeSpreadsheet();
  const cacheStore = new Map();
  const propsStore = Object.assign({
    OWNER_PIN: '1111', WORKER_PIN: '2222', DRIVER_PIN: '3333', TV_KEY: 'tv-secret',
    BOT_TOKEN: 'bot-token', WEBHOOK_SECRET: 'hook-secret', OWNER_CHAT_ID: '998877'
  }, props);
  const fetches = [];
  let fetchStatus = 200;
  let uuid = 0;
  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => cacheStore.set(k, v),
        remove: k => cacheStore.delete(k)
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in propsStore ? propsStore[k] : null),
        setProperty: (k, v) => { propsStore[k] = v; }
      })
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetches.push({ url, payload: JSON.parse(opts.payload || '{}') });
        return { getResponseCode: () => fetchStatus };
      }
    },
    ContentService: { createTextOutput: t => ({ text: t }) },
    Utilities: { getUuid: () => `token-${++uuid}`, formatDate: fakeFormatDate },
    Session: { getScriptTimeZone: () => 'Europe/Moscow' },
    Logger: { log: () => {} }
  };
  ['Schema.gs', 'Db.gs', 'Core.gs', 'Setup.gs', 'Audit.gs', 'Auth.gs', 'Storage.gs', 'Deliveries.gs', 'Api.gs', 'Telegram.gs']
    .forEach(f => loadGs(f, sandbox));
  sandbox.setup();
  return {
    ctx: sandbox, ss, cacheStore, propsStore, fetches,
    setFetchStatus: code => { fetchStatus = code; }
  };
}

function loginOwner(ctx) { return ctx.login('1111').token; }
function loginWorker(ctx) { return ctx.login('2222').token; }
function loginDriver(ctx) { return ctx.login('3333').token; }

module.exports = { makeApiCtx, loginOwner, loginWorker, loginDriver, FakeSheet, FakeSpreadsheet };
