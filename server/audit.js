// Журнал событий (spec §3.8) — порт src/Audit.gs. Время — только в TZ приложения.
const { SHEETS } = require('./schema');
const db = require('./db');
const time = require('./util/time');

function nowStr_() { return time.now(); }
function todayStr_() { return time.today(); }

function logEvent(actor, action, entity, details) {
  db.appendRow_(SHEETS.LOG, {
    ts: nowStr_(),
    actor: actor,
    action: action,
    entity: entity,
    details: typeof details === 'string' ? details : JSON.stringify(details)
  });
}

module.exports = { nowStr_, todayStr_, logEvent };
