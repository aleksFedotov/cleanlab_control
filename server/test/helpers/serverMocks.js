// Общий контекст для тестов server/-слоёв: in-memory SQLite + фиксированное «сейчас».
// Аналог tests/helpers/gasMocks.js, но против реальных server-модулей.
// ВАЖНО: env выставляется до require server-модулей (config.js читает process.env при загрузке).
process.env.OWNER_PIN = process.env.OWNER_PIN || '1111';
process.env.WORKER_PIN = process.env.WORKER_PIN || '2222';
process.env.DRIVER_PIN = process.env.DRIVER_PIN || '3333';
process.env.TV_KEY = process.env.TV_KEY || 'tv-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'bot-token';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'hook-secret';

const db = require('../../db');

// Настоящий fetch фиксируем один раз при загрузке модуля: повторные makeCtx
// не должны захватывать уже подменённый стаб.
const REAL_FETCH = globalThis.fetch;
const time = require('../../util/time');
const setup = require('../../setup');
const api = require('../../api');
const auth = require('../../auth');
const telegram = require('../../telegram');

// Фиксированное «сейчас»: 2026-08-12 21:30 Europe/Moscow (= 18:30 UTC).
const FIXED_NOW = new Date('2026-08-12T18:30:00Z');
const TODAY = '2026-08-12';
const TOMORROW = '2026-08-13';

function makeCtx() {
  db._setDbForTests(db.openTest(':memory:'));
  time._setNowForTests(FIXED_NOW);
  setup.setup();

  // Подмена отправки в Telegram Bot API: перехват fetch, код ответа управляемый.
  const fetches = [];
  let fetchStatus = 200;
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url: String(url), payload: JSON.parse((opts && opts.body) || '{}') });
    return { status: fetchStatus };
  };

  return {
    db, api, auth, telegram, fetches, TODAY, TOMORROW,
    httpFetch: REAL_FETCH, // настоящий fetch для HTTP-вызовов самого сервера в тестах
    setFetchStatus: code => { fetchStatus = code; },
    restore: () => { globalThis.fetch = REAL_FETCH; time._setNowForTests(null); }
  };
}

function loginOwner() { return auth.login(null, '1111').token; }
function loginWorker() { return auth.login('1', '2222').token; }
function loginDriver() { return auth.login('1', '3333').token; }

// Вторая прачка для тестов изоляции: справочник + работник/водитель напрямую в БД.
function seedLaundry2() {
  db.appendRow_('Laundries', { id: '2', name: 'Прачка 2', active: 'да' });
  db.setTenantSetting_('2', 'LAUNDRY_NAME', 'Прачка 2');
  db.appendRow_('Users', { id: 'usr_w2', laundry_id: '2', name: 'Работник 2', role: 'worker', pin: '5555', active: 'да', client_id: '' });
  db.appendRow_('Users', { id: 'usr_d2', laundry_id: '2', name: 'Водитель 2', role: 'driver', pin: '6666', active: 'да', client_id: '' });
  db.invalidateRefCache_();
}
function loginWorker2() { return auth.login('2', '5555').token; }
function loginDriver2() { return auth.login('2', '6666').token; }

module.exports = { makeCtx, loginOwner, loginWorker, loginDriver, seedLaundry2, loginWorker2, loginDriver2, TODAY, TOMORROW, FIXED_NOW };
