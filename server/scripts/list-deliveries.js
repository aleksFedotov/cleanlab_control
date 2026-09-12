// Просмотр строк Deliveries за дату: id, клиент, статус, кем/когда создан.
//   node scripts/list-deliveries.js <дата>        — например 2026-09-14
// Путь к БД: DB_PATH из env, иначе server/data/cleanlab.sqlite.

const path = require('path');
const Database = require('better-sqlite3');

const date = process.argv[2];
if (!date) {
  console.error('Использование: node scripts/list-deliveries.js <дата>');
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cleanlab.sqlite');
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  'SELECT d.id, c.name AS client_name, d.status, d.created_by, d.created_at, d.laundry_id ' +
  'FROM Deliveries d LEFT JOIN Clients c ON c.id = d.client_id ' +
  'WHERE d.date = ? ORDER BY c.name, d.id'
).all(date);
if (!rows.length) {
  console.log('За ' + date + ' строк нет.');
  return;
}
rows.forEach(function (r) {
  console.log([r.id, '[' + r.laundry_id + ']', r.client_name, r.status, r.created_by, r.created_at].join('  '));
});
console.log('Всего: ' + rows.length);
