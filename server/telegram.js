// Telegram: webhook и дайджест (spec §8.3, §9) — порт src/Telegram.gs.
// UrlFetchApp.fetch → globalThis fetch (Node 18+), отправка асинхронная.
// Мультитенантность: OWNER_CHAT_ID хранится в Settings per-tenant (в GAS — Script Properties).
// Привязка чата владельца: владелец генерирует одноразовый 6-значный код на экране
// «Сотрудники» (api.makeTelegramBindCode) и отправляет его боту; бот пишет chat_id
// в OWNER_CHAT_ID той прачки, к которой привязан код.
// Дайджесты смен — per-tenant (по Shifts.laundry_id).
const db = require('./db');
const { config } = require('./config');
const { todayStr_ } = require('./audit');
const { getShiftByDate_ } = require('./core');
const { consumeTelegramBindCode_ } = require('./api/users');
const { ensureWashesFromDelivery_ } = require('./api/washes');
// Send-слой (R5) вынесен в листовой tg-send.js — здесь ре-экспортируем его
// (внешние потребители, включая тесты, ходят через этот модуль).
const { sendTelegram_, sendDigestLocked_, buildDigestText_, getOwnerChatId_ } = require('./tg-send');

// Идемпотентность webhook по update_id (Telegram шлёт ретраи) — замена CacheService, TTL 24ч.
const seenUpdates = new Map(); // key → expiresAt
const UPD_TTL_MS = 86400 * 1000;

function seenUpdate_(updateId) {
  const key = 'tg_upd_' + updateId;
  const exp = seenUpdates.get(key);
  if (exp && Date.now() < exp) return true;
  seenUpdates.set(key, Date.now() + UPD_TTL_MS);
  // Простая уборка, чтобы Map не рос бесконечно
  if (seenUpdates.size > 10000) {
    const now = Date.now();
    for (const [k, e] of seenUpdates) if (e < now) seenUpdates.delete(k);
  }
  return false;
}

function setOwnerChatId_(chatId, laundryId) {
  db.setTenantSetting_(laundryId, 'OWNER_CHAT_ID', chatId);
  db.invalidateRefCache_();
}

function activeLaundries_() {
  return db.readAll_('Laundries').filter(function (l) { return l.active === 'да'; });
}

// Сценарий привязки: владелец отправляет боту 6-значный одноразовый код
// (сгенерирован на экране «Сотрудники», TTL 10 мин, код привязан к его прачке).
// /start без кода подсказывает, где взять код.
async function handleUpdate_(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const text = String(msg.text).trim();
  // Код принимается и отдельным сообщением, и в формате «/start <код>»
  const candidate = text.indexOf('/start') === 0 ? text.slice(6).trim() : text;
  if (!/^\d{6}$/.test(candidate)) {
    if (text.indexOf('/start') === 0) {
      await sendTelegram_(msg.chat.id, 'CleanLab Pro: отправьте 6-значный код привязки ' +
        '(экран «Сотрудники» → «Привязать Telegram»)');
    }
    return;
  }
  const laundryId = consumeTelegramBindCode_(candidate);
  if (!laundryId) {
    await sendTelegram_(msg.chat.id, 'Неверный или просроченный код');
    return;
  }
  const laundry = db.readAll_('Laundries').filter(function (l) { return l.id === laundryId; })[0];
  setOwnerChatId_(msg.chat.id, laundryId);
  await sendTelegram_(msg.chat.id, (laundry ? laundry.name : 'Прачка') + ': дайджесты подключены ✓');
}

// Fallback (в GAS — триггер на DIGEST_TIME): шлём, только если смена не закрыта.
// Проходим по всем активным прачкам — у каждой своя смена и свой чат владельца.
async function fallbackDigestTrigger() {
  const today = todayStr_();
  for (const l of activeLaundries_()) {
    const shift = getShiftByDate_(today, l.id);
    if (shift && shift.obj.status === 'closed') continue;
    // Дайджест — тоже «экран дня»: стирки из завтрашнего развоза должны существовать
    ensureWashesFromDelivery_(today, l.id);
    await sendDigestLocked_(today, l.id);
  }
}

// --- Webhook (spec §9) ---
function mountTelegram(app) {
  app.post('/telegram/webhook', async (req, res) => {
    // Неверный секрет — молчаливый 200
    try {
      if (!req.query || req.query.secret !== config.WEBHOOK_SECRET) return res.send('ok');
      const update = req.body;
      if (!update || update.update_id === undefined) return res.send('ok');
      if (seenUpdate_(update.update_id)) return res.send('ok');
      await handleUpdate_(update);
    } catch (err) { /* молчаливый 200 */ }
    res.send('ok');
  });
}

module.exports = {
  mountTelegram,
  sendTelegram_, sendDigestLocked_, buildDigestText_, fallbackDigestTrigger,
  handleUpdate_, getOwnerChatId_
};
