// Серверное API (spec §6). Каждая функция принимает токен первым параметром.
// Все записи — под LockService; перед переходом статус перечитывается;
// много-листовые записи атомарны под одним локом.

function err_(m) { return { ok: false, error: m }; }
function ok_(data) { data = data || {}; data.ok = true; return data; }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function round1_(n) { return Math.round(Number(n) * 10) / 10; }

function timeStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm');
}

// Смена создаётся автоматически при первом действии (upsert по дате, spec §3.7).
function ensureShift_(date) {
  var found = findRowsBy_(SHEETS.SHIFTS, function (s) { return s.date === date; }, 500);
  if (found.length) return found[found.length - 1].obj;
  var shift = {
    id: nextId_(SHEETS.SHIFTS, 'shift'), date: date, status: 'open',
    opened_at: nowStr_(), closed_at: '', total_kg: '', washes_done: '',
    washes_deferred: '', digest_sent: ''
  };
  appendRow_(SHEETS.SHIFTS, shift);
  return shift;
}

function getShiftByDate_(date) {
  var found = findRowsBy_(SHEETS.SHIFTS, function (s) { return s.date === date; }, 500);
  return found.length ? found[found.length - 1] : null;
}

function clientName_(clientId, clientsById) {
  var c = clientsById[clientId];
  return c ? c.name : clientId;
}

// --- Общие чтения ---

function getDayList(token, date) {
  if (!requireRole_(token, ['owner', 'worker'])) return err_('Нет доступа');
  date = date || todayStr_();
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var washes = findRowsBy_(SHEETS.WASHES, function (w) {
    return isDayWash_(w, date);
  }, 1000).map(function (r) { return r.obj; });
  var shift = getShiftByDate_(date);
  return ok_({
    date: date,
    laundryName: getSettings_().LAUNDRY_NAME || 'Прачка360',
    washes: sortDayList_(washes).map(function (w) {
      w.client_name = clientName_(w.client_id, clients);
      return w;
    }),
    shift: shift ? shift.obj : null,
    clients: getClients_().filter(function (c) { return c.active === 'да'; }),
    itemTypes: getItemTypes_().filter(function (t) { return t.active === 'да'; })
  });
}

// --- Сотрудник ---

function startWash(token, washId, weightKg) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    var check = checkTransition_('start', found && found.obj);
    if (!check.ok) return err_(check.error);
    var w = found.obj;
    // Повторное «В работу» не затирает started_at: переход из in_progress уже отклонён.
    w.status = 'in_progress';
    w.started_at = nowStr_();
    w.dirty_weight_kg = round1_(weightKg);
    updateRow_(SHEETS.WASHES, found.rowNumber, w);
    ensureShift_(w.wash_date);
    logEvent(role, 'wash_start', washId, { weight: w.dirty_weight_kg });
    return ok_({ wash: w });
  });
}

function completeWash(token, washId, items) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    var check = checkTransition_('complete', found && found.obj);
    if (!check.ok) return err_(check.error); // повторное завершение не дублирует WashItems
    var w = found.obj;
    var valid = (items || []).filter(function (it) { return Number(it.qty) > 0; });
    var total = 0;
    valid.forEach(function (it) {
      var qty = Math.floor(Number(it.qty));
      total += qty;
      appendRow_(SHEETS.WASH_ITEMS, {
        id: nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: washId,
        item_type_id: it.item_type_id, qty: qty
      });
    });
    w.status = completionStatus_(w.wash_date, w.issue_date);
    w.items_total = total;
    w.done_at = nowStr_();
    updateRow_(SHEETS.WASHES, found.rowNumber, w);
    ensureShift_(w.wash_date);
    logEvent(role, 'wash_done', washId, { status: w.status, items: valid, kg: w.dirty_weight_kg });
    return ok_({ wash: w });
  });
}

// Правка веса/пересчёта завершённой (spec §4.2): статус и done_at не меняются.
function editWashData(token, washId, weightKg, items) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    var w = found.obj;
    var shift = getShiftByDate_(w.wash_date);
    if (!canEditWashData_(role, w, shift && shift.obj)) {
      return err_('Правка недоступна: смена закрыта');
    }
    var old = { kg: w.dirty_weight_kg, items_total: w.items_total };
    // WashItems стирки удаляются (снизу вверх) и пишутся заново
    var oldItems = findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return wi.wash_id === washId; }, 1000);
    oldItems.sort(function (a, b) { return b.rowNumber - a.rowNumber; })
      .forEach(function (r) { deleteRow_(SHEETS.WASH_ITEMS, r.rowNumber); });
    var total = 0;
    (items || []).filter(function (it) { return Number(it.qty) > 0; }).forEach(function (it) {
      var qty = Math.floor(Number(it.qty));
      total += qty;
      appendRow_(SHEETS.WASH_ITEMS, {
        id: nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: washId,
        item_type_id: it.item_type_id, qty: qty
      });
    });
    w.dirty_weight_kg = round1_(weightKg);
    w.items_total = total;
    updateRow_(SHEETS.WASHES, found.rowNumber, w);
    logEvent(role, 'wash_edit', washId, { old: old, now: { kg: w.dirty_weight_kg, items_total: total } });
    return ok_({ wash: w });
  });
}

