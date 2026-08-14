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

// Маршрут на дату: визиты по ord + состояние склада клиента.
function getDriverRoute(token, date) {
  if (!requireRole_(token, ['driver', 'owner'])) return err_('Нет доступа');
  date = date || todayStr_();
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var storage = storageSummaryByClient_();
  return ok_({
    date: date,
    laundryName: getSettings_().LAUNDRY_NAME || 'Прачка360',
    visits: getVisitsByDate_(date).map(function (v) {
      var c = clients[v.client_id] || {};
      v.address = c.address || '';
      return decorateVisit_(v, clients, storage);
    })
  });
}

// Действие водителя у клиента: deliver (выдал чистое), pickup (забрал грязное),
// both, empty (черновой статус «ничего нет» — открытый вопрос спеки).
// Вес/количество водитель НЕ записывает.
function driverVisit(token, visitId, action) {
  var role = requireRole_(token, ['driver', 'owner']);
  if (!role) return err_('Нет доступа');
  var ACTIONS = { deliver: 'delivered', pickup: 'picked', both: 'both', empty: 'empty' };
  if (!ACTIONS[action]) return err_('Неизвестное действие');
  return withLock_(function () {
    var found = findById_(SHEETS.DELIVERIES, visitId);
    if (!found) return err_('Визит не найден');
    if (!isOpenVisit_(found.obj)) return err_('Визит уже закрыт');
    var v = found.obj;
    if (action === 'deliver' || action === 'both') {
      // Чистое уходит со склада; связанные стирки помечаются выданными
      openStorage_(v.client_id, 'clean').forEach(function (r) {
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
    }
    if (action === 'pickup' || action === 'both') {
      addStorageEntry_(v.client_id, 'dirty', {});
      v.pickup = 'да';
    }
    v.status = ACTIONS[action];
    v.delivered_at = nowStr_();
    updateRow_(SHEETS.DELIVERIES, found.rowNumber, v);
    logEvent(role, 'visit_' + action, visitId, { client_id: v.client_id, date: v.date });
    return ok_({ visit: v });
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
