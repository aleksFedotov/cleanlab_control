// Заявки клиентского портала (тикет P1, этап 2): клиент заявляет сдачу белья
// на дату, владелец видит список и привязывает заявку к визиту развоза.
// Одна активная (status='sent') заявка на клиента+дату: повторная отправка
// переписывает состав. После забора водителем (driverAction, deliveries.js)
// заявка уходит в 'picked' и правке не подлежит.
const db = require('../db');
const { SHEETS } = require('../schema');
const { nowStr_, todayStr_, logEvent, actorOf_ } = require('../audit');
const { err_, ok_, findTenantRow_, addDaysStr_ } = require('../core');

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
  if (desiredDate < todayStr_()) return err_('На прошедшую дату заявку отправить нельзя');
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

// Стартовые данные портала (этап 3): профиль клиента, активные виды белья и
// ближайшие запланированные визиты (предвыбор даты забора в форме заявки).
function clientGetPortalData(session) {
  const laundryId = session.laundryId;
  const clientId = String(session.clientId || '');
  if (!clientId) return err_('Аккаунт не привязан к клиенту');
  const client = db.getClients_(laundryId).filter(function (c) {
    return String(c.id) === clientId;
  })[0] || null;
  if (!client) return err_('Клиент не найден');
  const today = todayStr_();
  const visits = db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return String(v.client_id) === clientId && v.status === 'planned' && v.date >= today;
  }, 50, laundryId).map(function (r) { return r.obj; });
  visits.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return Number(a.ord) - Number(b.ord);
  });
  return ok_({
    client: {
      id: client.id, name: client.name,
      item_types: client.item_types || '', accounting: client.accounting || ''
    },
    itemTypes: db.getItemTypes_().filter(function (t) { return t.active === 'да'; }),
    visits: visits.slice(0, 10)
  });
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

// Заявки прачки для маршрута/развоза: мешки и позиции с именами видов белья.
// byVisit — по привязке Requests.visit_id; byClientDate — 'sent'-заявки по
// (client_id, desired_date) — fallback для визитов, созданных вручную без
// привязки (водитель всё равно должен видеть, сколько забрать).
function requestsForVisits_(laundryId) {
  const typeNames = {};
  db.getItemTypes_().forEach(function (t) { typeNames[String(t.id)] = t.name; });
  const itemsByReq = {};
  db.findRowsBy_(SHEETS.REQUEST_ITEMS, function () { return true; }, 5000)
    .forEach(function (r) {
      const ri = r.obj;
      if (Number(ri.qty) <= 0) return;
      (itemsByReq[ri.request_id] = itemsByReq[ri.request_id] || []).push({
        name: typeNames[String(ri.item_type_id)] || ri.item_type_id,
        qty: Number(ri.qty)
      });
    });
  const byVisit = {};
  const byClientDate = {};
  db.findRowsByTenant_(SHEETS.REQUESTS, function () { return true; }, 5000, laundryId)
    .forEach(function (r) {
      const req = r.obj;
      const info = {
        id: req.id,
        bags: Number(req.bags) || 0,
        comment: String(req.comment || ''),
        items: itemsByReq[req.id] || []
      };
      if (req.visit_id) byVisit[String(req.visit_id)] = info;
      if (req.status === REQ_SENT) {
        byClientDate[String(req.client_id) + '|' + req.desired_date] = info;
      }
    });
  return { byVisit: byVisit, byClientDate: byClientDate };
}

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

// --- Трекинг сдачи (этап 4) ---

// Порядок клиентских шагов трека (ключи совпадают с clientStatus_).
const TRACK_STEPS = [
  { key: 'accepted', label: 'Заявка принята' },
  { key: 'driver_coming', label: 'Водитель направляется' },
  { key: 'to_laundry', label: 'На пути в прачечную' },
  { key: 'in_queue', label: 'В прачечной, в очереди' },
  { key: 'washing', label: 'Стирается' },
  { key: 'ready', label: 'Готово, на складе' },
  { key: 'to_client', label: 'Направляется к вам' },
  { key: 'delivered', label: 'Доставлено' }
];
const STEP_INDEX = {};
TRACK_STEPS.forEach(function (s, i) { STEP_INDEX[s.key] = i; });

