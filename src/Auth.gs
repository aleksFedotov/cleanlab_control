// Аутентификация и сессии (spec §5.1). Пины — в Script Properties, секреты не в таблице.
var SESSION_TTL_SEC = 43200; // 12 часов
var SESSION_PREFIX = 'sess_';

function login(pin) {
  var props = PropertiesService.getScriptProperties();
  var role = null;
  if (String(pin) === props.getProperty('OWNER_PIN')) role = 'owner';
  else if (String(pin) === props.getProperty('WORKER_PIN')) role = 'worker';
  else if (String(pin) === props.getProperty('DRIVER_PIN')) role = 'driver';
  if (!role) return { ok: false, error: 'Неверный PIN' };
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put(SESSION_PREFIX + token,
    JSON.stringify({ role: role }), SESSION_TTL_SEC);
  return { ok: true, token: token, role: role };
}

// Сессия со скользящим продлением TTL при каждом запросе.
function getSession_(token) {
  if (!token) return null;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(SESSION_PREFIX + token);
  if (!raw) return null;
  cache.put(SESSION_PREFIX + token, raw, SESSION_TTL_SEC);
  return JSON.parse(raw);
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove(SESSION_PREFIX + token);
  return { ok: true };
}

// Роль — только из сессии; параметру role от клиента сервер не доверяет.
function requireRole_(token, roles) {
  var session = getSession_(token);
  if (!session || roles.indexOf(session.role) === -1) return null;
  return session.role;
}
