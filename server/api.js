// Серверное API (spec §6) — порт src/Api.gs. Каждая функция принимает токен первым параметром.
// LockService не нужен: однопроцессный Node + синхронный better-sqlite3.
// Express-монтирование: каждая публичная функция → POST /api/<имя>, тело { args: [...] }.
const { SHEETS } = require('./schema');
const db = require('./db');
const time = require('./util/time');
const { config } = require('./config');
const { nowStr_, todayStr_, logEvent } = require('./audit');
const { requireRole_ } = require('./auth');
const core = require('./core');
const {
  addDaysStr_, mondayOf_, checkTransition_, applyDefer_, canEditWashData_,
  isDayWash_, sortDayList_, shiftBlockers_, buildDayReport_, completionStatus_,
  err_, ok_, round1_, clientName_
} = core;
const { addStorageEntry_, openStorage_, consumeStorage_, storageSummaryByClient_ } = require('./storage');
const deliveries = require('./deliveries');
const { getVisitsByDate_, getVisitsByWeek_, decorateVisit_, isOpenVisit_ } = deliveries;

// Замена LockService.getScriptLock(): синхронные операции атомарны в одном процессе.
function withLock_(fn) { return fn(); }

function timeStr_() { return time.nowHHMM(); }

// Смена создаётся автоматически при первом действии (upsert по дате, spec §3.7).
function ensureShift_(date) {
  const found = db.findRowsBy_(SHEETS.SHIFTS, function (s) { return s.date === date; }, 500);
  if (found.length) return found[found.length - 1].obj;
  const shift = {
    id: db.nextId_(SHEETS.SHIFTS, 'shift'), date: date, status: 'open',
    opened_at: nowStr_(), closed_at: '', total_kg: '', washes_done: '',
    washes_deferred: '', digest_sent: ''
  };
  db.appendRow_(SHEETS.SHIFTS, shift);
  return shift;
}

function getShiftByDate_(date) {
  const found = db.findRowsBy_(SHEETS.SHIFTS, function (s) { return s.date === date; }, 500);
  return found.length ? found[found.length - 1] : null;
}

// --- Общие чтения ---

// Автоформирование стирок дня из завтрашнего развоза: клиент в развозе на
// date+1 → плановая стирка сегодня (выдача завтра). Идемпотентно.
function ensureWashesFromDelivery_(date) {
  const nextDay = addDaysStr_(date, 1);
  const visits = getVisitsByDate_(nextDay);
  if (!visits.length) return;
  // Отменённые тоже считаем «существующими»: иначе стирка, снятая подтверждением
  // «белья нет на складе» (или отмена владельца), будет пересоздана при следующем чтении.
  const dayWashes = db.findRowsBy_(SHEETS.WASHES, function (w) {
    return w.wash_date === date;
  }, 1000).map(function (r) { return r.obj; });
  visits.forEach(function (v) {
    const exists = dayWashes.some(function (w) { return w.client_id === v.client_id; });
    if (exists) return;
    const w = {
      id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: v.client_id,
      wash_date: date, issue_date: nextDay, status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: '',
      created_by: 'auto', created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    db.appendRow_(SHEETS.WASHES, w);
    dayWashes.push(w);
    logEvent('auto', 'wash_create', w.id, { client_id: v.client_id, from_visit: v.id });
  });
}

function getDayList(token, date) {
  if (!requireRole_(token, ['owner', 'worker'])) return err_('Нет доступа');
  date = date || todayStr_();
  return withLock_(function () {
    ensureWashesFromDelivery_(date);
    const clients = {};
    db.getClients_().forEach(function (c) { clients[c.id] = c; });
    const washes = db.findRowsBy_(SHEETS.WASHES, function (w) {
      return isDayWash_(w, date);
    }, 1000).map(function (r) { return r.obj; });
    const shift = getShiftByDate_(date);
    const storage = storageSummaryByClient_();
    return ok_({
      date: date,
      laundryName: db.getSettings_().LAUNDRY_NAME || 'Прачечная PRO',
      washes: sortDayList_(washes).map(function (w) {
        w.client_name = clientName_(w.client_id, clients);
        // Состояние склада для раскраски «К работе» (check-storage из спеки)
        const s = storage[w.client_id] || { dirty: 0, clean: 0 };
        w.has_dirty = s.dirty > 0;
        w.has_clean = s.clean > 0;
        // Настройки клиента: свой список белья и режим учёта (пусто = все типы / both)
        const cl = clients[w.client_id] || {};
        w.client_item_types = db.parseJsonList_(cl.item_types);
        w.client_accounting = cl.accounting === 'weight' || cl.accounting === 'count' ? cl.accounting : 'both';
        return w;
      }),
      shift: shift ? shift.obj : null,
      clients: db.getClients_().filter(function (c) { return c.active === 'да'; }),
      itemTypes: db.getItemTypes_().filter(function (t) { return t.active === 'да'; })
    });
  });
}

// --- Сотрудник ---

function startWash(token, washId, weightKg) {
  const role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    const check = checkTransition_('start', found && found.obj);
    if (!check.ok) return err_(check.error);
    const w = found.obj;
    // Повторное «В работу» не затирает started_at: переход из in_progress уже отклонён.
    w.status = 'in_progress';
    w.started_at = nowStr_();
    // Вес необязателен на старте: основное взвешивание — при завершении (чистый вес)
    if (Number(weightKg) > 0) w.dirty_weight_kg = round1_(weightKg);
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    // Грязное бельё клиента уходит со склада в стирку
    consumeStorage_(w.client_id, 'dirty');
    ensureShift_(w.wash_date);
    logEvent(role, 'wash_start', washId, { weight: w.dirty_weight_kg });
    return ok_({ wash: w });
  });
}

