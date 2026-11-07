// Per-laundry defaults and immutable mode snapshots for started delivery days.
const db = require('./db');
const { todayStr_, actorOf_, logEvent } = require('./audit');
const { requireRole_ } = require('./auth');
const { ok_, err_ } = require('./core');

const DEFAULT_KEY = 'DELIVERY_MODE_DEFAULT';
const dayKey = date => 'DELIVERY_MODE_DAY_' + date;
const validMode = mode => mode === 'shared' || mode === 'assigned';
const started = v => !!(v.clean_taken_at || v.picked_at || v.delivered_at ||
  v.dirty_handed_at || ['delivered', 'picked', 'both', 'empty'].includes(v.status));

function saveDay_(laundryId, date, value) {
  db.setTenantSetting_(laundryId, dayKey(date), JSON.stringify(value));
  db.invalidateRefCache_();
}

function deliveryMode_(laundryId, date) {
  const settings = db.getSettings_(laundryId);
  let saved;
  try { saved = JSON.parse(settings[dayKey(date)] || 'null'); } catch { saved = null; }
  const defaultMode = settings[DEFAULT_KEY] === 'assigned' ? 'assigned' : 'shared';
  return {
    mode: saved && validMode(saved.mode) ? saved.mode : (date < todayStr_() ? 'shared' : defaultMode),
    default_mode: defaultMode,
    mode_override: !!saved?.explicit,
    mode_locked: !!saved?.locked,
  };
}

// Called only after an operation is known to succeed, inside its transaction.
// Pass the pre-operation mode: the operation may already have changed the visit.
function lockDeliveryMode_(laundryId, date, mode) {
  const current = deliveryMode_(laundryId, date);
  if (!current.mode_locked) saveDay_(laundryId, date, { mode, locked: true, explicit: current.mode_override });
}

function setDeliveryMode(token, date, mode) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  if (!validMode(mode) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    return err_('Укажите дату и режим развоза');
  }
  return db.transaction_(() => {
    const current = deliveryMode_(session.laundryId, date);
    const hasStarted = db.findRowsByTenant_('Deliveries', v => v.date === date && started(v), 1, session.laundryId).length;
    if (current.mode_locked || hasStarted) return err_('Развоз уже начат — режим дня зафиксирован');
    saveDay_(session.laundryId, date, { mode, locked: false, explicit: true });
    logEvent(actorOf_(session), 'delivery_mode', date, { from: current.mode, to: mode }, session.laundryId);
    return ok_(deliveryMode_(session.laundryId, date));
  });
}

function setDefaultDeliveryMode(token, mode) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  if (!validMode(mode)) return err_('Укажите режим развоза');
  return db.transaction_(() => {
    const previous = deliveryMode_(session.laundryId, todayStr_()).default_mode;
    db.setTenantSetting_(session.laundryId, DEFAULT_KEY, mode);
    db.invalidateRefCache_();
    logEvent(actorOf_(session), 'delivery_default_mode', '-', { from: previous, to: mode }, session.laundryId);
    return ok_({ default_mode: mode });
  });
}

module.exports = { deliveryMode_, lockDeliveryMode_, setDeliveryMode, setDefaultDeliveryMode };
