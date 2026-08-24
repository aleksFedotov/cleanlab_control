// Telegram: webhook и дайджест (spec §8.3, §9) — порт src/Telegram.gs.
// UrlFetchApp.fetch → globalThis fetch (Node 18+), отправка асинхронная.
// Мультитенантность: OWNER_CHAT_ID хранится в Settings per-tenant (в GAS — Script Properties).
// Привязка чата владельца: владелец генерирует одноразовый 6-значный код на экране
// «Сотрудники» (api.makeTelegramBindCode) и отправляет его боту; бот пишет chat_id
// в OWNER_CHAT_ID той прачки, к которой привязан код.
// Дайджесты смен — per-tenant (по Shifts.laundry_id).
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

// OWNER_CHAT_ID прачки: per-tenant строка Settings перекрывает глобальную.
function getOwnerChatId_(laundryId) {
  return db.getSettings_(laundryId).OWNER_CHAT_ID || '';
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
  const { consumeTelegramBindCode_ } = require('./api');
  const laundryId = consumeTelegramBindCode_(candidate);
  if (!laundryId) {
    await sendTelegram_(msg.chat.id, 'Неверный или просроченный код');
    return;
  }
  const laundry = db.readAll_('Laundries').filter(function (l) { return l.id === laundryId; })[0];
  setOwnerChatId_(msg.chat.id, laundryId);
  await sendTelegram_(msg.chat.id, (laundry ? laundry.name : 'Прачка') + ': дайджесты подключены ✓');
}

// --- Отправка сообщений ---
// Возвращает Promise<number> (HTTP-код Bot API, 0 — если не настроено/ошибка сети).
async function sendTelegram_(chatId, text, laundryId) {
  const token = config.BOT_TOKEN;
  const chat = chatId || getOwnerChatId_(laundryId);
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
function buildDigestText_(date, laundryId) {
  const { getShiftByDate_ } = require('./api');
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) { return w.wash_date === date; }, 1000, laundryId)
    .map(function (r) { return r.obj; });
  const log = db.readTailByTenant_(SHEETS.LOG, 1000, laundryId);
  const report = buildDayReport_(date, washes, log);
  const lines = washes
    .filter(function (w) { return DONE_STATUSES.indexOf(w.status) !== -1; })
    .map(function (w) { return formatWashLine_(w, clientName_(w.client_id, clients)); });
  const shift = getShiftByDate_(date, laundryId);
  let text = formatDigest_(db.getSettings_(laundryId).LAUNDRY_NAME || 'CleanLab Pro', date, report, lines,
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
async function sendDigestLocked_(date, laundryId) {
  const { ensureShift_, getShiftByDate_ } = require('./api');
  let shift = getShiftByDate_(date, laundryId);
  if (shift && String(shift.obj.digest_sent) === 'да') return false;
  if (await sendTelegram_(null, buildDigestText_(date, laundryId), laundryId) !== 200) return false;
  if (!shift) {
    ensureShift_(date, laundryId);
    shift = getShiftByDate_(date, laundryId);
  }
  shift.obj.digest_sent = 'да';
  db.updateRow_(SHEETS.SHIFTS, shift.rowNumber, shift.obj);
  return true;
}

// Fallback (в GAS — триггер на DIGEST_TIME): шлём, только если смена не закрыта.
// Проходим по всем активным прачкам — у каждой своя смена и свой чат владельца.
async function fallbackDigestTrigger() {
  const { getShiftByDate_, ensureWashesFromDelivery_ } = require('./api');
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