function completeWash(token, washId, items, weightKg, mode, bags) {
  const role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    const check = checkTransition_('complete', found && found.obj);
    if (!check.ok) return err_(check.error); // повторное завершение не дублирует WashItems
    const w = found.obj;
    // Вес чистого белья обязателен при завершении, кроме клиентов с учётом «только количество»
    const cl = db.findById_(SHEETS.CLIENTS, w.client_id);
    const countOnly = cl && cl.obj.accounting === 'count';
    if (!countOnly && !(Number(weightKg) > 0)) return err_('Укажите вес чистого белья');
    // Мешки обязательны всегда: по ним водитель сверяет выдачу
    if (!(Number(bags) > 0)) return err_('Укажите количество мешков');
    const valid = (items || []).filter(function (it) { return Number(it.qty) > 0; });
    let total = 0;
    valid.forEach(function (it) {
      const qty = Math.floor(Number(it.qty));
      total += qty;
      db.appendRow_(SHEETS.WASH_ITEMS, {
        id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: washId,
        item_type_id: it.item_type_id, qty: qty
      });
    });
    // mode='partial': чистая часть на складе, но клиент НЕ готов к выдаче;
    // владелец вручную ставит остаток в стирку позже
    w.status = mode === 'partial' ? 'partial' : completionStatus_(w.wash_date, w.issue_date);
    w.items_total = total;
    w.bags = Math.max(0, Math.floor(Number(bags) || 0)); // мешков получилось после стирки
    w.dirty_weight_kg = round1_(weightKg);
    w.done_at = nowStr_();
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    // Результат стирки — чистое бельё на складе
    addStorageEntry_(w.client_id, 'clean', {
      weight_kg: w.dirty_weight_kg, items_total: total, wash_id: washId
    });
    ensureShift_(w.wash_date);
    logEvent(role, 'wash_done', washId, { status: w.status, items: valid, kg: w.dirty_weight_kg, bags: w.bags });
    return ok_({ wash: w });
  });
}

// Правка веса/пересчёта/мешков завершённой (spec §4.2): статус и done_at не меняются.
function editWashData(token, washId, weightKg, items, bags) {
  const role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    const w = found.obj;
    const shift = getShiftByDate_(w.wash_date);
    if (!canEditWashData_(role, w, shift && shift.obj)) {
      return err_('Правка недоступна: смена закрыта');
    }
    const old = { kg: w.dirty_weight_kg, items_total: w.items_total, bags: w.bags };
    // WashItems стирки удаляются (снизу вверх) и пишутся заново
    const oldItems = db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return wi.wash_id === washId; }, 1000);
    oldItems.sort(function (a, b) { return b.rowNumber - a.rowNumber; })
      .forEach(function (r) { db.deleteRow_(SHEETS.WASH_ITEMS, r.rowNumber); });
    let total = 0;
    (items || []).filter(function (it) { return Number(it.qty) > 0; }).forEach(function (it) {
      const qty = Math.floor(Number(it.qty));
      total += qty;
      db.appendRow_(SHEETS.WASH_ITEMS, {
        id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: washId,
        item_type_id: it.item_type_id, qty: qty
      });
    });
    w.dirty_weight_kg = round1_(weightKg);
    w.items_total = total;
    w.bags = Math.max(0, Math.floor(Number(bags) || 0));
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    // Синхронно правим clean-запись склада, если она ещё не выдана
    const st = db.findRowsBy_(SHEETS.STORAGE, function (s) {
      return s.wash_id === washId && s.kind === 'clean' && !s.consumed_at;
    }, 1000);
    if (st.length) {
      st[0].obj.weight_kg = w.dirty_weight_kg;
      st[0].obj.items_total = total;
      db.updateRow_(SHEETS.STORAGE, st[0].rowNumber, st[0].obj);
    }
    logEvent(role, 'wash_edit', washId, { old: old, now: { kg: w.dirty_weight_kg, items_total: total, bags: w.bags } });
    return ok_({ wash: w });
  });
}

