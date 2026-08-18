// Визиты развоза (лист Deliveries). Визит = «водитель заезжает к клиенту в день D»,
// без привязки к состоянию белья. Статусы: planned → delivered | picked | both | empty,
// плюс cancelled.

var VISIT_FINAL = ['delivered', 'picked', 'both', 'empty'];

function isOpenVisit_(v) { return v.status === 'planned'; }

// Визиты на дату (без отменённых), по порядку ord.
function getVisitsByDate_(date) {
  return findRowsBy_(SHEETS.DELIVERIES, function (v) {
    return v.date === date && v.status !== 'cancelled';
  }, 1000).map(function (r) { return r.obj; })
    .sort(function (a, b) { return (Number(a.ord) || 0) - (Number(b.ord) || 0); });
}

// Визиты недели [monday .. monday+6], сгруппированные по дате.
function getVisitsByWeek_(monday) {
  var sun = addDaysStr_(monday, 6);
  return findRowsBy_(SHEETS.DELIVERIES, function (v) {
    return v.date >= monday && v.date <= sun && v.status !== 'cancelled';
  }, 2000).map(function (r) { return r.obj; });
}

// Визит + состояние склада клиента (есть чистое / есть грязное).
function decorateVisit_(v, clients, storage) {
  var s = storage[v.client_id] || { dirty: 0, clean: 0, cleanKg: 0, cleanItems: 0 };
  v.client_name = clientName_(v.client_id, clients);
  v.has_clean = s.clean > 0;
  v.has_dirty = s.dirty > 0;
  v.clean_kg = s.cleanKg;
  v.clean_items = s.cleanItems;
  return v;
}

// --- API (все записи под локом) ---

function getDeliveryVisits(token, date) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  date = date || todayStr_();
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var storage = storageSummaryByClient_();
  return ok_({
    date: date,
    visits: getVisitsByDate_(date).map(function (v) { return decorateVisit_(v, clients, storage); }),
    notReady: notReadyForDelivery_(date),
    clients: getClients_().filter(function (c) { return c.active === 'да'; })
  });
}

function addDeliveryVisit(token, clientId, date, ord) {
  var role = requireRole_(token, ['owner']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    // Не дублируем: один клиент — один открытый визит на дату
    var dup = getVisitsByDate_(date).some(function (v) { return v.client_id === clientId; });
    if (dup) return err_('Клиент уже в развозе на эту дату');
    var v = {
      id: nextId_(SHEETS.DELIVERIES, 'del'), date: date, client_id: clientId,
      ord: ord || (getVisitsByDate_(date).length + 1), status: 'planned',
      delivered_at: '', pickup: '', driver_comment: '',
      created_by: role, created_at: nowStr_()
    };
    appendRow_(SHEETS.DELIVERIES, v);
    logEvent(role, 'visit_create', v.id, { client_id: clientId, date: date });
    return ok_({ visit: v });
  });
}

function moveDeliveryVisit(token, visitId, newDate) {
  var role = requireRole_(token, ['owner']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.DELIVERIES, visitId);
    if (!found) return err_('Визит не найден');
    if (!isOpenVisit_(found.obj)) return err_('Можно переносить только запланированные визиты');
    var old = found.obj.date;
    found.obj.date = newDate;
    updateRow_(SHEETS.DELIVERIES, found.rowNumber, found.obj);
    logEvent(role, 'visit_move', visitId, { date: old + ' → ' + newDate });
    return ok_({ visit: found.obj });
  });
}

function removeDeliveryVisit(token, visitId) {
  var role = requireRole_(token, ['owner']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.DELIVERIES, visitId);
    if (!found) return err_('Визит не найден');
    if (!isOpenVisit_(found.obj)) return err_('Можно убирать только запланированные визиты');
    found.obj.status = 'cancelled';
    updateRow_(SHEETS.DELIVERIES, found.rowNumber, found.obj);
    logEvent(role, 'visit_cancel', visitId, {});
    return ok_({ visit: found.obj });
  });
}

// --- Водитель ---

