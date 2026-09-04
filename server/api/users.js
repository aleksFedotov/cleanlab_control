// Пользователи (owner): экран «Сотрудники» + одноразовые коды привязки Telegram.
// Вынесено из api.js при делёжке (R1); код перенесён как есть.
const crypto = require('node:crypto');
const db = require('../db');
const { logEvent, actorOf_ } = require('../audit');
const { hashPassword_ } = require('../auth');
const { err_, ok_ } = require('../core');

// --- Пользователи (owner): экран «Сотрудники» ---

// Список пользователей прачки (по умолчанию — активной в сессии) + владельцы.
// Отдаём и неактивных (active=нет) — UI их помечает и предлагает «Включить».
// pass_hash/pin из ответа убираем: клиенту хэши не нужны.
function listUsers(session, laundryId) {
  const lid = String(laundryId || session.laundryId);
  const users = db.readAll_('Users').filter(function (u) {
    return u.laundry_id === lid || u.role === 'owner';
  }).map(function (u) {
    return { id: u.id, laundry_id: u.laundry_id, name: u.name, role: u.role,
      login: u.login, active: u.active, client_id: u.client_id };
  });
  return ok_({ users: users });
}

// Создание аккаунта. Логин глобально уникален (вход — только по логину+паролю,
// без выбора прачки). Пароль хранится как scrypt-хэш (util/passwords.js).
// Роль client (задел) требует clientId — ссылку на клиента справочника.
function createUser(session, user) {
  user = user || {};
  const ROLES = ['owner', 'worker', 'driver', 'client'];
  if (ROLES.indexOf(user.role) === -1) return err_('Неизвестная роль');
  if (!user.name) return err_('Укажите имя');
  if (!user.login) return err_('Укажите логин');
  if (!user.password) return err_('Укажите пароль');
  if (user.role !== 'owner' && !user.laundryId) return err_('Укажите прачку');
  if (user.role === 'client' && !user.clientId) return err_('Выберите клиента');
  const login = String(user.login).trim();
  const taken = db.readAll_('Users').some(function (u) {
    return u.active === 'да' && u.login === login;
  });
  if (taken) return err_('Логин уже занят');
  const saved = {
    id: db.nextId_('Users', 'usr'),
    laundry_id: user.role === 'owner' ? '' : String(user.laundryId),
    name: user.name, role: user.role, pin: '', active: 'да',
    client_id: user.role === 'client' ? String(user.clientId) : '',
    login: login, pass_hash: hashPassword_(user.password)
  };
  db.appendRow_('Users', saved);
  logEvent(actorOf_(session), 'user_create', saved.id, { name: saved.name, role: saved.role, laundry_id: saved.laundry_id }, session.laundryId);
  return ok_({ user: { id: saved.id, laundry_id: saved.laundry_id, name: saved.name, role: saved.role, login: saved.login, active: saved.active, client_id: saved.client_id } });
}

// Сброс пароля пользователя (owner): новый пароль хэшируется, старый перезаписывается.
function resetUserPassword(session, userId, newPassword) {
  if (!newPassword) return err_('Укажите пароль');
  const found = db.findById_('Users', userId);
  if (!found) return err_('Пользователь не найден');
  found.obj.pass_hash = hashPassword_(newPassword);
  db.updateRow_('Users', found.rowNumber, found.obj);
  logEvent(actorOf_(session), 'user_password_reset', userId, { name: found.obj.name }, session.laundryId);
  return ok_({ user: found.obj });
}