function deferWash(token, washId, newDate, reason) {
  const role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    const check = checkTransition_('defer', found && found.obj);
    if (!check.ok) return err_(check.error);
    const w = found.obj;
    const patch = applyDefer_(w, newDate, reason);
    const details = { from: patch.deferred_from, to: newDate, reason: reason || '' };
    if (w.status === 'partial') {
      // Достирка остатка: стирка возвращается в план нового дня, выдача — на
      // следующий день. Постиранная часть (вес/позиции/clean-запись на складе)
      // сохраняется; остаток при повторном завершении добавит вторую запись.
      const oldIssueDate = w.issue_date;
      const newIssueDate = addDaysStr_(newDate, 1);
      patch.status = 'planned';
      patch.issue_date = newIssueDate;
      // Остаток грязного физически в цеху: восстанавливаем dirty-запись склада,
      // иначе карточка показывает «Нет белья на складе» (первая запись израсходована
      // при первом «В работу»). Как verdict has_dirty в confirmStorageCheck.
      if (openStorage_(w.client_id, 'dirty').length === 0) {
        addStorageEntry_(w.client_id, 'dirty', {});
      }
      // Визит развоза едет следом: «завтра» → «послезавтра». Только planned и
      // только если на целевую дату у клиента ещё нет визита.
      const visit = getVisitsByDate_(oldIssueDate).filter(function (x) {
        return x.client_id === w.client_id && x.status === 'planned';
      })[0];
      const dup = getVisitsByDate_(newIssueDate).some(function (x) {
        return x.client_id === w.client_id;
      });
      if (visit && !dup) {
        const vf = db.findById_(SHEETS.DELIVERIES, visit.id);
        vf.obj.date = newIssueDate;
        db.updateRow_(SHEETS.DELIVERIES, vf.rowNumber, vf.obj);
        logEvent(role, 'visit_move', visit.id, { date: oldIssueDate + ' → ' + newIssueDate, reason: 'wash_defer' });
        details.visit_moved = true;
      } else {
        details.visit_moved = false;
      }
    }
    logEvent(role, 'wash_defer', washId, details);
    Object.keys(patch).forEach(function (k) { w[k] = patch[k]; });
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    return ok_({ wash: w });
  });
}

