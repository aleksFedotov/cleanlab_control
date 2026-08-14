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

// Автоформирование стирок дня из завтрашнего развоза: клиент в развозе на
// date+1 → плановая стирка сегодня (выдача завтра). Идемпотентно, только под локом.
function ensureWashesFromDelivery_(date) {
  var nextDay = addDaysStr_(date, 1);
  var visits = getVisitsByDate_(nextDay);
  if (!visits.length) return;
  // Отменённые тоже считаем «существующими»: иначе стирка, снятая подтверждением
  // «белья нет на складе» (или отмена владельца), будет пересоздана при следующем чтении.
  var dayWashes = findRowsBy_(SHEETS.WASHES, function (w) {
    return w.wash_date === date;
  }, 1000).map(function (r) { return r.obj; });
  visits.forEach(function (v) {
    var exists = dayWashes.some(function (w) { return w.client_id === v.client_id; });
    if (exists) return;
    var w = {
      id: nextId_(SHEETS.WASHES, 'wash'), client_id: v.client_id,
      wash_date: date, issue_date: nextDay, status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: '',
      created_by: 'auto', created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    appendRow_(SHEETS.WASHES, w);
    dayWashes.push(w);
    logEvent('auto', 'wash_create', w.id, { client_id: v.client_id, from_visit: v.id });
  });
}

function getDayList(token, date) {
  if (!requireRole_(token, ['owner', 'worker'])) return err_('Нет доступа');
  date = date || todayStr_();
  return withLock_(function () {
    ensureWashesFromDelivery_(date);
    var clients = {};
    getClients_().forEach(function (c) { clients[c.id] = c; });
    var washes = findRowsBy_(SHEETS.WASHES, function (w) {
      return isDayWash_(w, date);
    }, 1000).map(function (r) { return r.obj; });
    var shift = getShiftByDate_(date);
    var storage = storageSummaryByClient_();
    return ok_({
      date: date,
      laundryName: getSettings_().LAUNDRY_NAME || 'Прачка360',
      washes: sortDayList_(washes).map(function (w) {
        w.client_name = clientName_(w.client_id, clients);
        // Состояние склада для раскраски «К работе» (check-storage из спеки)
        var s = storage[w.client_id] || { dirty: 0, clean: 0 };
        w.has_dirty = s.dirty > 0;
        w.has_clean = s.clean > 0;
        return w;
      }),
      shift: shift ? shift.obj : null,
      clients: getClients_().filter(function (c) { return c.active === 'да'; }),
      itemTypes: getItemTypes_().filter(function (t) { return t.active === 'да'; })
    });
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
    // Вес необязателен на старте: основное взвешивание — при завершении (чистый вес)
    if (Number(weightKg) > 0) w.dirty_weight_kg = round1_(weightKg);
    updateRow_(SHEETS.WASHES, found.rowNumber, w);
    // Грязное бельё клиента уходит со склада в стирку
    consumeStorage_(w.client_id, 'dirty');
    ensureShift_(w.wash_date);
    logEvent(role, 'wash_start', washId, { weight: w.dirty_weight_kg });
    return ok_({ wash: w });
  });
}

function completeWash(token, washId, items, weightKg, mode) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    var check = checkTransition_('complete', found && found.obj);
    if (!check.ok) return err_(check.error); // повторное завершение не дублирует WashItems
    var w = found.obj;
    // Вес чистого белья обязателен при завершении
    if (!(Number(weightKg) > 0)) return err_('Укажите вес чистого белья');
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
    // mode='partial': чистая часть на складе, но клиент НЕ готов к выдаче;
    // владелец вручную ставит остаток в стирку позже
    w.status = mode === 'partial' ? 'partial' : completionStatus_(w.wash_date, w.issue_date);
    w.items_total = total;
    w.dirty_weight_kg = round1_(weightKg);
    w.done_at = nowStr_();
    updateRow_(SHEETS.WASHES, found.rowNumber, w);
    // Результат стирки — чистое бельё на складе
    addStorageEntry_(w.client_id, 'clean', {
      weight_kg: w.dirty_weight_kg, items_total: total, wash_id: washId
    });
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
    // Синхронно правим clean-запись склада, если она ещё не выдана
    var st = findRowsBy_(SHEETS.STORAGE, function (s) {
      return s.wash_id === washId && s.kind === 'clean' && !s.consumed_at;
    }, 1000);
    if (st.length) {
      st[0].obj.weight_kg = w.dirty_weight_kg;
      st[0].obj.items_total = total;
      updateRow_(SHEETS.STORAGE, st[0].rowNumber, st[0].obj);
    }
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
    notReady: notReadyForDelivery_(addDaysStr_(today, 1)),
    report: buildDayReport_(today, washes, log),
    shift: getShiftByDate_(today) ? getShiftByDate_(today).obj : null
  });
}

