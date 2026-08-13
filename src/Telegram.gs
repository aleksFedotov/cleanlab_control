// Telegram: webhook и дайджест (spec §8.3, §9).

// --- Webhook (spec §9) ---
function doPost(e) {
  var out = ContentService.createTextOutput('ok');
  try {
    var props = PropertiesService.getScriptProperties();
    // Неверный секрет — молчаливый 200
    if (!e || !e.parameter || e.parameter.secret !== props.getProperty('WEBHOOK_SECRET')) return out;
    var update = JSON.parse(e.postData.contents);
    // Идемпотентность по update_id (Telegram шлёт ретраи)
    var cache = CacheService.getScriptCache();
    var key = 'tg_upd_' + update.update_id;
    if (cache.get(key)) return out;
    cache.put(key, '1', 86400);
    handleUpdate_(update, props);
  } catch (err) { /* молчаливый 200 */ }
  return out;
}

// Использование MVP: /start → бот просит PIN; любое сообщение, равное
// OWNER_PIN, фиксирует OWNER_CHAT_ID (spec §9).
function handleUpdate_(update, props) {
  var msg = update.message;
  if (!msg || !msg.text) return;
  var text = String(msg.text).trim();
  // PIN принимается и отдельным сообщением, и в старом формате «/start <PIN>»
  var candidate = text.indexOf('/start') === 0 ? text.slice(6).trim() : text;
  if (candidate && candidate === props.getProperty('OWNER_PIN')) {
    props.setProperty('OWNER_CHAT_ID', String(msg.chat.id));
    sendTelegram_(msg.chat.id, 'Прачка360: дайджесты подключены ✓');
  } else if (text.indexOf('/start') === 0) {
    sendTelegram_(msg.chat.id, 'Прачка360: введите PIN владельца');
  }
}

// --- Отправка сообщений ---
function sendTelegram_(chatId, text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('BOT_TOKEN');
  var chat = chatId || props.getProperty('OWNER_CHAT_ID');
  if (!token || !chat) return 0;
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chat, text: text }),
    muteHttpExceptions: true
  });
  return res.getResponseCode();
}

// --- Дайджест ---
function buildDigestText_(date) {
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var washes = findRowsBy_(SHEETS.WASHES, function (w) { return w.wash_date === date; }, 1000)
    .map(function (r) { return r.obj; });
  var log = findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
  var report = buildDayReport_(date, washes, log);
  var lines = washes
    .filter(function (w) { return DONE_STATUSES.indexOf(w.status) !== -1; })
    .map(function (w) { return formatWashLine_(w, clientName_(w.client_id, clients)); });
  var shift = getShiftByDate_(date);
  var text = formatDigest_(getSettings_().LAUNDRY_NAME || 'Прачка360', date, report, lines,
    shift && shift.obj);
  // Fallback-дайджест: список незавершённых
  var closed = shift && shift.obj.status === 'closed';
  if (!closed) {
    var blockers = shiftBlockers_(washes, date);
    if (blockers.length) {
      text += '\nНезавершённые: ' + blockers.map(function (w) {
        return clientName_(w.client_id, clients);
      }).join(', ');
    }
  }
  return text;
}

// Атомарно: вызывается ТОЛЬКО под удерживаемым LockService (spec §8.3).
// Флаг digest_sent пишется только после HTTP 200 от Bot API.
function sendDigestLocked_(date) {
  var shift = getShiftByDate_(date);
  if (shift && String(shift.obj.digest_sent) === 'да') return false;
  if (sendTelegram_(null, buildDigestText_(date)) !== 200) return false;
  if (!shift) {
    ensureShift_(date);
    shift = getShiftByDate_(date);
  }
  shift.obj.digest_sent = 'да';
  updateRow_(SHEETS.SHIFTS, shift.rowNumber, shift.obj);
  return true;
}

// Fallback-триггер на DIGEST_TIME: шлём, только если смена не закрыта.
function fallbackDigestTrigger() {
  var today = todayStr_();
  var shift = getShiftByDate_(today);
  if (shift && shift.obj.status === 'closed') return;
  withLock_(function () { sendDigestLocked_(today); });
}