// Внеплановая стирка из цеха: сегодня, выдача завтра, created_by по роли.
function addUnplannedWash(token, clientId, comment) {
  const role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  return withLock_(function () {
    const today = todayStr_();
    // Не дублируем: у клиента уже есть открытая стирка на сегодня
    const dup = db.findRowsBy_(SHEETS.WASHES, function (x) {
      return x.client_id === clientId && x.wash_date === today &&
        ['planned', 'no_linen', 'in_progress'].indexOf(x.status) !== -1;
    }, 100).length;
    if (dup) return err_('Стирка этого клиента уже в плане на сегодня');
    const w = {
      id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: today, issue_date: addDaysStr_(today, 1), status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: comment || '',
      created_by: role, created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    db.appendRow_(SHEETS.WASHES, w);
    ensureShift_(today);
    logEvent(role, 'wash_create', w.id, { client_id: clientId, unplanned: true });
    return ok_({ wash: w });
  });
}

function getShiftCloseState(token) {
  if (!requireRole_(token, ['owner', 'worker'])) return err_('Нет доступа');
  const today = todayStr_();
  const washes = db.findRowsBy_(SHEETS.WASHES, function (w) { return w.wash_date === today; }, 1000)
    .map(function (r) { return r.obj; });
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  const blockers = shiftBlockers_(washes, today).map(function (w) {
    w.client_name = clientName_(w.client_id, clients);
    return w;
  });
  const log = db.findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
  return ok_({
    date: today,
    blockers: blockers,
    notReady: notReadyForDelivery_(addDaysStr_(today, 1)),
    report: buildDayReport_(today, washes, log),
    shift: getShiftByDate_(today) ? getShiftByDate_(today).obj : null
  });
}

// Клиенты развоза на date без готового чистого белья. Обслуженные точки
// (закрытый визит или чистое уже у водителя) пропускаем — предупреждать не о чем.
// Причины: washing_incomplete (стирка дня подготовки не завершена),
// partial (завершена частично), no_clean (нет чистого на складе).
function notReadyForDelivery_(date) {
  const visits = getVisitsByDate_(date);
  if (!visits.length) return [];
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  const storage = storageSummaryByClient_();
  const prepDay = addDaysStr_(date, -1);
  const washes = db.findRowsBy_(SHEETS.WASHES, function (w) {
    return w.status !== 'cancelled';
  }, 2000).map(function (r) { return r.obj; });
  const out = [];
  visits.forEach(function (v) {
    // Точка уже обслужена (закрыта или чистое у водителя) — предупреждать не о чем
    if (!isOpenVisit_(v) || v.clean_taken_at) return;
    // Владелец подтвердил «только забрать грязное» — чистое не нужно
    if (v.pickup_only === 'да') return;
    const prep = washes.filter(function (w) {
      return w.client_id === v.client_id && w.wash_date === prepDay;
    });
    // Незавершённая или частичная стирка дня подготовки — клиент не готов в любом случае
    let reason = null;
    if (prep.some(function (w) { return w.status === 'planned' || w.status === 'in_progress'; })) {
      reason = 'washing_incomplete';
    } else if (prep.some(function (w) { return w.status === 'partial'; })) {
      reason = 'partial';
    } else {
      const s = storage[v.client_id];
      const hasClean = (s && s.clean > 0) || washes.some(function (w) {
        return w.client_id === v.client_id && (w.status === 'done' || w.status === 'stored');
      });
      if (!hasClean) reason = 'no_clean';
    }
    if (reason) {
      out.push({ client_id: v.client_id, client_name: clientName_(v.client_id, clients), reason: reason, visit_id: v.id });
    }
  });
  return out;
}

// Закрытие смены (spec §4.4): незавершённые планы дня блокируют закрытие, если
// нет явного подтверждения (force=true — «мы знаем, что стирки не закончены»).
// Перенос таких стирок на другой день может сделать только владелец, поэтому
// при закрытии с незавершёнными владельцу уходит предупреждение в Telegram.
// Async: отправка дайджеста в Telegram — HTTP-запрос (см. telegram.js).
async function closeShift(token, force) {
  const role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  const today = todayStr_();
  const washes = db.findRowsBy_(SHEETS.WASHES, function (w) { return w.wash_date === today; }, 1000)
    .map(function (r) { return r.obj; });
  const blockers = shiftBlockers_(washes, today);
  if (blockers.length && !force) {
    return err_('Есть незавершённые стирки: ' + blockers.map(function (w) { return w.id; }).join(', '));
  }
  let shift = getShiftByDate_(today) || (function () {
    ensureShift_(today);
    return getShiftByDate_(today);
  })();
  if (shift.obj.status === 'closed') return err_('Смена уже закрыта');
  const log = db.findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
  const report = buildDayReport_(today, washes, log);
  const s = shift.obj;
  s.status = 'closed';
  s.closed_at = timeStr_();
  s.total_kg = report.totalKg;
  s.washes_done = report.washesDone;
  s.washes_deferred = report.deferred;
  db.updateRow_(SHEETS.SHIFTS, shift.rowNumber, s);
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  logEvent(role, 'shift_close', s.id, { total_kg: s.total_kg, washes_done: s.washes_done,
    unfinished: blockers.map(function (w) { return w.id; }) });
  // Дайджест (spec §8.3): fallback уже отправил → только короткое подтверждение;
  // иначе — полный дайджест.
  const tg = require('./telegram');
  if (String(s.digest_sent) === 'да') {
    tg.sendTelegram_(null, 'Смена закрыта в ' + s.closed_at + ' ✓').catch(function () {});
  } else {
    await tg.sendDigestLocked_(today);
  }
  // Предупреждение владельцу: смена закрыта с незавершёнными стирками
  if (blockers.length) {
    tg.sendTelegram_(null, '⚠ Смена ' + today + ' закрыта с незавершёнными стирками:\n' +
      blockers.map(function (w) {
        return '• ' + clientName_(w.client_id, clients) + ' — ' + (w.status === 'in_progress' ? 'в работе' : 'не начата');
      }).join('\n') +
      '\nПеренести их на другой день может только владелец.').catch(function () {});
  }
  // Предупреждение владельцу: кто не готов к завтрашнему развозу
  const notReady = notReadyForDelivery_(addDaysStr_(today, 1));
  if (notReady.length) {
    const REASONS = { washing_incomplete: 'стирка не завершена', partial: 'стирка частичная', no_clean: 'нет чистого белья' };
    tg.sendTelegram_(null, '⚠ К развозу на ' + addDaysStr_(today, 1) + ' не готовы:\n' +
      notReady.map(function (n) { return '• ' + n.client_name + ' — ' + REASONS[n.reason]; }).join('\n')
    ).catch(function () {});
  }
  return ok_({ shift: s, report: report, notReady: notReady });
}

// --- Владелец ---

function getDeliveryPlan(token, date) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  const all = db.findRowsBy_(SHEETS.WASHES, function (w) {
    return w.wash_date === date || w.issue_date === date;
  }, 1000).map(function (r) { return r.obj; });
  const decorate = function (w) { w.client_name = clientName_(w.client_id, clients); return w; };
  return ok_({
    date: date,
    planned: sortDayList_(all.filter(function (w) { return isDayWash_(w, date); })).map(decorate),
    issueToday: all.filter(function (w) {
      return w.issue_date === date && (w.status === 'done' || w.status === 'stored');
    }).map(decorate),
    overdueIssue: all.filter(function (w) {
      return w.issue_date < date && (w.status === 'done' || w.status === 'stored');
    }).map(decorate),
    clients: db.getClients_().filter(function (c) { return c.active === 'да'; })
  });
}

