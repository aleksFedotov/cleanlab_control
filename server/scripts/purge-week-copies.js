// Разовая очистка автокопий плана недели (week_copy) после отказа от автокопирования.
// Признак автокопии: created_at строки Deliveries совпадает с ts события week_copy
// в Log (копия создаёт все строки пачкой в одну секунду) — ручные визиты не задеваем.
// Чистим только planned со сегодняшнего дня и дальше; прошлое — история.
//
// Запуск:
//   node scripts/purge-week-copies.js          # dry-run: бэкап + список кандидатов
//   node scripts/purge-week-copies.js --apply  # удаление
// Путь к БД: DB_PATH из env, иначе server/data/cleanlab.sqlite.

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cleanlab.sqlite');
const apply = process.argv.includes('--apply');
const tz = process.env.APP_TZ || 'Europe/Moscow';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());

const SELECT =
  "SELECT d.id, d.date, d.client_id, d.laundry_id, d.created_at, c.name AS client_name " +
  'FROM Deliveries d LEFT JOIN Clients c ON c.id = d.client_id ' +
  "WHERE d.status = 'planned' AND d.date >= ? " +
  "AND d.created_at IN (SELECT ts FROM Log WHERE action = 'week_copy') " +
  'ORDER BY d.date, d.laundry_id, d.id';

async function main() {
  const db = new Database(dbPath);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = dbPath.replace(/\.sqlite$/, '') + '.backup-' + stamp + '.sqlite';
  await db.backup(backupPath);
  console.log('Бэкап: ' + backupPath);
  console.log('Порог даты (' + tz + '): ' + today + '\n');

  const rows = db.prepare(SELECT).all(today);
  if (!rows.length) {
    console.log('Кандидатов на удаление нет.');
    return;
  }

  let cur = '';
  const byLaundry = {};
  rows.forEach(function (r) {
    if (r.date !== cur) {
      cur = r.date;
      console.log(cur + ':');
    }
    console.log('  ' + r.id + '  [' + r.laundry_id + ']  ' + (r.client_name || r.client_id) +
      '  (created ' + r.created_at + ')');
    byLaundry[r.laundry_id] = (byLaundry[r.laundry_id] || 0) + 1;
  });
  console.log('\nИтого: ' + rows.length + ' визит(ов), по прачкам: ' +
    Object.keys(byLaundry).map(function (k) { return k + '=' + byLaundry[k]; }).join(', '));

  if (!apply) {
    console.log('\nDry-run. Для удаления запустите с флагом --apply');
    return;
  }
  const ids = rows.map(function (r) { return r.id; });
  const del = db.prepare("DELETE FROM Deliveries WHERE id = ? AND status = 'planned'");
  db.transaction(function () {
    ids.forEach(function (id) { del.run(id); });
  })();
  console.log('Удалено: ' + ids.length);
}

main().catch(function (e) {
  console.error(e.message || e);
  process.exit(1);
});