// Чистый маппинг «внутреннее состояние → клиентский статус» (тикет P1, этап 4).
// Без I/O — тестируется таблично. Визита может не быть (двойной канал): тогда
// поздние шаги просто не наступают и трек остаётся на «Заявка принята».
// visit — визит забора (Requests.visit_id); deliveryVisit — визит, которым чистое
// поехало к клиенту (обычно следующий день; может совпадать с визитом забора).
function clientStatus_(input) {
  const request = input.request || {};
  const visit = input.visit || null;
  const deliveryVisit = input.deliveryVisit || null;
  const wash = input.wash || null;
  const today = input.today || todayStr_();

  // Особые случаи — терминальные, показываем честными формулировками
  if (wash && wash.status === 'cancelled') {
    return { key: 'cancelled', label: 'Сдача отменена', note: String(wash.comment || ''), step: -1 };
  }
  if (wash && wash.status === 'no_linen') {
    return { key: 'no_linen', label: 'Бельё не передано', note: '', step: -1 };
  }

  let key;
  if ((deliveryVisit && (deliveryVisit.status === 'delivered' || deliveryVisit.status === 'both'))
      || (wash && wash.status === 'issued')) {
    key = 'delivered';
  } else if (deliveryVisit && deliveryVisit.clean_taken_at) {
    key = 'to_client';
  } else if (wash && wash.status === 'in_progress') {
    key = 'washing';
  } else if (wash && wash.status === 'partial') {
    key = 'washing'; // «Стирается (частично)»: клиенту важно, что часть останется
  } else if (wash && (wash.status === 'done' || wash.status === 'stored' || wash.status === 'ready_clean')) {
    key = 'ready';
  } else if (wash && wash.status === 'planned') {
    key = 'in_queue';
  } else if (input.dirtyAt) {
    key = 'in_queue'; // грязное на складе прачки, стирка ещё не заведена
  } else if (visit && visit.picked_at) {
    key = 'to_laundry';
  } else if (visit && visit.status === 'planned' && visit.date === today) {
    key = 'driver_coming';
  } else {
    key = 'accepted';
  }

  const note = wash && wash.deferred_from
    ? 'перенесено на ' + (wash.issue_date || '—')
    : '';
  return { key: key, label: labelFor_(key, wash), note: note, step: STEP_INDEX[key] };
}

function labelFor_(key, wash) {
  if (key === 'washing' && wash && wash.status === 'partial') return 'Стирается (частично)';
  const s = TRACK_STEPS.filter(function (x) { return x.key === key; })[0];
  return s ? s.label : key;
}

// Дата-время события по шагу (пустая строка — событие ещё не случилось).
// Визит выдачи (deliveryVisit) — источник дат шагов «Направляется»/«Доставлено».
function stepAt_(key, request, visit, deliveryVisit, wash) {
  switch (key) {
    case 'accepted': return String(request.created_at || '');
    case 'to_laundry': return visit ? String(visit.picked_at || '') : '';
    case 'in_queue': return wash ? String(wash.created_at || '') : '';
    case 'washing': return wash ? String(wash.started_at || '') : '';
    case 'ready': return wash ? String(wash.done_at || '') : '';
    case 'to_client': return deliveryVisit ? String(deliveryVisit.clean_taken_at || '') : '';
    case 'delivered':
      return (deliveryVisit && String(deliveryVisit.delivered_at || '')) || (wash ? String(wash.issued_at || '') : '');
    default: return ''; // driver_coming — событие впереди, дата визита не таймстемп
  }
}