function addToDelivery(token, clientId, washDate, issueDate, comment) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    const w = {
      id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: washDate, issue_date: issueDate, status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: comment || '',
      created_by: 'owner', created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    db.appendRow_(SHEETS.WASHES, w);
    logEvent('owner', 'wash_create', w.id, { client_id: clientId, wash_date: washDate, issue_date: issueDate });
    return ok_({ wash: w });
  });
}

function cancelWash(token, washId) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    const check = checkTransition_('cancel', found && found.obj);
    if (!check.ok) return err_(check.error);
    found.obj.status = 'cancelled';
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent('owner', 'wash_cancel', washId, {});
    return ok_({ wash: found.obj });
  });
}

// Полное удаление ошибочно созданной стирки (owner). В отличие от отмены,
// запись исчезает из отчётов совсем. Разрешено для любой невыданной стирки:
// у завершённых (done/stored/partial) заодно удаляются позиции и складские
// строки этой стирки (в т.ч. израсходованные — бельё «убирается» из учёта).
// Выданную клиенту (issued) удалять нельзя — это уже факт выдачи.
function deleteWash(token, washId) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    const w = found.obj;
    if (w.status === 'issued') {
      return err_('Выданную клиенту стирку удалить нельзя');
    }
    // Связанные записи: позиции стирки и складские строки.
    // Удаляем снизу вверх, чтобы номера строк не съезжали.
    [SHEETS.WASH_ITEMS, SHEETS.STORAGE].forEach(function (sheet) {
      db.findRowsBy_(sheet, function (r) { return r.wash_id === washId; }, 1000)
        .sort(function (a, b) { return b.rowNumber - a.rowNumber; })
        .forEach(function (r) { db.deleteRow_(sheet, r.rowNumber); });
    });
    logEvent('owner', 'wash_delete', washId, {
      client_id: w.client_id, wash_date: w.wash_date, status: w.status,
      kg: w.dirty_weight_kg, items_total: w.items_total
    });
    db.deleteRow_(SHEETS.WASHES, found.rowNumber);
    return ok_({ id: washId });
  });
}

// Подтверждение проверки склада работником (спека «check storage»).
// Применимо к planned-стирке и к повторной проверке no_linen. Три исхода:
//  - no_dirty → статус no_linen: стирать нечего, карточка остаётся в «К стирке»
//    приглушённой; смену не блокирует, в отчёт как отмена НЕ идёт;
//    клиент остаётся в предупреждении «не готов к развозу» (no_clean), если чистого нет.
//  - already_clean → статус ready_clean: чистое уже на складе, работа закончена,
//    карточка уходит в «Готово», в отчёте считается завершённой (0 кг).
//  - has_dirty → рабочий нашёл грязное бельё: если записи о грязном нет,
//    создаём её (без веса — как приёмка водителем). Стирка остаётся/возвращается
//    в planned, карточка становится янтарной везде. Запись израсходуется при startWash.
// Время проверки пишем в done_at (для этих статусов — «когда разобрались с клиентом»).
function confirmStorageCheck(token, washId, verdict) {
  const role = requireRole_(token, ['owner', 'worker']);
  if (!role) return err_('Нет доступа');
  const VERDICTS = { no_dirty: 1, already_clean: 1, has_dirty: 1 };
  if (!VERDICTS[verdict]) return err_('Неизвестный verdict');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    const w = found.obj;
    if (w.status !== 'planned' && w.status !== 'no_linen') {
      return err_('Подтверждение возможно только для стирки «К работе»');
    }
    if (verdict === 'has_dirty') {
      if (openStorage_(w.client_id, 'dirty').length === 0) {
        addStorageEntry_(w.client_id, 'dirty', {});
      }
      if (w.status === 'no_linen') {
        w.status = 'planned';
        w.done_at = '';
        db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
      }
      logEvent(role, 'storage_check', washId, { verdict: verdict });
      return ok_({ wash: w });
    }
    w.status = verdict === 'no_dirty' ? 'no_linen' : 'ready_clean';
    w.done_at = nowStr_();
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    logEvent(role, 'storage_check', washId, { verdict: verdict });
    return ok_({ wash: w });
  });
}

