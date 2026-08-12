// Журнал событий (spec §3.8). Время — только в TZ скрипта.
function nowStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function logEvent(actor, action, entity, details) {
  appendRow_(SHEETS.LOG, {
    ts: nowStr_(),
    actor: actor,
    action: action,
    entity: entity,
    details: typeof details === 'string' ? details : JSON.stringify(details)
  });
}