function deferWash(token, washId, newDate, reason) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    var check = checkTransition_('defer', found && found.obj);
    if (!check.ok) return err_(check.error);
    var w = found.obj;
    var patch = applyDefer_(w, newDate, reason);
    logEvent(role, 'wash_defer', washId, { from: patch.deferred_from, to: newDate, reason: reason || '' });
    Object.keys(patch).forEach(function (k) { w[k] = patch[k]; });
    updateRow_(SHEETS.WASHES, found.rowNumber, w);
    return ok_({ wash: w });
  });
}

// Внеплановая стирка из цеха: сегодня, выдача завтра, created_by по роли.
function addUnplannedWash(token, clientId, comment) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var today = todayStr_();
    var w = {
      id: nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: today, issue_date: addDaysStr_(today, 1), status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: comment || '',
      created_by: role, created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    appendRow_(SHEETS.WASHES, w);
    ensureShift_(today);
    logEvent(role, 'wash_create', w.id, { client_id: clientId, unplanned: true });
    return ok_({ wash: w });
  });
}

function getShiftCloseState(token) {
  if (!requireRole_(token, ['owner', 'worker'])) return err_('Нет доступа');
  var today = todayStr_();
  var washes = findRowsBy_(SHEETS.WASHES, function (w) { return w.wash_date === today; }, 1000)
    .map(function (r) { return r.obj; });
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var blockers = shiftBlockers_(washes, today).map(function (w) {
    w.client_name = clientName_(w.client_id, clients);
    return w;
  });
  var log = findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
  return ok_({
    date: today,
    blockers: blockers,
    report: buildDayReport_(today, washes, log),
    shift: getShiftByDate_(today) ? getShiftByDate_(today).obj : null
  });
}

// Закрытие смены (spec §4.4): блокируют незавершённые планы сегодняшнего дня.
function closeShift(token) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var today = todayStr_();
    var washes = findRowsBy_(SHEETS.WASHES, function (w) { return w.wash_date === today; }, 1000)
      .map(function (r) { return r.obj; });
    var blockers = shiftBlockers_(washes, today);
    if (blockers.length) {
      return err_('Есть незавершённые стирки: ' + blockers.map(function (w) { return w.id; }).join(', '));
    }
    var shift = getShiftByDate_(today) || (function () {
      ensureShift_(today);
      return getShiftByDate_(today);
    })();
    if (shift.obj.status === 'closed') return err_('Смена уже закрыта');
    var log = findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
    var report = buildDayReport_(today, washes, log);
    var s = shift.obj;
    s.status = 'closed';
    s.closed_at = timeStr_();
    s.total_kg = report.totalKg;
    s.washes_done = report.washesDone;
    s.washes_deferred = report.deferred;
    updateRow_(SHEETS.SHIFTS, shift.rowNumber, s);
    logEvent(role, 'shift_close', s.id, { total_kg: s.total_kg, washes_done: s.washes_done });
    // Дайджест (spec §8.3): fallback уже отправил → только короткое подтверждение;
    // иначе — полный дайджест под тем же локом.
    if (String(s.digest_sent) === 'да') {
      sendTelegram_(null, 'Смена закрыта в ' + s.closed_at + ' ✓');
    } else {
      sendDigestLocked_(today);
    }
    return ok_({ shift: s, report: report });
  });
}

// --- Владелец ---

function getDeliveryPlan(token, date) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var all = findRowsBy_(SHEETS.WASHES, function (w) {
    return w.wash_date === date || w.issue_date === date;
  }, 1000).map(function (r) { return r.obj; });
  var decorate = function (w) { w.client_name = clientName_(w.client_id, clients); return w; };
  return ok_({
    date: date,
    planned: sortDayList_(all.filter(function (w) { return isDayWash_(w, date); })).map(decorate),
    issueToday: all.filter(function (w) {
      return w.issue_date === date && (w.status === 'done' || w.status === 'stored');
    }).map(decorate),
    overdueIssue: all.filter(function (w) {
      return w.issue_date < date && (w.status === 'done' || w.status === 'stored');
    }).map(decorate),
    clients: getClients_().filter(function (c) { return c.active === 'да'; })
  });
}