function markIssued(token, washId) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    const check = checkTransition_('issue', found && found.obj);
    if (!check.ok) return err_(check.error);
    found.obj.status = 'issued';
    found.obj.issued_at = nowStr_();
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    // Чистая запись этой стирки уходит со склада
    db.findRowsBy_(SHEETS.STORAGE, function (s) {
      return s.wash_id === washId && s.kind === 'clean' && !s.consumed_at;
    }, 1000).forEach(function (r) {
      r.obj.consumed_at = found.obj.issued_at;
      db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
    });
    logEvent('owner', 'wash_issue', washId, {});
    return ok_({ wash: found.obj });
  });
}

// Правка issue_date у done/stored статус не меняет (spec §4.3).
function updateIssueDate(token, washId, issueDate) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.WASHES, washId);
    if (!found) return err_('Стирка не найдена');
    if (['done', 'stored'].indexOf(found.obj.status) === -1) {
      return err_('Менять дату выдачи можно только у завершённой стирки');
    }
    const old = found.obj.issue_date;
    found.obj.issue_date = issueDate;
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent('owner', 'wash_edit', washId, { issue_date: old + ' → ' + issueDate });
    return ok_({ wash: found.obj });
  });
}

// --- Канбан «Неделя»: планирование развозов ---
// Карточка = визит развоза (клиент в день D). Стирки дня формируются из развоза
// на завтра (см. getDayList). Хранение и права — в deliveries.js.

// Копия прошлой недели: planned-визиты со сдвигом +7 дней.
function copyPrevWeek_(monday) {
  const src = getVisitsByWeek_(addDaysStr_(monday, -7));
  src.forEach(function (v) {
    db.appendRow_(SHEETS.DELIVERIES, {
      id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: addDaysStr_(v.date, 7),
      client_id: v.client_id, ord: v.ord, status: 'planned',
      delivered_at: '', pickup: '', driver_comment: '',
      created_by: 'owner', created_at: nowStr_()
    });
  });
  if (src.length) logEvent('owner', 'week_copy', monday, { copied: src.length });
}

function getWeekPlan(token, monday) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  const mon = mondayOf_(monday || todayStr_());
  return withLock_(function () {
    let week = getVisitsByWeek_(mon);
    // Идемпотентная материализация: копируем прошлую неделю, только если эта пустая.
    if (!week.length) {
      copyPrevWeek_(mon);
      week = getVisitsByWeek_(mon);
    }
    const clients = {};
    db.getClients_().forEach(function (c) { clients[c.id] = c; });
    const storage = storageSummaryByClient_();
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDaysStr_(mon, i);
      days.push({
        date: d,
        cards: week.filter(function (v) { return v.date === d; })
          .sort(function (a, b) { return (Number(a.ord) || 0) - (Number(b.ord) || 0); })
          .map(function (v) { return decorateVisit_(v, clients, storage); })
      });
    }
    return ok_({ monday: mon, days: days,
      clients: db.getClients_().filter(function (c) { return c.active === 'да'; }) });
  });
}

function addWeekCard(token, clientId, date) {
  return deliveries.addDeliveryVisit(token, clientId, date);
}

function moveWeekCard(token, visitId, newDate) {
  return deliveries.moveDeliveryVisit(token, visitId, newDate);
}

function removeWeekCard(token, visitId) {
  return deliveries.removeDeliveryVisit(token, visitId);
}

function getStorage(token) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  const stored = db.findRowsBy_(SHEETS.WASHES, function (w) { return w.status === 'stored'; }, 1000)
    .map(function (r) {
      const w = r.obj;
      w.client_name = clientName_(w.client_id, clients);
      w.items = db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return wi.wash_id === w.id; }, 1000)
        .map(function (x) { return x.obj; });
      return w;
    });
  stored.sort(function (a, b) { return a.issue_date < b.issue_date ? -1 : 1; });
  // Складские записи: грязное (от водителя) и чистое (результат стирок), не израсходованные
  // Статусы и даты выдачи стирок — для раскладки clean-записей по секциям склада
  const washById = {};
  db.findRowsBy_(SHEETS.WASHES, function () { return true; }, 1000)
    .forEach(function (r) { washById[r.obj.id] = r.obj; });
  const open = db.findRowsBy_(SHEETS.STORAGE, function (s) { return !s.consumed_at; }, 2000)
    .map(function (r) {
      const s = r.obj;
      s.client_name = clientName_(s.client_id, clients);
      const w = washById[s.wash_id];
      s.wash_status = w ? w.status : '';
      s.issue_date = w ? w.issue_date : '';
      s.bags = w ? (Number(w.bags) || 0) : 0;
      return s;
    });
  // Остатки частичных стирок: clean-записи, чья стирка в статусе partial
  // (у done/stored-стирок clean-записи тоже есть — их не считаем остатками).
  return ok_({
    stored: stored,
    dirty: open.filter(function (s) { return s.kind === 'dirty'; }),
    clean: open.filter(function (s) { return s.kind === 'clean'; }),
    // cleanReady — чистое полностью завершённых (done) стирок: stored показываются карточками выше
    cleanReady: open.filter(function (s) { return s.kind === 'clean' && s.wash_status === 'done'; }),
    partialClean: open.filter(function (s) { return s.kind === 'clean' && s.wash_status === 'partial'; }),
    itemTypes: db.getItemTypes_()
  });
}

