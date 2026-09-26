// Заявки клиентского портала (тикет P1, этап 2): клиент заявляет сдачу белья
// на дату, владелец видит список и привязывает заявку к визиту развоза.
// Одна активная (status='sent') заявка на клиента+дату: повторная отправка
// переписывает состав. После забора водителем (driverAction, deliveries.js)
// заявка уходит в 'picked' и правке не подлежит.
const db = require('../db');
const { SHEETS } = require('../schema');
const { nowStr_, logEvent, actorOf_ } = require('../audit');
const { err_, ok_, findTenantRow_ } = require('../core');

const REQ_SENT = 'sent';
const REQ_PICKED = 'picked';

function dateOk_(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function itemsOf_(requestId) {
  return db.findRowsBy_(SHEETS.REQUEST_ITEMS, function (ri) { return ri.request_id === requestId; }, 1000)
    .map(function (r) { return r.obj; });
}

function withItems_(request) {
  return Object.assign({}, request, { items: itemsOf_(request.id) });
}

// Позиции заявки переписываются целиком (паттерн editWashData, wash.js):
// старые удаляются снизу вверх, новые пишутся с фильтром qty>0.
function rewriteItems_(requestId, items) {
  const oldItems = db.findRowsBy_(SHEETS.REQUEST_ITEMS, function (ri) { return ri.request_id === requestId; }, 1000);
  oldItems.sort(function (a, b) { return b.rowNumber - a.rowNumber; })
    .forEach(function (r) { db.deleteRow_(SHEETS.REQUEST_ITEMS, r.rowNumber); });
  (items || []).filter(function (it) { return Number(it.qty) > 0; }).forEach(function (it) {
    db.appendRow_(SHEETS.REQUEST_ITEMS, {
      id: db.nextId_(SHEETS.REQUEST_ITEMS, 'ri'),
      request_id: requestId,
      item_type_id: String(it.item_type_id),
      qty: Math.floor(Number(it.qty))
    });
  });
}

// --- Клиент ---

// Создание заявки / перезапись активной на ту же дату. Ключ уникальности —
// (client_id, desired_date): нашли 'sent' — переписали, нашли другой статус —
// отказ («уже в работе»), не нашли — создали.
function clientCreateRequest(session, desiredDate, bags, comment, items) {
  const laundryId = session.laundryId;
  const clientId = String(session.clientId || '');
  if (!clientId) return err_('Аккаунт не привязан к клиенту');
  if (!dateOk_(desiredDate)) return err_('Укажите дату забора');
  const bagsN = Math.max(0, Math.floor(Number(bags) || 0));
  return db.transaction_(function () {
    const existing = db.findRowsByTenant_(SHEETS.REQUESTS, function (r) {
      return r.client_id === clientId && r.desired_date === desiredDate;
    }, 1, laundryId)[0] || null;
    if (existing && existing.obj.status !== REQ_SENT) {
      return err_('Заявка уже в работе, правка недоступна');
    }
    const actor = actorOf_(session);
    if (existing) {
      const req = existing.obj;
      req.bags = String(bagsN);
      req.comment = String(comment || '');
      req.updated_at = nowStr_();
      db.updateRow_(SHEETS.REQUESTS, existing.rowNumber, req);
      rewriteItems_(req.id, items);
      logEvent(actor, 'request_update', req.id, { client_id: clientId, date: desiredDate }, laundryId);
      return ok_({ request: withItems_(req) });
    }
    const req = {
      id: db.nextId_(SHEETS.REQUESTS, 'req'),
      client_id: clientId,
      laundry_id: String(laundryId),
      visit_id: '',
      desired_date: desiredDate,
      bags: String(bagsN),
      comment: String(comment || ''),
      status: REQ_SENT,
      created_by: session.name,
      created_at: nowStr_(),
      updated_at: nowStr_()
    };
    db.appendRow_(SHEETS.REQUESTS, req);
    rewriteItems_(req.id, items);
    logEvent(actor, 'request_create', req.id, { client_id: clientId, date: desiredDate }, laundryId);
    return ok_({ request: withItems_(req) });
  });
}

// Заявки клиента (портал): с позициями, новые сверху.
function clientGetRequests(session) {
  const clientId = String(session.clientId || '');
  if (!clientId) return err_('Аккаунт не привязан к клиенту');
  const requests = db.findRowsByTenant_(SHEETS.REQUESTS, function (r) {
    return r.client_id === clientId;
  }, 1000, session.laundryId).map(function (r) { return withItems_(r.obj); });
  requests.sort(function (a, b) {
    return a.desired_date < b.desired_date ? 1 : a.desired_date > b.desired_date ? -1 : 0;
  });
  return ok_({ requests: requests });
}

// Одна заявка клиента: чужая (другой client_id/прачка) — «не существует».
function clientGetRequest(session, requestId) {
  const found = findTenantRow_(SHEETS.REQUESTS, requestId, session.laundryId);
  if (!found || String(found.obj.client_id) !== String(session.clientId)) {
    return err_('Заявка не существует');
  }
  return ok_({ request: withItems_(found.obj) });
}

// --- Владелец ---

// Все заявки прачки (бейдж и экран, этап 5). date — опциональный фильтр.
// sentCount — число активных для бейжа. Клиентам подставляем имя.
function getClientRequests(session, date) {
  const laundryId = session.laundryId;
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const requests = db.findRowsByTenant_(SHEETS.REQUESTS, function (r) {
    return !date || r.desired_date === date;
  }, 2000, laundryId).map(function (r) {
    const req = withItems_(r.obj);
    req.client_name = clients[req.client_id] ? clients[req.client_id].name : req.client_id;
    return req;
  });
  requests.sort(function (a, b) {
    if (a.desired_date !== b.desired_date) return a.desired_date < b.desired_date ? -1 : 1;
    return String(a.created_at) < String(b.created_at) ? -1 : 1;
  });
  return ok_({
    requests: requests,
    sentCount: requests.filter(function (r) { return r.status === REQ_SENT; }).length
  });
}

// Привязка заявки к визиту развоза (этап 5): визит того же клиента и прачки.
function linkRequestToVisit(session, requestId, visitId) {
  const laundryId = session.laundryId;
  const found = findTenantRow_(SHEETS.REQUESTS, requestId, laundryId);
  if (!found) return err_('Заявка не существует');
  const visit = db.findById_(SHEETS.DELIVERIES, visitId);
  if (!visit || visit.obj.laundry_id !== String(laundryId)) return err_('Визит не найден');
  if (String(visit.obj.client_id) !== String(found.obj.client_id)) return err_('Визит другого клиента');
  const req = found.obj;
  req.visit_id = String(visitId);
  req.updated_at = nowStr_();
  db.updateRow_(SHEETS.REQUESTS, found.rowNumber, req);
  logEvent(actorOf_(session), 'request_link', req.id, { visit_id: String(visitId) }, laundryId);
  return ok_({ request: withItems_(req) });
}

// --- Интеграция с водителем ---

// «Забрал грязное» по визиту с привязанной заявкой: заявка уходит в 'picked'.
// Вызывается из driverAction внутри его транзакции (deliveries.js).
function markRequestsPickedForVisit_(visitId, laundryId) {
  db.findRowsByTenant_(SHEETS.REQUESTS, function (r) {
    return r.visit_id === String(visitId) && r.status === REQ_SENT;
  }, 100, laundryId).forEach(function (row) {
    row.obj.status = REQ_PICKED;
    row.obj.updated_at = nowStr_();
    db.updateRow_(SHEETS.REQUESTS, row.rowNumber, row.obj);
  });
}

module.exports = {
  clientCreateRequest, clientGetRequests, clientGetRequest,
  getClientRequests, linkRequestToVisit,
  markRequestsPickedForVisit_
};