// Груз водителя по ВСЕМ визитам (любая дата): чистое взятое, но не отданное;
// грязное забранное, но не сданное на склад. Мешки грязного не считаем — по точкам.
function driverCargo_() {
  var cargo = { clean_bags: 0, clean_points: 0, dirty_points: 0 };
  findRowsBy_(SHEETS.DELIVERIES, function (v) {
    return v.status !== 'cancelled' &&
      ((v.clean_taken_at && v.status !== 'delivered' && v.status !== 'both') ||
       (v.picked_at && !v.dirty_handed_at));
  }, 2000).forEach(function (r) {
    var v = r.obj;
    if (v.clean_taken_at && v.status !== 'delivered' && v.status !== 'both') {
      cargo.clean_points++;
      cargo.clean_bags += Number(v.clean_bags) || 0;
    }
    if (v.picked_at && !v.dirty_handed_at) cargo.dirty_points++;
  });
  return cargo;
}

// Точки на дату: визиты + состояние склада клиента + груз водителя.
function getDriverRoute(token, date) {
  if (!requireRole_(token, ['driver', 'owner'])) return err_('Нет доступа');
  date = date || todayStr_();
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var storage = storageSummaryByClient_();
  return ok_({
    date: date,
    laundryName: getSettings_().LAUNDRY_NAME || 'Прачка360',
    cargo: driverCargo_(),
    visits: getVisitsByDate_(date).map(function (v) {
      var c = clients[v.client_id] || {};
      v.address = c.address || '';
      return decorateVisit_(v, clients, storage);
    })
  });
}

// Действия водителя. Статус точки (status) и местонахождение белья — раздельно:
// take_clean    — чистое со склада к водителю (складские записи → consumed_at='driver');
// deliver_clean — чистое отдано клиенту (стирки → issued, точка → delivered/both);
// pickup_dirty  — грязное забрано к водителю (точка → picked/both, склад НЕ трогаем);
// empty         — на точке ничего нет (только если чистое не взято).
// Чистое со склада → водителю по конкретному визиту.
// Возвращает кол-во мешков или null, если чистого на складе нет.
// Мутирует v (clean_taken_at, clean_bags) — запись визита на диске делает вызывающий.
function takeCleanForVisit_(v) {
  var clean = openStorage_(v.client_id, 'clean');
  if (!clean.length) return null;
  var bags = 0;
  clean.forEach(function (r) {
    // Мешки хранятся на стирке, а не на складской записи
    if (r.obj.wash_id) {
      var w = findById_(SHEETS.WASHES, r.obj.wash_id);
      if (w) bags += Number(w.obj.bags) || 0;
    }
    r.obj.consumed_at = 'driver'; // маркер «у водителя»: склад его больше не показывает
    updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
  });
  v.clean_taken_at = nowStr_();
  v.clean_bags = bags;
  return bags;
}

// Массово: взять чистое по всем открытым точкам дня, где оно есть на складе.
function driverTakeAllClean(token, date) {
  var role = requireRole_(token, ['driver', 'owner']);
  if (!role) return err_('Нет доступа');
  date = date || todayStr_();
  return withLock_(function () {
    var taken = 0, bags = 0;
    findRowsBy_(SHEETS.DELIVERIES, function (v) {
      return v.date === date && v.status === 'planned' && !v.clean_taken_at;
    }, 1000).forEach(function (r) {
      var b = takeCleanForVisit_(r.obj);
      if (b === null) return; // чистого нет — точку пропускаем
      updateRow_(SHEETS.DELIVERIES, r.rowNumber, r.obj);
      taken++;
      bags += b;
    });
    logEvent(role, 'take_all_clean', date, { points: taken, bags: bags });
    return ok_({ taken: taken, bags: bags });
  });
}

