// Telegram: слой отправки (R5) — листовой модуль, выделенный из telegram.js.
// Здесь живут чтение OWNER_CHAT_ID, sendTelegram_, сборка дайджеста и его
// отправка. Зависимости — только листовые (config, db, core): webhook-часть
// (telegram.js) и команды доменов могут требовать этот модуль статически,
// не создавая циклов.
const { SHEETS } = require('./schema');
const db = require('./db');
const { config } = require('./config');
const { ensureShift_, getShiftByDate_, DONE_STATUSES, buildDayReport_, formatWashLine_, formatDigest_, shiftBlockers_, clientName_ } = require('./core');

// OWNER_CHAT_ID прачки: per-tenant строка Settings перекрывает глобальную.
function getOwnerChatId_(laundryId) {
  return db.getSettings_(laundryId).OWNER_CHAT_ID || '';
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

module.exports = { getOwnerChatId_, sendTelegram_, buildDigestText_, sendDigestLocked_ };
