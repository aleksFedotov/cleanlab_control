// Восстановление строк Deliveries из бэкапа (напр. после ошибочной очистки).
// Вставляет только отсутствующие id — существующие строки не задевает.
//
// Запуск:
//   node scripts/restore-deliveries.js <путь-к-бэкапу> <дата[,дата...]>
// Пример:
//   node scripts/restore-deliveries.js /data/cleanlab.backup-20260912111218.sqlite 2026-09-13,2026-09-14
// Путь к рабочей БД: DB_PATH из env, иначе server/data/cleanlab.sqlite.

const path = require('path');
const Database = require('better-sqlite3');

const backupPath = process.argv[2];
const dates = (process.argv[3] || '').split(',').filter(Boolean);
if (!backupPath || !dates.length) {
  console.error('Использование: node scripts/restore-deliveries.js <бэкап> <дата[,дата...]>');
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cleanlab.sqlite');
const db = new Database(dbPath);
db.exec("ATTACH '" + backupPath.replace(/'/g, "''") + "' AS bk");

const q =
  'INSERT INTO Deliveries SELECT * FROM bk.Deliveries ' +
  'WHERE date IN (' + dates.map(function () { return '?'; }).join(',') + ') ' +
  'AND id NOT IN (SELECT id FROM Deliveries)';
const info = db.prepare(q).run(...dates);
console.log('Восстановлено:', info.changes);