function addToDelivery(token, clientId, washDate, issueDate, comment) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var w = {
      id: nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: washDate, issue_date: issueDate, status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: comment || '',
      created_by: 'owner', created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    appendRow_(SHEETS.WASHES, w);
    logEvent('owner', 'wash_create', w.id, { client_id: clientId, wash_date: washDate, issue_date: issueDate });
    return ok_({ wash: w });
  });
}

function cancelWash(token, washId) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    var check = checkTransition_('cancel', found && found.obj);
    if (!check.ok) return err_(check.error);
    found.obj.status = 'cancelled';
    updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent('owner', 'wash_cancel', washId, {});
    return ok_({ wash: found.obj });
  });
}

function markIssued(token, washId) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    var check = checkTransition_('issue', found && found.obj);
    if (!check.ok) return err_(check.error);
    found.obj.status = 'issued';
    found.obj.issued_at = nowStr_();
    updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent('owner', 'wash_issue', washId, {});
    return ok_({ wash: found.obj });
  });
}

// Правка issue_date у done/stored статус не меняет (spec §4.3).
function updateIssueDate(token, washId, issueDate) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    if (['done', 'stored'].indexOf(found.obj.status) === -1) {
      return err_('Менять дату выдачи можно только у завершённой стирки');
    }
    var old = found.obj.issue_date;
    found.obj.issue_date = issueDate;
    updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent('owner', 'wash_edit', washId, { issue_date: old + ' → ' + issueDate });
    return ok_({ wash: found.obj });
  });
}

// --- Канбан «Неделя»: планирование выдачи (spec §10) ---
// Карточка = выдача чистого белья (issue_date); стирка — за день до выдачи
// (wash_date = issue_date − 1), поэтому дневные задачи работников подтягиваются сами.

// Копия прошлой недели: planned-стирки со сдвигом +7 дней. Только под локом.
function copyPrevWeek_(monday) {
  var prevMon = addDaysStr_(monday, -7);
  var prevSun = addDaysStr_(monday, -1);
  var src = findRowsBy_(SHEETS.WASHES, function (w) {
    return w.issue_date >= prevMon && w.issue_date <= prevSun && w.status !== 'cancelled';
  }, 1000);
  src.forEach(function (r) {
    var w = r.obj;
    var copy = {
      id: nextId_(SHEETS.WASHES, 'wash'), client_id: w.client_id,
      wash_date: addDaysStr_(w.wash_date, 7), issue_date: addDaysStr_(w.issue_date, 7),
      status: 'planned', dirty_weight_kg: '', items_total: '', comment: w.comment || '',
      created_by: 'owner', created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    appendRow_(SHEETS.WASHES, copy);
  });
  if (src.length) logEvent('owner', 'week_copy', monday, { copied: src.length });
}

function getWeekPlan(token, monday) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  var mon = mondayOf_(monday || todayStr_());
  var sun = addDaysStr_(mon, 6);
  return withLock_(function () {
    var readWeek_ = function () {
      return findRowsBy_(SHEETS.WASHES, function (w) {
        return (w.wash_date >= mon && w.wash_date <= sun) ||
               (w.issue_date >= mon && w.issue_date <= sun);
      }, 2000).map(function (r) { return r.obj; });
    };
    var week = readWeek_();
    // Идемпотентная материализация: копируем прошлую неделю, только если эта пустая.
    if (!week.some(function (w) { return w.status !== 'cancelled'; })) {
      copyPrevWeek_(mon);
      week = readWeek_();
    }
    var clients = {};
    getClients_().forEach(function (c) { clients[c.id] = c; });
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = addDaysStr_(mon, i);
      days.push({
        date: d,
        cards: week.filter(function (w) { return w.issue_date === d && w.status !== 'cancelled'; })
          .map(function (w) {
            return { id: w.id, client_id: w.client_id, client_name: clientName_(w.client_id, clients),
              issue_date: w.issue_date, wash_date: w.wash_date, status: w.status, comment: w.comment };
          })
      });
    }
    return ok_({ monday: mon, days: days,
      clients: getClients_().filter(function (c) { return c.active === 'да'; }) });
  });
}

function addWeekCard(token, clientId, issueDate, comment) {
  return addToDelivery(token, clientId, addDaysStr_(issueDate, -1), issueDate, comment);
}

function moveWeekCard(token, washId, newIssueDate) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    if (found.obj.status !== 'planned') return err_('Можно переносить только запланированные');
    var old = found.obj.issue_date;
    found.obj.issue_date = newIssueDate;
    found.obj.wash_date = addDaysStr_(newIssueDate, -1);
    updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent('owner', 'wash_move', washId, { issue_date: old + ' → ' + newIssueDate });
    return ok_({ wash: found.obj });
  });
}

// Убрать карточку = отмена planned-стирки, логика уже в cancelWash.
function removeWeekCard(token, washId) {
  return cancelWash(token, washId);
}