// Трек заявки: клиентский статус, шаги с датами, фактический пересчёт (если стирка
// завершена). Связка заявка → визит (visit_id) → стирка клиента на дату визита
// (окно [дата−1, дата]: auto-стирка ensureWashesFromDelivery_ сидится на дату
// забора, ручная/демо — в день визита). Чужая заявка — «не существует».
function clientGetTrack(session, requestId) {
  const laundryId = session.laundryId;
  const found = findTenantRow_(SHEETS.REQUESTS, requestId, laundryId);
  if (!found || String(found.obj.client_id) !== String(session.clientId)) {
    return err_('Заявка не существует');
  }
  const request = withItems_(found.obj);
  const today = todayStr_();

  const visit = request.visit_id
    ? (function () {
        const v = db.findById_(SHEETS.DELIVERIES, request.visit_id);
        return v && v.obj.laundry_id === String(laundryId) ? v.obj : null;
      })()
    : null;

  // Стирка клиента: последняя (по дате) не отменённая в окне [visit.date−1, visit.date]
  let wash = null;
  if (visit) {
    const from = addDaysStr_(visit.date, -1);
    const candidates = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
      return String(w.client_id) === String(request.client_id)
        && w.wash_date >= from && w.wash_date <= visit.date
        && w.status !== 'cancelled';
    }, 100, laundryId).map(function (r) { return r.obj; });
    candidates.sort(function (a, b) {
      if (a.wash_date !== b.wash_date) return a.wash_date < b.wash_date ? 1 : -1;
      return String(a.created_at) < String(b.created_at) ? 1 : -1;
    });
    wash = candidates[0] || null;
  }

  // Открытая dirty-запись склада (грязное уже в прачке, стирка не заведена)
  let dirtyAt = '';
  if (visit && !wash) {
    const dirty = db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
      return String(s.client_id) === String(request.client_id)
        && s.kind === 'dirty' && !s.consumed_at && String(s.created_at) >= visit.date;
    }, 1, laundryId)[0];
    dirtyAt = dirty ? String(dirty.obj.created_at || '') : '';
  }

  // Визит выдачи чистого: ближайший к дате забора визит клиента, которым чистое
  // поехало (clean_taken_at или финальный «доставлен»). Обычно это визит D+1 —
  // он же порождает стирку (ensureWashesFromDelivery_); может совпадать с визитом
  // забора, если обе операции прошли одним рейсом (both).
  let deliveryVisit = null;
  if (visit) {
    db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
      return String(v.client_id) === String(request.client_id)
        && v.date >= visit.date && v.status !== 'cancelled'
        && (v.clean_taken_at || v.status === 'delivered' || v.status === 'both');
    }, 50, laundryId).forEach(function (r) {
      if (!deliveryVisit || r.obj.date < deliveryVisit.date) deliveryVisit = r.obj;
    });
  }

  const status = clientStatus_({ request: request, visit: visit, deliveryVisit: deliveryVisit, wash: wash, dirtyAt: dirtyAt, today: today });
  const steps = TRACK_STEPS.map(function (s, i) {
    const at = stepAt_(s.key, request, visit, deliveryVisit, wash);
    // Пройденные — заполнены: всё до текущего шага; у особых статусов
    // (no_linen/cancelled, step=-1) — только шаги с фактическими датами
    const done = status.step >= 0 ? i <= status.step : (i === 0 || at !== '');
    return { key: s.key, label: labelFor_(s.key, wash), at: at, done: done, current: status.step === i };
  });

  // Фактический пересчёт — только после завершения стирки (done-like/partial/issued)
  let fact = null;
  if (wash && ['done', 'stored', 'ready_clean', 'issued', 'partial'].indexOf(wash.status) !== -1) {
    const names = {};
    db.getItemTypes_().forEach(function (t) { names[t.id] = t.name; });
    fact = {
      items: db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return wi.wash_id === wash.id; }, 1000)
        .map(function (r) {
          return { item_type_id: r.obj.item_type_id, name: names[r.obj.item_type_id] || r.obj.item_type_id, qty: Number(r.obj.qty) || 0 };
        }),
      weight_kg: Number(wash.dirty_weight_kg) || null,
      bags: Number(wash.bags) || null
    };
  }

  return ok_({ request: request, visit: visit, deliveryVisit: deliveryVisit, status: status, steps: steps, fact: fact });
}

module.exports = {
  clientCreateRequest, clientGetRequests, clientGetRequest, clientGetPortalData,
  getClientRequests, linkRequestToVisit,
  markRequestsPickedForVisit_, requestsForVisits_,
  clientGetTrack, clientStatus_
};
