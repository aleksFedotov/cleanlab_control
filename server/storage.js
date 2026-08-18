// Складские записи (таблица Storage) — порт src/Storage.gs.
// kind: dirty — грязное от водителя (без веса), clean — результат стирки (вес + позиции).
// Пустой consumed_at = запись на складе.
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_ } = require('./audit');
const { round1_ } = require('./core');

function addStorageEntry_(clientId, kind, opts) {
  opts = opts || {};
  const entry = {
    id: db.nextId_(SHEETS.STORAGE, 'st'), client_id: clientId, kind: kind,
    weight_kg: opts.weight_kg || '', items_total: opts.items_total || '',
    wash_id: opts.wash_id || '', created_at: nowStr_(), consumed_at: ''
  };
  db.appendRow_(SHEETS.STORAGE, entry);
  return entry;
}

// Открытые (не израсходованные) записи клиента по виду.
function openStorage_(clientId, kind) {
  return db.findRowsBy_(SHEETS.STORAGE, function (s) {
    return s.client_id === clientId && s.kind === kind && !s.consumed_at;
  }, 1000);
}

// Расходовать все открытые записи клиента данного вида.
function consumeStorage_(clientId, kind) {
  const rows = openStorage_(clientId, kind);
  rows.forEach(function (r) {
    r.obj.consumed_at = nowStr_();
    db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
  });
  return rows.length;
}

// Сводка по складу: clientId -> { dirty, clean, cleanKg, cleanItems }.
function storageSummaryByClient_() {
  const summary = {};
  db.findRowsBy_(SHEETS.STORAGE, function (s) { return !s.consumed_at; }, 2000)
    .forEach(function (r) {
      const s = r.obj;
      if (!summary[s.client_id]) summary[s.client_id] = { dirty: 0, clean: 0, cleanKg: 0, cleanItems: 0 };
      if (s.kind === 'dirty') summary[s.client_id].dirty++;
      if (s.kind === 'clean') {
        summary[s.client_id].clean++;
        summary[s.client_id].cleanKg = round1_((summary[s.client_id].cleanKg || 0) + (Number(s.weight_kg) || 0));
        summary[s.client_id].cleanItems += Number(s.items_total) || 0;
      }
    });
  return summary;
}

module.exports = { addStorageEntry_, openStorage_, consumeStorage_, storageSummaryByClient_ };