function getStorage(token) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var stored = findRowsBy_(SHEETS.WASHES, function (w) { return w.status === 'stored'; }, 1000)
    .map(function (r) {
      var w = r.obj;
      w.client_name = clientName_(w.client_id, clients);
      w.items = findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return wi.wash_id === w.id; }, 1000)
        .map(function (x) { return x.obj; });
      return w;
    });
  stored.sort(function (a, b) { return a.issue_date < b.issue_date ? -1 : 1; });
  return ok_({ stored: stored, itemTypes: getItemTypes_() });
}

function getDayReport(token, date) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var types = {};
  getItemTypes_().forEach(function (t) { types[t.id] = t.name; });
  var washes = findRowsBy_(SHEETS.WASHES, function () { return true; }, 1000)
    .map(function (r) { return r.obj; });
  var log = findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
  var report = buildDayReport_(date, washes, log);
  var dayWashes = washes.filter(function (w) { return w.wash_date === date; }).map(function (w) {
    w.client_name = clientName_(w.client_id, clients);
    w.items = findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return wi.wash_id === w.id; }, 1000)
      .map(function (x) {
        x.obj.item_name = types[x.obj.item_type_id] || x.obj.item_type_id;
        return x.obj;
      });
    return w;
  });
  var shift = getShiftByDate_(date);
  return ok_({ report: report, washes: sortDayList_(dayWashes), shift: shift ? shift.obj : null });
}

// --- Справочники (owner). Записи сбрасывают кэш (spec §10) ---

function saveClient(token, client) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var saved;
    if (client.id) {
      var found = findById_(SHEETS.CLIENTS, client.id);
      if (!found) return err_('Клиент не найден');
      Object.keys(client).forEach(function (k) { found.obj[k] = client[k]; });
      updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
      saved = found.obj;
    } else {
      saved = {
        id: nextId_(SHEETS.CLIENTS, 'cli'), name: client.name || '',
        contact: client.contact || '', address: client.address || '',
        type: client.type || 'прочее', storage: client.storage || 'нет',
        active: 'да', comment: client.comment || ''
      };
      appendRow_(SHEETS.CLIENTS, saved);
    }
    invalidateRefCache_();
    return ok_({ client: saved });
  });
}

// Удаление = архивация (active=нет, spec §7.3).
function deleteClient(token, clientId) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.CLIENTS, clientId);
    if (!found) return err_('Клиент не найден');
    found.obj.active = 'нет';
    updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
    invalidateRefCache_();
    return ok_({ client: found.obj });
  });
}

function saveItemType(token, itemType) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    var saved;
    if (itemType.id) {
      var found = findById_(SHEETS.ITEM_TYPES, itemType.id);
      if (!found) return err_('Тип не найден');
      Object.keys(itemType).forEach(function (k) { found.obj[k] = itemType[k]; });
      updateRow_(SHEETS.ITEM_TYPES, found.rowNumber, found.obj);
      saved = found.obj;
    } else {
      var maxSort = 0;
      getItemTypes_().forEach(function (t) { maxSort = Math.max(maxSort, Number(t.sort) || 0); });
      saved = {
        id: nextId_(SHEETS.ITEM_TYPES, 'itm'), name: itemType.name || '',
        sort: maxSort + 1, active: 'да'
      };
      appendRow_(SHEETS.ITEM_TYPES, saved);
    }
    invalidateRefCache_();
    return ok_({ itemType: saved });
  });
}

// --- TV-табло (spec §5.3): по ключу, только чтение, только агрегаты дня ---

// Полные справочники для экрана владельца (включая архивные).
function getRefs(token) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return ok_({ clients: getClients_(), itemTypes: getItemTypes_() });
}

function getTvData(key) {
  if (String(key) !== PropertiesService.getScriptProperties().getProperty('TV_KEY')) {
    return err_('Нет доступа');
  }
  var today = todayStr_();
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var washes = findRowsBy_(SHEETS.WASHES, function (w) { return isDayWash_(w, today); }, 1000)
    .map(function (r) { return r.obj; });
  var counters = { total: washes.length, planned: 0, in_progress: 0, done: 0, stored: 0, deferred: 0 };
  var cards = sortDayList_(washes).map(function (w) {
    if (counters[w.status] !== undefined) counters[w.status]++;
    if (w.deferred_from) counters.deferred++;
    return {
      client: clientName_(w.client_id, clients), status: w.status,
      kg: w.dirty_weight_kg || '', items: w.items_total || '',
      deferred_from: w.deferred_from || '', comment: w.comment || ''
    };
  });
  return ok_({
    date: today, laundryName: getSettings_().LAUNDRY_NAME || 'Прачка360',
    counters: counters, washes: cards, updatedAt: timeStr_()
  });
}
