// Telegram: webhook и дайджест (spec §8.3, §9) — порт src/Telegram.gs.
// UrlFetchApp.fetch → globalThis fetch (Node 18+), отправка асинхронная.
// OWNER_CHAT_ID хранится в таблице Settings (в GAS писался в Script Properties).
const { SHEETS } = require('./schema');
const db = require('./db');
const { config } = require('./config');
const { todayStr_ } = require('./audit');
const core = require('./core');
const { DONE_STATUSES, buildDayReport_, formatWashLine_, formatDigest_, shiftBlockers_, clientName_ } = core;

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

// OWNER_CHAT_ID: сначала Settings, потом config (ENV).
function getOwnerChatId_() {
  return db.getSettings_().OWNER_CHAT_ID || config.OWNER_CHAT_ID || '';
}

function setOwnerChatId_(chatId) {
  const found = db.findRowsBy_(SHEETS.SETTINGS, function (r) { return r.key === 'OWNER_CHAT_ID'; }, 10);
  if (found.length) {
    found[0].obj.value = String(chatId);
    db.updateRow_(SHEETS.SETTINGS, found[0].rowNumber, found[0].obj);
  } else {
    db.appendRow_(SHEETS.SETTINGS, { key: 'OWNER_CHAT_ID', value: String(chatId) });
  }
  db.invalidateRefCache_();
}

// Использование MVP: /start → бот просит PIN; любое сообщение, равное
// OWNER_PIN, фиксирует OWNER_CHAT_ID (spec §9).
async function handleUpdate_(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const text = String(msg.text).trim();
  // PIN принимается и отдельным сообщением, и в старом формате «/start <PIN>»
  const candidate = text.indexOf('/start') === 0 ? text.slice(6).trim() : text;
  if (candidate && candidate === config.OWNER_PIN) {
    setOwnerChatId_(msg.chat.id);
    await sendTelegram_(msg.chat.id, 'Прачечная PRO: дайджесты подключены ✓');
  } else if (text.indexOf('/start') === 0) {
    await sendTelegram_(msg.chat.id, 'Прачечная PRO: введите PIN владельца');
  }
}

// --- Отправка сообщений ---
// Возвращает Promise<number> (HTTP-код Bot API, 0 — если не настроено/ошибка сети).
async function sendTelegram_(chatId, text) {
  const token = config.BOT_TOKEN;
  const chat = chatId || getOwnerChatId_();
  if (!token || !chat) return 0;
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text })
    });
    return res.status;
  } catch (e) {
    console.error('sendTelegram_ failed:', e);
    return 0;
  }
}

// --- Дайджест ---
function buildDigestText_(date) {
  const { getShiftByDate_ } = require('./api');
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  const washes = db.findRowsBy_(SHEETS.WASHES, function (w) { return w.wash_date === date; }, 1000)
    .map(function (r) { return r.obj; });
  const log = db.findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
  const report = buildDayReport_(date, washes, log);
  const lines = washes
    .filter(function (w) { return DONE_STATUSES.indexOf(w.status) !== -1; })
    .map(function (w) { return formatWashLine_(w, clientName_(w.client_id, clients)); });
  const shift = getShiftByDate_(date);
  let text = formatDigest_(db.getSettings_().LAUNDRY_NAME || 'Прачечная PRO', date, report, lines,
    shift && shift.obj);
  // Fallback-дайджест: список незавершённых
  const closed = shift && shift.obj.status === 'closed';
  if (!closed) {
    const blockers = shiftBlockers_(washes, date);
    if (blockers.length) {
      text += '\nНезавершённые: ' + blockers.map(function (w) {
        return clientName_(w.client_id, clients);
      }).join(', ');
    }
  }
  return text;
}

// В GAS вызывалась ТОЛЬКО под удерживаемым LockService (spec §8.3); в Node
// однопроцессная синхронная запись, await нужен только на HTTP-отправку.
// Флаг digest_sent пишется только после HTTP 200 от Bot API.
async function sendDigestLocked_(date) {
  const { ensureShift_, getShiftByDate_ } = require('./api');
  let shift = getShiftByDate_(date);
  if (shift && String(shift.obj.digest_sent) === 'да') return false;
  if (await sendTelegram_(null, buildDigestText_(date)) !== 200) return false;
  if (!shift) {
    ensureShift_(date);
    shift = getShiftByDate_(date);
  }
  shift.obj.digest_sent = 'да';
  db.updateRow_(SHEETS.SHIFTS, shift.rowNumber, shift.obj);
  return true;
}

// Fallback (в GAS — триггер на DIGEST_TIME): шлём, только если смена не закрыта.
async function fallbackDigestTrigger() {
  const { getShiftByDate_ } = require('./api');
  const today = todayStr_();
  const shift = getShiftByDate_(today);
  if (shift && shift.obj.status === 'closed') return;
  await sendDigestLocked_(today);
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
