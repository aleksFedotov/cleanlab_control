// Аутентификация и сессии (spec §5.1) — порт src/Auth.gs.
// Пины — в ENV (config), секреты не в таблице.
// Сессии — в памяти процесса (замена CacheService): TTL 12 ч, скользящее продление.
const crypto = require('node:crypto');
const { config } = require('./config');

const SESSION_TTL_MS = 43200 * 1000; // 12 часов

// token → { role, expiresAt }
const sessions = new Map();

function login(pin) {
  let role = null;
  if (String(pin) === config.OWNER_PIN && config.OWNER_PIN) role = 'owner';
  else if (String(pin) === config.WORKER_PIN && config.WORKER_PIN) role = 'worker';
  else if (String(pin) === config.DRIVER_PIN && config.DRIVER_PIN) role = 'driver';
  if (!role) return { ok: false, error: 'Неверный PIN' };
  const token = crypto.randomUUID();
  sessions.set(token, { role: role, expiresAt: Date.now() + SESSION_TTL_MS });
  return { ok: true, token: token, role: role };
}

// Сессия со скользящим продлением TTL при каждом запросе.
function getSession_(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return { role: s.role };
}

function logout(token) {
  if (token) sessions.delete(token);
  return { ok: true };
}

// Роль — только из сессии; параметру role от клиента сервер не доверяет.
function requireRole_(token, roles) {
  const session = getSession_(token);
  if (!session || roles.indexOf(session.role) === -1) return null;
  return session.role;
}

module.exports = { login, logout, getSession_, requireRole_ };