function getDayReport(token, date) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  const types = {};
  db.getItemTypes_().forEach(function (t) { types[t.id] = t.name; });
  const washes = db.findRowsBy_(SHEETS.WASHES, function () { return true; }, 1000)
    .map(function (r) { return r.obj; });
  const log = db.findRowsBy_(SHEETS.LOG, function () { return true; }, 1000).map(function (r) { return r.obj; });
  const report = buildDayReport_(date, washes, log);
  // Отчёт — только по стирке: выданные клиенту (issued) в таблицу не включаем
  const dayWashes = washes.filter(function (w) { return w.wash_date === date && w.status !== 'issued'; }).map(function (w) {
    w.client_name = clientName_(w.client_id, clients);
    w.items = db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return wi.wash_id === w.id; }, 1000)
      .map(function (x) {
        x.obj.item_name = types[x.obj.item_type_id] || x.obj.item_type_id;
        return x.obj;
      });
    return w;
  });
  const shift = getShiftByDate_(date);
  return ok_({ report: report, washes: sortDayList_(dayWashes), shift: shift ? shift.obj : null });
}

// --- Справочники (owner). Записи сбрасывают кэш (spec §10) ---

function saveClient(token, client) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    // Нормализация новых полей: item_types — JSON-массив id, accounting — weight|count|both
    if (client.item_types !== undefined) {
      client.item_types = Array.isArray(client.item_types) && client.item_types.length
        ? JSON.stringify(client.item_types) : '';
    }
    if (client.accounting !== undefined &&
        ['weight', 'count', 'both'].indexOf(client.accounting) === -1) {
      client.accounting = '';
    }
    let saved;
    if (client.id) {
      const found = db.findById_(SHEETS.CLIENTS, client.id);
      if (!found) return err_('Клиент не найден');
      Object.keys(client).forEach(function (k) { found.obj[k] = client[k]; });
      db.updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
      saved = found.obj;
    } else {
      saved = {
        id: db.nextId_(SHEETS.CLIENTS, 'cli'), name: client.name || '',
        contact: client.contact || '', address: client.address || '',
        type: client.type || 'прочее', storage: client.storage || 'нет',
        active: 'да', comment: client.comment || '',
        item_types: client.item_types || '', accounting: client.accounting || ''
      };
      db.appendRow_(SHEETS.CLIENTS, saved);
    }
    db.invalidateRefCache_();
    return ok_({ client: saved });
  });
}

// Удаление = архивация (active=нет, spec §7.3).
function deleteClient(token, clientId) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.CLIENTS, clientId);
    if (!found) return err_('Клиент не найден');
    found.obj.active = 'нет';
    db.updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
    db.invalidateRefCache_();
    return ok_({ client: found.obj });
  });
}

// Создавать новый тип («Другое…») может и работник с экрана стирки;
// переименование существующего — только владелец.
function saveItemType(token, itemType) {
  const roles = itemType && itemType.id ? ['owner'] : ['owner', 'worker'];
  if (!requireRole_(token, roles)) return err_('Нет доступа');
  return withLock_(function () {
    let saved;
    if (itemType.id) {
      const found = db.findById_(SHEETS.ITEM_TYPES, itemType.id);
      if (!found) return err_('Тип не найден');
      Object.keys(itemType).forEach(function (k) { found.obj[k] = itemType[k]; });
      db.updateRow_(SHEETS.ITEM_TYPES, found.rowNumber, found.obj);
      saved = found.obj;
    } else {
      let maxSort = 0;
      db.getItemTypes_().forEach(function (t) { maxSort = Math.max(maxSort, Number(t.sort) || 0); });
      saved = {
        id: db.nextId_(SHEETS.ITEM_TYPES, 'itm'), name: itemType.name || '',
        sort: maxSort + 1, active: 'да'
      };
      db.appendRow_(SHEETS.ITEM_TYPES, saved);
    }
    db.invalidateRefCache_();
    return ok_({ itemType: saved });
  });
}

