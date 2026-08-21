// Хэширование паролей: scrypt (node:crypto), формат хранения "salt:hash" (hex).
// Вынесено в util, чтобы db.js (миграции) и auth.js могли использовать без
// циклического require (auth → db, db → auth был бы циклом).
const crypto = require('node:crypto');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return salt + ':' + hash;
}

// Сравнение через timingSafeEqual; битый формат хэша = несовпадение.
function checkPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const expected = Buffer.from(parts[1], 'hex');
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = crypto.scryptSync(String(password), parts[0], SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, checkPassword };
