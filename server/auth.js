// Аутентификация и сессии (spec §5.1) — логин + пароль.
// Пользователи — в таблице Users: логин глобально уникален, пароль хранится
// как scrypt-хэш "salt:hash" (см. util/passwords.js).
// Сессии — персистентные (таблица Sessions): TTL 30 дней, скользящее продление,
// переживают рестарт процесса. Активная прачка owner хранится в Sessions.laundry_id.
const crypto = require('node:crypto');
const db = require('./db');
const { hashPassword, checkPassword } = require('./util/passwords');

const SESSION_TTL_MS = 30 * 86400 * 1000; // 30 дней

// Rate-limit входа: 5 неудачных попыток по логину → блок на 5 минут (в памяти процесса).
const RL_MAX_FAILS = 5;
const RL_BLOCK_MS = 5 * 60 * 1000;
const loginFails = new Map(); // login → { fails, blockedUntil }

const AUTH_ERROR = 'Неверный логин или пароль';

// Активные прачки (для выбора владельцем и ответа login).
function listLaundries() {
  return db.readAll_('Laundries')
    .filter(function (l) { return l.active === 'да'; })
    .map(function (l) { return { id: l.id, name: l.name }; });
}

// Активный пользователь по глобально-уникальному логину.
function findUserByLogin_(username) {
  return db.readAll_('Users').filter(function (u) {
    return u.active === 'да' && u.login === String(username);
  })[0] || null;
}

// Чистка протухших сессий — вызывается при старте сервера и при входе.
function cleanupExpiredSessions_() {
  const now = Date.now();
  db.findRowsBy_('Sessions', function (s) { return Number(s.expires_at) < now; }, 10000)
    .forEach(function (r) { db.deleteRow_('Sessions', r.rowNumber); });
}

function rlBlocked_(username) {
  const rec = loginFails.get(username);
  return !!(rec && rec.blockedUntil && Date.now() < rec.blockedUntil);
}

function rlFail_(username) {
  const rec = loginFails.get(username) || { fails: 0, blockedUntil: 0 };
  rec.fails++;
  if (rec.fails >= RL_MAX_FAILS) { rec.fails = 0; rec.blockedUntil = Date.now() + RL_BLOCK_MS; }
  loginFails.set(username, rec);
}

function login(username, password) {
  username = String(username || '').trim();
  cleanupExpiredSessions_();
  // Одно сообщение на все ошибки входа: не раскрываем, что именно неверно
  if (rlBlocked_(username)) return { ok: false, error: AUTH_ERROR };
  const user = findUserByLogin_(username);
  // У пользователя без pass_hash (старые PIN-аккаунты) вход по паролю не работает
  if (!user || !user.pass_hash || !checkPassword(password || '', user.pass_hash)) {
    rlFail_(username);
    return { ok: false, error: AUTH_ERROR };
  }
  loginFails.delete(username);
  // Роль client — задел под кабинет клиента: аккаунт можно создать, но входа нет
  if (user.role === 'client') return { ok: false, error: 'Доступ для клиента не настроен' };
  const laundries = listLaundries();
  // Активная прачка в сессии: у owner (laundry_id пуст) — первая активная
  const activeLaundry = user.role === 'owner'
    ? (laundries.length ? laundries[0].id : '')
    : user.laundry_id;
  const token = crypto.randomUUID();
  db.appendRow_('Sessions', {
    token: token, user_id: user.id,
    laundry_id: activeLaundry, expires_at: Date.now() + SESSION_TTL_MS
  });
  const res = { ok: true, token: token, role: user.role, name: user.name, laundryId: activeLaundry };
  // Владельцу — список прачек для переключателя в UI
  if (user.role === 'owner') res.laundries = laundries;
  return res;
}

// Сессия из БД со скользящим продлением TTL при каждом запросе.
// Join Users: деактивированный пользователь = невалидная сессия.
// Возвращает { userId, name, role, laundryId, clientId } или null.
function getSession_(token) {
  if (!token) return null;
  const found = db.findRowsBy_('Sessions', function (s) { return s.token === token; }, 10000)[0];
  if (!found) return null;
  if (Date.now() > Number(found.obj.expires_at)) {
    db.deleteRow_('Sessions', found.rowNumber);
    return null;
  }
  const user = db.findById_('Users', found.obj.user_id);
  if (!user || user.obj.active !== 'да') return null;
  // Скользящее продление
  found.obj.expires_at = Date.now() + SESSION_TTL_MS;
  db.updateRow_('Sessions', found.rowNumber, found.obj);
  return {
    userId: user.obj.id, name: user.obj.name, role: user.obj.role,
    laundryId: found.obj.laundry_id, clientId: user.obj.client_id || ''
  };
}

function logout(token) {
  const found = token && db.findRowsBy_('Sessions', function (s) { return s.token === token; }, 10000)[0];
  if (found) db.deleteRow_('Sessions', found.rowNumber);
  return { ok: true };
}

// Роль — только из сессии; параметру role от клиента сервер не доверяет.
// Возвращает объект сессии (userId, name, role, laundryId, clientId) или null.
function requireRole_(token, roles) {
  const session = getSession_(token);
  if (!session || roles.indexOf(session.role) === -1) return null;
  return session;
}

// Смена активной прачки в сессии — только владелец. Обновляет запись Sessions.
function switchLaundry(token, laundryId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return { ok: false, error: 'Нет доступа' };
  const ok = listLaundries().some(function (l) { return l.id === String(laundryId); });
  if (!ok) return { ok: false, error: 'Прачка не найдена' };
  const found = db.findRowsBy_('Sessions', function (s) { return s.token === token; }, 10000)[0];
  found.obj.laundry_id = String(laundryId);
  db.updateRow_('Sessions', found.rowNumber, found.obj);
  return { ok: true, laundryId: found.obj.laundry_id };
}

module.exports = {
  login, logout, getSession_, requireRole_, switchLaundry, listLaundries,
  hashPassword_: hashPassword, checkPassword_: checkPassword,
  cleanupExpiredSessions_
};