// Работник с экрана стирки добавил вид белья и попросил запомнить его для клиента.
// Имеет смысл только когда у клиента уже настроен свой список (иначе показываются все типы).
function rememberClientItemType(token, clientId, itemTypeId) {
  if (!requireRole_(token, ['owner', 'worker'])) return err_('Нет доступа');
  return withLock_(function () {
    const found = db.findById_(SHEETS.CLIENTS, clientId);
    if (!found) return err_('Клиент не найден');
    const list = db.parseJsonList_(found.obj.item_types) || [];
    if (list.indexOf(itemTypeId) === -1) {
      list.push(itemTypeId);
      found.obj.item_types = JSON.stringify(list);
      db.updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
      db.invalidateRefCache_();
    }
    return ok_({ client: found.obj });
  });
}

// Полные справочники для экрана владельца (включая архивные).
function getRefs(token) {
  if (!requireRole_(token, ['owner'])) return err_('Нет доступа');
  return ok_({ clients: db.getClients_(), itemTypes: db.getItemTypes_() });
}

// --- TV-табло (spec §5.3): по ключу, только чтение, только агрегаты дня ---
function getTvData(key) {
  if (String(key) !== config.TV_KEY || !config.TV_KEY) {
    return err_('Нет доступа');
  }
  const today = todayStr_();
  const clients = {};
  db.getClients_().forEach(function (c) { clients[c.id] = c; });
  const washes = db.findRowsBy_(SHEETS.WASHES, function (w) { return isDayWash_(w, today); }, 1000)
    .map(function (r) { return r.obj; });
  const counters = { total: washes.length, planned: 0, in_progress: 0, done: 0, stored: 0, deferred: 0 };
  const cards = sortDayList_(washes).map(function (w) {
    if (counters[w.status] !== undefined) counters[w.status]++;
    if (w.deferred_from) counters.deferred++;
    return {
      client: clientName_(w.client_id, clients), status: w.status,
      kg: w.dirty_weight_kg || '', items: w.items_total || '',
      deferred_from: w.deferred_from || '', comment: w.comment || ''
    };
  });
  return ok_({
    date: today, laundryName: db.getSettings_().LAUNDRY_NAME || 'Прачечная PRO',
    counters: counters, washes: cards, updatedAt: timeStr_()
  });
}

// --- Экспорт и монтирование в Express ---

const { login, logout } = require('./auth');

// Публичные методы API: имя функции = имя метода (POST /api/<method>, тело { args: [...] }).
const api = {
  login, logout,
  getDayList, startWash, completeWash, editWashData, deferWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport,
  saveClient, deleteClient, saveItemType, rememberClientItemType, getRefs,
  getTvData,
  // Развозы и водитель (логика в deliveries.js)
  getDeliveryVisits: deliveries.getDeliveryVisits,
  addDeliveryVisit: deliveries.addDeliveryVisit,
  moveDeliveryVisit: deliveries.moveDeliveryVisit,
  removeDeliveryVisit: deliveries.removeDeliveryVisit,
  setPickupOnly: deliveries.setPickupOnly,
  getDriverRoute: deliveries.getDriverRoute,
  driverTakeAllClean: deliveries.driverTakeAllClean,
  driverAction: deliveries.driverAction,
  driverHandover: deliveries.driverHandover
};

function mountApi(app) {
  app.post('/api/:method', async (req, res) => {
    const fn = api[req.params.method];
    if (!fn) return res.status(404).json(err_('Неизвестный метод: ' + req.params.method));
    try {
      const args = (req.body && req.body.args) || [];
      const result = await fn.apply(null, args);
      res.json(result);
    } catch (e) {
      console.error('API ' + req.params.method + ' failed:', e);
      res.status(500).json(err_(String(e && e.message || e)));
    }
  });
}

module.exports = {
  mountApi, api,
  err_, ok_, withLock_, round1_, timeStr_,
  ensureShift_, getShiftByDate_, ensureWashesFromDelivery_, notReadyForDelivery_,
  getDayList, startWash, completeWash, editWashData, deferWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport,
  saveClient, deleteClient, saveItemType, rememberClientItemType, getRefs, getTvData,
  getDeliveryVisits: deliveries.getDeliveryVisits,
  addDeliveryVisit: deliveries.addDeliveryVisit,
  moveDeliveryVisit: deliveries.moveDeliveryVisit,
  removeDeliveryVisit: deliveries.removeDeliveryVisit,
  setPickupOnly: deliveries.setPickupOnly,
  getDriverRoute: deliveries.getDriverRoute,
  driverTakeAllClean: deliveries.driverTakeAllClean,
  driverAction: deliveries.driverAction,
  driverHandover: deliveries.driverHandover
};