// Правка аккаунта: имя, роль, логин, clientId (при роли client). Пароль не
// трогаем — для этого resetUserPassword. Логин глобально уникален (кроме самого
// пользователя). Нельзя менять роль самому себе (owner по своему userId).
function updateUser(session, user) {
  user = user || {};
  const found = db.findById_('Users', user.id);
  if (!found) return err_('Пользователь не найден');
  const ROLES = ['owner', 'worker', 'driver', 'client'];
  if (user.role !== undefined && ROLES.indexOf(user.role) === -1) return err_('Неизвестная роль');
  if (user.name !== undefined && !String(user.name).trim()) return err_('Укажите имя');
  if (String(user.id) === String(session.userId) && user.role !== undefined && user.role !== found.obj.role) {
    return err_('Нельзя изменить роль самому себе');
  }
  const u = found.obj;
  if (user.name !== undefined) u.name = String(user.name).trim();
  if (user.role !== undefined) u.role = user.role;
  if (user.login !== undefined) {
    const login = String(user.login).trim();
    if (!login) return err_('Укажите логин');
    const taken = db.readAll_('Users').some(function (x) {
      return x.active === 'да' && x.login === login && x.id !== u.id;
    });
    if (taken) return err_('Логин уже занят');
    u.login = login;
  }
  // Роль client требует ссылку на клиента; у остальных ролей client_id пуст
  if (user.clientId !== undefined || user.role !== undefined) {
    const cid = user.clientId !== undefined ? user.clientId : u.client_id;
    if (u.role === 'client') {
      if (!cid) return err_('Выберите клиента');
      u.client_id = String(cid);
    } else {
      u.client_id = '';
    }
  }
  db.updateRow_('Users', found.rowNumber, u);
  logEvent(actorOf_(session), 'user_update', u.id, { name: u.name, role: u.role, login: u.login }, session.laundryId);
  return ok_({ user: { id: u.id, laundry_id: u.laundry_id, name: u.name, role: u.role, login: u.login, active: u.active, client_id: u.client_id } });
}

function deactivateUser(session, id) {
  if (String(id) === String(session.userId)) return err_('Нельзя отключить самого себя');
  const found = db.findById_('Users', id);
  if (!found) return err_('Пользователь не найден');
  found.obj.active = 'нет';
  db.updateRow_('Users', found.rowNumber, found.obj);
  logEvent(actorOf_(session), 'user_deactivate', id, { name: found.obj.name }, session.laundryId);
  return ok_({ user: found.obj });
}

// Возврат доступа отключённому пользователю (пара к deactivateUser).
function reactivateUser(session, id) {
  const found = db.findById_('Users', id);
  if (!found) return err_('Пользователь не найден');
  found.obj.active = 'да';
  db.updateRow_('Users', found.rowNumber, found.obj);
  logEvent(actorOf_(session), 'user_reactivate', id, { name: found.obj.name }, session.laundryId);
  return ok_({ user: found.obj });
}

// Необратимое удаление пользователя (в отличие от deactivateUser — строка
// убирается из Users совсем). Нельзя удалить себя и последнего активного
// владельца. Сессии удалённого чистить не нужно: getSession_ отклоняет их,
// когда пользователь не найден (auth.js).
function deleteUser(session, id) {
  if (String(id) === String(session.userId)) return err_('Нельзя удалить самого себя');
  const found = db.findById_('Users', id);
  if (!found) return err_('Пользователь не найден');
  if (found.obj.role === 'owner' && found.obj.active === 'да') {
    const otherOwners = db.readAll_('Users').filter(function (u) {
      return u.role === 'owner' && u.active === 'да' && String(u.id) !== String(id);
    });
    if (!otherOwners.length) return err_('Нельзя удалить последнего владельца');
  }
  db.deleteRow_('Users', found.rowNumber);
  logEvent(actorOf_(session), 'user_delete', id, { name: found.obj.name, role: found.obj.role }, session.laundryId);
  return ok_({ id: id });
}

// Одноразовые коды привязки Telegram-чата (в памяти процесса, TTL 10 мин).
// Код генерирует владелец с экрана «Сотрудники»; бот принимает код и пишет
// chat_id в per-tenant Settings OWNER_CHAT_ID прачки, к которой привязан код.
const TG_CODE_TTL_MS = 10 * 60 * 1000;
const telegramBindCodes = new Map(); // code → { laundryId, expiresAt }

function makeTelegramBindCode(session) {
  // Уборка протухших, чтобы Map не рос
  const now = Date.now();
  for (const [c, rec] of telegramBindCodes) if (rec.expiresAt < now) telegramBindCodes.delete(c);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  telegramBindCodes.set(code, { laundryId: session.laundryId, expiresAt: now + TG_CODE_TTL_MS });
  return ok_({ code: code });
}

// Проверка и погашение кода (вызывается из telegram.js при сообщении боту).
// Возвращает laundryId при успехе, null — код невалиден или протух.
function consumeTelegramBindCode_(code) {
  const rec = telegramBindCodes.get(String(code));
  if (!rec || Date.now() > rec.expiresAt) return null;
  telegramBindCodes.delete(String(code));
  return rec.laundryId;
}
module.exports = {
  listUsers, createUser, updateUser, resetUserPassword,
  deactivateUser, reactivateUser, deleteUser,
  makeTelegramBindCode, consumeTelegramBindCode_
};
