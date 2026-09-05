// Прачки (owner): вкладка «Прачки» + TV-табло (spec §5.3).
// Вынесено из api.js при делёжке (R1); код перенесён как есть.
const { SHEETS } = require('../schema');
const crypto = require('node:crypto');
const db = require('../db');
const { todayStr_, logEvent, actorOf_ } = require('../audit');
const {
  isDayWash_, sortDayList_, err_, ok_, clientName_, withLock_, timeStr_
} = require('../core');

// --- Прачки (owner): вкладка «Прачки» ---

// Список активных прачек с TV-ключами (per-tenant Settings). Owner-only:
// раньше метод был публичным для выбора прачки на входе, но вход теперь
// по логину+паролю без выбора прачки — список нужен только владельцу.
function listLaundries(session) {
  const laundries = db.readAll_('Laundries')
    .filter(function (l) { return l.active === 'да'; })
    .map(function (l) {
      return { id: l.id, name: l.name, tvKey: db.getSettings_(l.id).TV_KEY || '' };
    });
  return ok_({ laundries: laundries });
}

// Новая прачка из веб-интерфейса (без ENV-сида). TV-ключ табла генерируется
// случайно и кладётся в per-tenant Settings новой прачки.
function createLaundry(session, data) {
  const name = String((data && data.name) || '').trim();
  if (!name) return err_('Укажите название прачки');
  return withLock_(function () {
    let maxId = 0;
    db.readAll_('Laundries').forEach(function (l) { maxId = Math.max(maxId, Number(l.id) || 0); });
    const laundry = { id: String(maxId + 1), name: name, active: 'да' };
    db.appendRow_('Laundries', laundry);
    db.setTenantSetting_(laundry.id, 'LAUNDRY_NAME', name);
    const tvKey = crypto.randomBytes(12).toString('hex');
    db.setTenantSetting_(laundry.id, 'TV_KEY', tvKey);
    db.invalidateRefCache_();
    logEvent(actorOf_(session), 'laundry_create', laundry.id, { name: name }, session.laundryId);
    return ok_({ laundry: { id: laundry.id, name: name }, tvKey: tvKey });
  });
}

// Переименование прачки: запись в Laundries + per-tenant Settings LAUNDRY_NAME.
function updateLaundry(session, data) {
  const name = String((data && data.name) || '').trim();
  if (!name) return err_('Укажите название прачки');
  const found = db.findById_('Laundries', data && data.id);
  if (!found) return err_('Прачка не найдена');
  found.obj.name = name;
  db.updateRow_('Laundries', found.rowNumber, found.obj);
  db.setTenantSetting_(found.obj.id, 'LAUNDRY_NAME', name);
  db.invalidateRefCache_();
  logEvent(actorOf_(session), 'laundry_update', found.obj.id, { name: name }, session.laundryId);
  return ok_({ laundry: { id: found.obj.id, name: name } });
}

// Деактивация прачки: данные не удаляются, прачка пропадает из списков.
// Нельзя деактивировать активную прачку текущей сессии и последнюю активную.
function deactivateLaundry(session, id) {
  const found = db.findById_('Laundries', id);
  if (!found) return err_('Прачка не найдена');
  if (String(id) === String(session.laundryId)) {
    return err_('Нельзя отключить активную прачку — переключитесь на другую');
  }
  const activeCount = db.readAll_('Laundries').filter(function (l) { return l.active === 'да'; }).length;
  if (activeCount <= 1) return err_('Нельзя отключить последнюю активную прачку');
  found.obj.active = 'нет';
  db.updateRow_('Laundries', found.rowNumber, found.obj);
  db.invalidateRefCache_();
  logEvent(actorOf_(session), 'laundry_deactivate', id, { name: found.obj.name }, session.laundryId);
  return ok_({ laundry: found.obj });
}

// --- TV-табло (spec §5.3): по ключу прачки, только чтение, только агрегаты дня ---
// Ключ ищется в per-tenant Settings (TV_KEY), данные — только той прачки.
function getTvData(key) {
  if (!key) return err_('Нет доступа');
  const row = db.readAll_('Settings').filter(function (r) {
    return r.key === 'TV_KEY' && r.laundry_id && r.value === String(key);
  })[0];
  if (!row) return err_('Нет доступа');
  const laundryId = row.laundry_id;
  const today = todayStr_();
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) { return isDayWash_(w, today); }, 1000, laundryId)
    .map(function (r) { return r.obj; });
  const counters = { total: washes.length, planned: 0, in_progress: 0, done: 0, stored: 0, deferred: 0 };
  const cards = sortDayList_(washes).map(function (w) {
    if (counters[w.status] !== undefined) counters[w.status]++;
    // «Нет белья» показывается в колонке «Готово» — считаем её там же
    if (w.status === 'no_linen') counters.done++;
    if (w.deferred_from) counters.deferred++;
    return {
      client: clientName_(w.client_id, clients), status: w.status,
      kg: w.dirty_weight_kg || '', items: w.items_total || '',
      deferred_from: w.deferred_from || '', comment: w.comment || ''
    };
  });
  return ok_({
    date: today, laundryName: db.getSettings_(laundryId).LAUNDRY_NAME || 'CleanLab Pro',
    counters: counters, washes: cards, updatedAt: timeStr_()
  });
}
module.exports = {
  listLaundries, createLaundry, updateLaundry, deactivateLaundry, getTvData
};
