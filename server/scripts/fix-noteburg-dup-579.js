// Разовый фикс прода, инцидент 30.09.2026 («Нотебург», cli_5):
// wash_562 (ручная, 28.09, 33 кг/64 шт) — реальная стирка; wash_579 (авто-дубликат
// из развоза, 29.09) работник «постирал» повторно за 16 секунд, чтобы закрыть смену.
// Обе ушли в issued → счёт посчитал бы ~66 кг вместо 33. Скрипт удаляет дубль
// и его связанные строки (WashItems, Storage) — счёт строится от живых строк
// Washes и пересчитается автоматически.
//
// deleteWash issued-стирки не удаляет (факт выдачи), поэтому здесь ручное
// удаление по той же схеме (снизу вверх по rowNumber). Визиты развоза не трогаем:
// выдача была реальной — бельё клиент получил по wash_562.
//
// Запуск:  node scripts/fix-noteburg-dup-579.js [washId]
// Перед запуском на проде — бэкап cleanlab.sqlite.
// Идемпотентно: если стирки нет, скрипт просто сообщает об этом.

const db = require('../db');
const { SHEETS } = require('../schema');
const { logEvent } = require('../audit');

const WASH_ID = process.argv[2] || 'wash_579';
const EXPECT_CLIENT = 'cli_5';

db.open();

const found = db.findById_(SHEETS.WASHES, WASH_ID);
if (!found) {
  console.log('Стирка ' + WASH_ID + ' не найдена — удалять нечего.');
  process.exit(0);
}
const w = found.obj;
console.log('Найдена: ' + w.id + ' — клиент ' + w.client_id + ', ' + w.wash_date +
  ', статус ' + w.status + ', ' + w.dirty_weight_kg + ' кг, ' + w.items_total + ' шт.');

if (w.client_id !== EXPECT_CLIENT) {
  console.error('ОТМЕНА: ожидался клиент ' + EXPECT_CLIENT + ' (Нотебург), у стирки — ' + w.client_id);
  process.exit(1);
}
if (w.status !== 'issued') {
  console.error('ОТМЕНА: ожидался статус issued, у стирки — ' + w.status +
    '. Для невыданных используйте deleteWash в UI.');
  process.exit(1);
}

const result = db.transaction_(function () {
  const removed = {};
  [SHEETS.WASH_ITEMS, SHEETS.STORAGE].forEach(function (sheet) {
    const rows = db.findRowsBy_(sheet, function (r) { return r.wash_id === WASH_ID; }, 1000)
      .sort(function (a, b) { return b.rowNumber - a.rowNumber; });
    rows.forEach(function (r) { db.deleteRow_(sheet, r.rowNumber); });
    removed[sheet] = rows.length;
  });
  db.deleteRow_(SHEETS.WASHES, found.rowNumber);
  logEvent('fix-script', 'wash_delete_fix', WASH_ID, {
    client_id: w.client_id, wash_date: w.wash_date, status: w.status,
    kg: w.dirty_weight_kg, items_total: w.items_total,
    reason: 'дубль wash_562 (инцидент 30.09.2026: повторная «стирка» авто-карточки)',
    removed: removed
  }, w.laundry_id);
  return removed;
});

console.log('Удалено: стирка ' + WASH_ID + ', WashItems: ' + result[SHEETS.WASH_ITEMS] +
  ', Storage: ' + result[SHEETS.STORAGE] + '. Записано в Log (wash_delete_fix).');
console.log('Счёт «Нотебурга» за сентябрь пересчитается сам: осталась одна стирка 33 кг / 64 шт (wash_562).');
