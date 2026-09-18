// Визиты развоза (R5): листовой модуль выборок и создания визитов.
// Выделен из deliveries.js, чтобы разорвать край wash → deliveries: wash читает
// визиты напрямую из этого листа, ничего не зная о развозе (deliveries).
// Зависимости — только листовые: schema, db, audit.
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, logEvent } = require('./audit');

function isOpenVisit_(v) { return v.status === 'planned'; }

// Визиты на дату (без отменённых), по порядку ord.
function getVisitsByDate_(date, laundryId) {
  return db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return v.date === date && v.status !== 'cancelled';
  }, 1000, laundryId).map(function (r) { return r.obj; })
    .sort(function (a, b) { return (Number(a.ord) || 0) - (Number(b.ord) || 0); });
}

// Автовизит: создать planned-визит клиента на дату, если его ещё нет (без дублей,
// без ошибки). Вызывается из updateIssueDate — чистое с новой датой выдачи должно
// появиться в плане/развозе на этот день.
function ensureVisit_(clientId, date, laundryId, actor) {
  const visits = getVisitsByDate_(date, laundryId);
  if (visits.some(function (v) { return v.client_id === clientId; })) return null;
  const v = {
    id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: date, client_id: clientId,
    ord: visits.length + 1, status: 'planned',
    delivered_at: '', pickup: '', driver_comment: '',
    created_by: actor || 'auto', created_at: nowStr_()
  };
  db.appendRowTenant_(SHEETS.DELIVERIES, v, laundryId);
  logEvent(actor || 'auto', 'visit_create', v.id, { client_id: clientId, date: date, auto: true }, laundryId);
  return v;
}

module.exports = { isOpenVisit_, getVisitsByDate_, ensureVisit_ };