function driverAction(token, visitId, action) {
  var role = requireRole_(token, ['driver', 'owner']);
  if (!role) return err_('Нет доступа');
  var ACTIONS = ['take_clean', 'deliver_clean', 'pickup_dirty', 'empty'];
  if (ACTIONS.indexOf(action) === -1) return err_('Неизвестное действие');
  return withLock_(function () {
    var found = findById_(SHEETS.DELIVERIES, visitId);
    if (!found) return err_('Визит не найден');
    var v = found.obj;
    if (VISIT_FINAL.indexOf(v.status) !== -1) return err_('Визит уже закрыт');

    if (action === 'take_clean') {
      if (v.clean_taken_at) return err_('Чистое уже взято');
      if (takeCleanForVisit_(v) === null) return err_('Чистого белья на складе нет');
    }

    if (action === 'deliver_clean') {
      if (!v.clean_taken_at) return err_('Сначала возьмите чистое на складе');
      // Стирки, чьё чистое уехало к клиенту, помечаются выданными
      findRowsBy_(SHEETS.STORAGE, function (s) {
        return s.client_id === v.client_id && s.kind === 'clean' && s.consumed_at === 'driver';
      }, 500).forEach(function (r) {
        r.obj.consumed_at = nowStr_();
        updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
        if (r.obj.wash_id) {
          var w = findById_(SHEETS.WASHES, r.obj.wash_id);
          if (w && (w.obj.status === 'done' || w.obj.status === 'stored')) {
            w.obj.status = 'issued';
            w.obj.issued_at = nowStr_();
            updateRow_(SHEETS.WASHES, w.rowNumber, w.obj);
          }
        }
      });
      v.status = v.picked_at ? 'both' : 'delivered';
      v.delivered_at = nowStr_();
    }

    if (action === 'pickup_dirty') {
      if (v.picked_at) return err_('Грязное уже забрано');
      v.picked_at = nowStr_();
      v.pickup = 'да';
      // Если чистое уже отдано (или его не было и не взято) — точка закрыта
      if (v.delivered_at) v.status = 'both';
      else if (!v.clean_taken_at) v.status = 'picked';
      // иначе: чистое у водителя, точка остаётся открытой до «Отдал чистое»
    }

    if (action === 'empty') {
      if (v.clean_taken_at) return err_('Чистое уже взято — отвезите его клиенту');
      v.status = 'empty';
      v.delivered_at = nowStr_();
    }

    updateRow_(SHEETS.DELIVERIES, found.rowNumber, v);
    logEvent(role, 'visit_' + action, visitId, { client_id: v.client_id, date: v.date });
    return ok_({ visit: v, cargo: driverCargo_() });
  });
}

// «Передать грязное на склад»: всё забранное грязное уезжает на склад разом.
function driverHandover(token) {
  var role = requireRole_(token, ['driver', 'owner']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var rows = findRowsBy_(SHEETS.DELIVERIES, function (v) {
      return v.status !== 'cancelled' && v.picked_at && !v.dirty_handed_at;
    }, 1000);
    rows.forEach(function (r) {
      addStorageEntry_(r.obj.client_id, 'dirty', {});
      r.obj.dirty_handed_at = nowStr_();
      updateRow_(SHEETS.DELIVERIES, r.rowNumber, r.obj);
    });
    if (rows.length) logEvent(role, 'visit_handover', '-', { visits: rows.length });
    return ok_({ handed: rows.length, cargo: driverCargo_() });
  });
}

// --- Одноразовая миграция (запуск вручную из редактора GAS) ---

// До смены модели «Неделя» хранила карточки как стирки (Washes), теперь это
// визиты развоза (Deliveries). Переносим: дата визита = issue_date стирки
// (день выдачи), дедуп по клиент+дата, отменённые стирки пропускаем.
function migrateWashesToVisits() {
  return withLock_(function () {
    var existing = {};
    readTail_(SHEETS.DELIVERIES, 5000).forEach(function (v) {
      existing[v.client_id + '|' + v.date] = true;
    });
    var created = 0;
    readTail_(SHEETS.WASHES, 5000).forEach(function (w) {
      if (w.status === 'cancelled') return;
      var date = w.issue_date || w.wash_date;
      var key = w.client_id + '|' + date;
      if (!w.client_id || !date || existing[key]) return;
      existing[key] = true;
      appendRow_(SHEETS.DELIVERIES, {
        id: nextId_(SHEETS.DELIVERIES, 'del'), date: date, client_id: w.client_id,
        ord: 0, status: 'planned',
        delivered_at: '', pickup: '', driver_comment: '',
        created_by: 'migration', created_at: nowStr_()
      });
      created++;
    });
    if (created) logEvent('owner', 'migrate_visits', '-', { created: created });
    Logger.log('migrateWashesToVisits: создано визитов ' + created);
    return created;
  });
}
