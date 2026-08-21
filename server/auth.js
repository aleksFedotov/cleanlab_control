// Аутентификация и сессии (spec §5.1) — мультитенантная версия.
// Пользователи — в таблице Users (персональные аккаунты, PIN уникален в прачке;
// PIN владельца глобально уникален, laundry_id у него пуст).
// Сессии — в памяти процесса (замена CacheService): TTL 12 ч, скользящее продление.
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_TTL_MS = 43200 * 1000; // 12 часов

// token → { userId, name, role, laundryId, clientId, expiresAt }
const sessions = new Map();

// Активные прачки (для экрана входа и выбора владельцем).
function listLaundries() {
  return db.readAll_('Laundries')
    .filter(function (l) { return l.active === 'да'; })
    .map(function (l) { return { id: l.id, name: l.name }; });
}

// Пользователь по PIN: owner — без привязки к прачке (PIN глобально уникален),
// остальные роли — по паре (laundry_id, pin).
function findUserByPin_(laundryId, pin) {
  const users = db.readAll_('Users').filter(function (u) {
    return u.active === 'да' && u.pin === String(pin);
  });
  const owner = users.filter(function (u) { return u.role === 'owner'; })[0];
  if (owner) return owner;
  if (laundryId === undefined || laundryId === null || laundryId === '') return null;
  return users.filter(function (u) {
    return u.laundry_id === String(laundryId);
  })[0] || null;
}

function login(laundryId, pin) {
  const user = findUserByPin_(laundryId, pin);
  if (!user) return { ok: false, error: 'Неверный PIN' };
  // Роль client — задел под кабинет клиента: аккаунт можно создать, но входа нет
  if (user.role === 'client') return { ok: false, error: 'Доступ для клиента не настроен' };
  const laundries = listLaundries();
  // Активная прачка в сессии: явно выбранная на входе, иначе первая активная
  let activeLaundry = laundryId ? String(laundryId) : '';
  if (user.role === 'owner') {
    if (!activeLaundry || !laundries.some(function (l) { return l.id === activeLaundry; })) {
      activeLaundry = laundries.length ? laundries[0].id : '';
    }
  } else {
    activeLaundry = user.laundry_id;
  }
  const token = crypto.randomUUID();
  sessions.set(token, {
    userId: user.id, name: user.name, role: user.role,
    laundryId: activeLaundry, clientId: user.client_id || '',
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  const res = { ok: true, token: token, role: user.role, name: user.name, laundryId: activeLaundry };
  // Владельцу — список прачек для переключателя в UI
  if (user.role === 'owner') res.laundries = laundries;
  return res;
}

// Сессия со скользящим продлением TTL при каждом запросе.
function getSession_(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return s;
}

function logout(token) {
  if (token) sessions.delete(token);
  return { ok: true };
}

// Роль — только из сессии; параметру role от клиента сервер не доверяет.
// Возвращает объект сессии (userId, name, role, laundryId, clientId) или null.
function requireRole_(token, roles) {
  const session = getSession_(token);
  if (!session || roles.indexOf(session.role) === -1) return null;
  return session;
}

// Смена активной прачки в сессии — только владелец.
function switchLaundry(token, laundryId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return { ok: false, error: 'Нет доступа' };
  const ok = listLaundries().some(function (l) { return l.id === String(laundryId); });
  if (!ok) return { ok: false, error: 'Прачка не найдена' };
  // Меняем запись в Map напрямую: getSession_ вернула тот же объект
  session.laundryId = String(laundryId);
  return { ok: true, laundryId: session.laundryId };
}

module.exports = { login, logout, getSession_, requireRole_, switchLaundry, listLaundries };