// Клиенты развоза на date без готового чистого белья.
// Причины: washing_incomplete (стирка дня подготовки не завершена),
// partial (завершена частично), no_clean (нет чистого на складе).
function notReadyForDelivery_(date) {
  var visits = getVisitsByDate_(date);
  if (!visits.length) return [];
  var clients = {};
  getClients_().forEach(function (c) { clients[c.id] = c; });
  var storage = storageSummaryByClient_();
  var prepDay = addDaysStr_(date, -1);
  var washes = findRowsBy_(SHEETS.WASHES, function (w) {
    return w.status !== 'cancelled';
  }, 2000).map(function (r) { return r.obj; });
  var out = [];
  visits.forEach(function (v) {
    var prep = washes.filter(function (w) {
      return w.client_id === v.client_id && w.wash_date === prepDay;
    });
    // Незавершённая или частичная стирка дня подготовки — клиент не готов в любом случае
    var reason = null;
    if (prep.some(function (w) { return w.status === 'planned' || w.status === 'in_progress'; })) {
      reason = 'washing_incomplete';
    } else if (prep.some(function (w) { return w.status === 'partial'; })) {
      reason = 'partial';
    } else {
      var s = storage[v.client_id];
      var hasClean = (s && s.clean > 0) || washes.some(function (w) {
        return w.client_id === v.client_id && (w.status === 'done' || w.status === 'stored');
      });
      if (!hasClean) reason = 'no_clean';
    }
    if (reason) {
      out.push({ client_id: v.client_id, client_name: clientName_(v.client_id, clients), reason: reason });
    }
  });
  return out;
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
    // Предупреждение владельцу: кто не готов к завтрашнему развозу
    var notReady = notReadyForDelivery_(addDaysStr_(today, 1));
    if (notReady.length) {
      var REASONS = { washing_incomplete: 'стирка не завершена', partial: 'стирка частичная', no_clean: 'нет чистого белья' };
      sendTelegram_(null, '⚠ К развозу на ' + addDaysStr_(today, 1) + ' не готовы:\n' +
        notReady.map(function (n) { return '• ' + n.client_name + ' — ' + REASONS[n.reason]; }).join('\n'));
    }
    return ok_({ shift: s, report: report, notReady: notReady });
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

// Подтверждение проверки склада работником (спека «check storage»).
// Применимо только к planned-стирке. Три исхода:
//  - no_dirty / already_clean → стирка не нужна, отменяем с причиной;
//    клиент при этом остаётся в предупреждении «не готов к развозу» (no_clean), если чистого нет.
//  - has_dirty → рабочий нашёл грязное бельё: стирка остаётся planned, только лог.
function confirmStorageCheck(token, washId, verdict) {
  var role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  var REASONS = {
    no_dirty: 'нет грязного белья на складе',
    already_clean: 'бельё уже чистое на складе'
  };
  if (verdict !== 'has_dirty' && !REASONS[verdict]) return err_('Неизвестный verdict');
  return withLock_(function () {
    var found = findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    if (found.obj.status !== 'planned') return err_('Подтверждение возможно только для стирки «К работе»');
    if (verdict === 'has_dirty') {
      logEvent(role, 'storage_check', washId, { verdict: verdict });
      return ok_({ wash: found.obj });
    }
    found.obj.status = 'cancelled';
    found.obj.deferred_reason = REASONS[verdict];
    updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent(role, 'storage_check', washId, { verdict: verdict });
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
    // Чистая запись этой стирки уходит со склада
    findRowsBy_(SHEETS.STORAGE, function (s) {
      return s.wash_id === washId && s.kind === 'clean' && !s.consumed_at;
    }, 1000).forEach(function (r) {
      r.obj.consumed_at = found.obj.issued_at;
      updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
    });
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

// --- Канбан «Неделя»: планирование развозов ---
// Карточка = визит развоза (клиент в день D). Стирки дня формируются из развоза
// на завтра (см. getDayList). Хранение и права — в Deliveries.gs.

// Копия прошлой недели: planned-визиты со сдвигом +7 дней. Только под локом.
function copyPrevWeek_(monday) {
  var src = getVisitsByWeek_(addDaysStr_(monday, -7));
  src.forEach(function (v) {
    appendRow_(SHEETS.DELIVERIES, {
      id: nextId_(SHEETS.DELIVERIES, 'del'), date: addDaysStr_(v.date, 7),
      client_id: v.client_id, ord: v.ord, status: 'planned',
      delivered_at: '', pickup: '', driver_comment: '',
      created_by: 'owner', created_at: nowStr_()
    });
  });
  if (src.length) logEvent('owner', 'week_copy', monday, { copied: src.length });
}

function getWeekPlan(token, monday) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  var mon = mondayOf_(monday || todayStr_());
  return withLock_(function () {
    var week = getVisitsByWeek_(mon);
    // Идемпотентная материализация: копируем прошлую неделю, только если эта пустая.
    if (!week.length) {
      copyPrevWeek_(mon);
      week = getVisitsByWeek_(mon);
    }
    var clients = {};
    getClients_().forEach(function (c) { clients[c.id] = c; });
    var storage = storageSummaryByClient_();
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = addDaysStr_(mon, i);
      days.push({
        date: d,
        cards: week.filter(function (v) { return v.date === d; })
          .sort(function (a, b) { return (Number(a.ord) || 0) - (Number(b.ord) || 0); })
          .map(function (v) { return decorateVisit_(v, clients, storage); })
      });
    }
    return ok_({ monday: mon, days: days,
      clients: getClients_().filter(function (c) { return c.active === 'да'; }) });
  });
}

function addWeekCard(token, clientId, date) {
  return addDeliveryVisit(token, clientId, date);
}

function moveWeekCard(token, visitId, newDate) {
  return moveDeliveryVisit(token, visitId, newDate);
}

function removeWeekCard(token, visitId) {
  return removeDeliveryVisit(token, visitId);
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
  // Складские записи: грязное (от водителя) и чистое (результат стирок), не израсходованные
  var open = findRowsBy_(SHEETS.STORAGE, function (s) { return !s.consumed_at; }, 2000)
    .map(function (r) {
      var s = r.obj;
      s.client_name = clientName_(s.client_id, clients);
      return s;
    });
  return ok_({
    stored: stored,
    dirty: open.filter(function (s) { return s.kind === 'dirty'; }),
    clean: open.filter(function (s) { return s.kind === 'clean'; }),
    itemTypes: getItemTypes_()
  });
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
