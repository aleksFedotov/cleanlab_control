// Складские записи (таблица Storage) — порт src/Storage.gs.
// kind: dirty — грязное от водителя (без веса), clean — результат стирки (вес + позиции).
// Пустой consumed_at = запись на складе.
// laundryId обязателен: записи и выборки всегда в рамках одной прачки.
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_ } = require('./audit');
const { round1_ } = require('./core');

function addStorageEntry_(clientId, kind, opts, laundryId) {
  opts = opts || {};
  const entry = {
    id: db.nextId_(SHEETS.STORAGE, 'st'), client_id: clientId, kind: kind,
    weight_kg: opts.weight_kg || '', items_total: opts.items_total || '',
    wash_id: opts.wash_id || '', created_at: nowStr_(), consumed_at: ''
  };
  db.appendRowTenant_(SHEETS.STORAGE, entry, laundryId);
  return entry;
}

// Открытые (не израсходованные) записи клиента по виду.
// client_id глобально уникален, но фильтр по прачке — дополнительная страховка.
function openStorage_(clientId, kind, laundryId) {
  return db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
    return s.client_id === clientId && s.kind === kind && !s.consumed_at;
  }, 1000, laundryId);
}

// Расходовать все открытые записи клиента данного вида.
function consumeStorage_(clientId, kind, laundryId) {
  const rows = openStorage_(clientId, kind, laundryId);
  rows.forEach(function (r) {
    r.obj.consumed_at = nowStr_();
    db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
  });
  return rows.length;
}

// Сводка по складу прачки: clientId -> { dirty, clean, cleanKg, cleanItems, cleanBags }.
// cleanBags — сумма мешков по стиркам чистых записей (мешки хранятся на стирке).
function storageSummaryByClient_(laundryId) {
  const washBags = {};
  db.findRowsByTenant_(SHEETS.WASHES, function () { return true; }, 2000, laundryId)
    .forEach(function (r) { washBags[r.obj.id] = Number(r.obj.bags) || 0; });
  const summary = {};
  db.findRowsByTenant_(SHEETS.STORAGE, function (s) { return !s.consumed_at; }, 2000, laundryId)
    .forEach(function (r) {
      const s = r.obj;
      if (!summary[s.client_id]) summary[s.client_id] = { dirty: 0, clean: 0, cleanKg: 0, cleanItems: 0, cleanBags: 0 };
      if (s.kind === 'dirty') summary[s.client_id].dirty++;
      if (s.kind === 'clean') {
        summary[s.client_id].clean++;
        summary[s.client_id].cleanKg = round1_((summary[s.client_id].cleanKg || 0) + (Number(s.weight_kg) || 0));
        summary[s.client_id].cleanItems += Number(s.items_total) || 0;
        summary[s.client_id].cleanBags += washBags[s.wash_id] || 0;
      }
    });
  return summary;
}

module.exports = { addStorageEntry_, openStorage_, consumeStorage_, storageSummaryByClient_ };
