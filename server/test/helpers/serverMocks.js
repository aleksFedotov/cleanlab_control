// Общий контекст для тестов server/-слоёв: in-memory SQLite + фиксированное «сейчас».
// Аналог tests/helpers/gasMocks.js, но против реальных server-модулей.
// ВАЖНО: env выставляется до require server-модулей (config.js читает process.env при загрузке).
process.env.OWNER_LOGIN = process.env.OWNER_LOGIN || 'boss';
process.env.OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'boss-pass';
process.env.TV_KEY = process.env.TV_KEY || 'tv-secret';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'bot-token';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'hook-secret';

const db = require('../../db');
const { hashPassword } = require('../../util/passwords');

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

// Пользователь напрямую в БД (с паролем): v3 сидит только владельца из ENV,
// остальные учётки тесты создают так.
function seedUser(id, laundryId, name, role, login, password) {
  db.appendRow_('Users', {
    id: id, laundry_id: laundryId, name: name, role: role,
    pin: '', active: 'да', client_id: '',
    login: login, pass_hash: hashPassword(password)
  });
}

function makeCtx() {
  db._setDbForTests(db.openTest(':memory:'));
  time._setNowForTests(FIXED_NOW);
  setup.setup();
  seedUser('usr_w1', '1', 'Работник', 'worker', 'worker1', 'worker-pass');
  seedUser('usr_d1', '1', 'Водитель', 'driver', 'driver1', 'driver-pass');

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

function loginOwner() { return auth.login('boss', 'boss-pass').token; }
function loginWorker() { return auth.login('worker1', 'worker-pass').token; }
function loginDriver() { return auth.login('driver1', 'driver-pass').token; }

// Вторая прачка для тестов изоляции: справочник + работник/водитель напрямую в БД.
function seedLaundry2() {
  db.appendRow_('Laundries', { id: '2', name: 'Прачка 2', active: 'да' });
  db.setTenantSetting_('2', 'LAUNDRY_NAME', 'Прачка 2');
  seedUser('usr_w2', '2', 'Работник 2', 'worker', 'worker2', 'worker2-pass');
  seedUser('usr_d2', '2', 'Водитель 2', 'driver', 'driver2', 'driver2-pass');
  db.invalidateRefCache_();
}
function loginWorker2() { return auth.login('worker2', 'worker2-pass').token; }
function loginDriver2() { return auth.login('driver2', 'driver2-pass').token; }

module.exports = { makeCtx, seedUser, loginOwner, loginWorker, loginDriver, seedLaundry2, loginWorker2, loginDriver2, TODAY, TOMORROW, FIXED_NOW };
