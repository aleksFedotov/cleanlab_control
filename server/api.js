// Серверное API (spec §6) — порт src/Api.gs. Каждая функция принимает токен первым параметром.
// Мультитенантность: прачка берётся из сессии (session.laundryId), все чтения/записи
// операционных таблиц фильтруются по ней; строка чужой прачки для API не существует.
// LockService не нужен: однопроцессный Node + синхронный better-sqlite3.
// Express-монтирование: каждая публичная функция → POST /api/<имя>, тело { args: [...] }.
const { SHEETS } = require('./schema');
const crypto = require('node:crypto');
const db = require('./db');
const time = require('./util/time');
const { nowStr_, todayStr_, logEvent, actorOf_ } = require('./audit');
const { requireRole_, hashPassword_ } = require('./auth');
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

// Поиск строки по id с проверкой тенанта: чужая прачка = «не найдено».
function findTenantRow_(sheet, id, laundryId) {
  const found = db.findById_(sheet, id);
  if (!found || found.obj.laundry_id !== String(laundryId)) return null;
  return found;
}

// Смена создаётся автоматически при первом действии (upsert по дате, spec §3.7).
function ensureShift_(date, laundryId) {
  const found = db.findRowsByTenant_(SHEETS.SHIFTS, function (s) { return s.date === date; }, 500, laundryId);
  if (found.length) return found[found.length - 1].obj;
  const shift = {
    id: db.nextId_(SHEETS.SHIFTS, 'shift'), date: date, status: 'open',
    opened_at: nowStr_(), closed_at: '', total_kg: '', washes_done: '',
    washes_deferred: '', digest_sent: ''
  };
  db.appendRowTenant_(SHEETS.SHIFTS, shift, laundryId);
  return shift;
}

function getShiftByDate_(date, laundryId) {
  const found = db.findRowsByTenant_(SHEETS.SHIFTS, function (s) { return s.date === date; }, 500, laundryId);
  return found.length ? found[found.length - 1] : null;
}

// --- Общие чтения ---

// Автоформирование стирок дня из завтрашнего развоза: клиент в развозе на
// date+1 → плановая стирка сегодня (выдача завтра). Идемпотентно.
function ensureWashesFromDelivery_(date, laundryId) {
  const nextDay = addDaysStr_(date, 1);
  const visits = getVisitsByDate_(nextDay, laundryId);
  if (!visits.length) return;
  // Отменённые тоже считаем «существующими»: иначе стирка, снятая подтверждением
  // «белья нет на складе» (или отмена владельца), будет пересоздана при следующем чтении.
  const dayWashes = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
    return w.wash_date === date;
  }, 1000, laundryId).map(function (r) { return r.obj; });
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
    db.appendRowTenant_(SHEETS.WASHES, w, laundryId);
    dayWashes.push(w);
    logEvent('auto', 'wash_create', w.id, { client_id: v.client_id, from_visit: v.id }, laundryId);
  });
}

function getDayList(token, date) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  date = date || todayStr_();
  return withLock_(function () {
    ensureWashesFromDelivery_(date, laundryId);
    const clients = {};
    db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
    const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
      return isDayWash_(w, date);
    }, 1000, laundryId).map(function (r) { return r.obj; });
    const shift = getShiftByDate_(date, laundryId);
    const storage = storageSummaryByClient_(laundryId);
    return ok_({
      date: date,
      laundryName: db.getSettings_(laundryId).LAUNDRY_NAME || 'Прачечная PRO',
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
      clients: db.getClients_(laundryId).filter(function (c) { return c.active === 'да'; }),
      itemTypes: db.getItemTypes_().filter(function (t) { return t.active === 'да'; })
    });
  });
}

// --- Сотрудник ---

function startWash(token, washId, weightKg) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
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
    consumeStorage_(w.client_id, 'dirty', laundryId);
    ensureShift_(w.wash_date, laundryId);
    logEvent(actorOf_(session), 'wash_start', washId, { weight: w.dirty_weight_kg }, laundryId);
    return ok_({ wash: w });
  });
}

function completeWash(token, washId, items, weightKg, mode, bags) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
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
    }, laundryId);
    ensureShift_(w.wash_date, laundryId);
    logEvent(actorOf_(session), 'wash_done', washId, { status: w.status, items: valid, kg: w.dirty_weight_kg, bags: w.bags }, laundryId);
    return ok_({ wash: w });
  });
}

// Правка веса/пересчёта/мешков завершённой (spec §4.2): статус и done_at не меняются.
function editWashData(token, washId, weightKg, items, bags) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    if (!found) return err_('Стирка не найдена');
    const w = found.obj;
    const shift = getShiftByDate_(w.wash_date, laundryId);
    if (!canEditWashData_(session.role, w, shift && shift.obj)) {
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
    const st = db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
      return s.wash_id === washId && s.kind === 'clean' && !s.consumed_at;
    }, 1000, laundryId);
    if (st.length) {
      st[0].obj.weight_kg = w.dirty_weight_kg;
      st[0].obj.items_total = total;
      db.updateRow_(SHEETS.STORAGE, st[0].rowNumber, st[0].obj);
    }
    logEvent(actorOf_(session), 'wash_edit', washId, { old: old, now: { kg: w.dirty_weight_kg, items_total: total, bags: w.bags } }, laundryId);
    return ok_({ wash: w });
  });
}

function deferWash(token, washId, newDate, reason) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const actor = actorOf_(session);
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
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
      if (openStorage_(w.client_id, 'dirty', laundryId).length === 0) {
        addStorageEntry_(w.client_id, 'dirty', {}, laundryId);
      }
      // Визит развоза едет следом: «завтра» → «послезавтра». Только planned и
      // только если на целевую дату у клиента ещё нет визита.
      const visit = getVisitsByDate_(oldIssueDate, laundryId).filter(function (x) {
        return x.client_id === w.client_id && x.status === 'planned';
      })[0];
      const dup = getVisitsByDate_(newIssueDate, laundryId).some(function (x) {
        return x.client_id === w.client_id;
      });
      if (visit && !dup) {
        const vf = db.findById_(SHEETS.DELIVERIES, visit.id);
        vf.obj.date = newIssueDate;
        db.updateRow_(SHEETS.DELIVERIES, vf.rowNumber, vf.obj);
        logEvent(actor, 'visit_move', visit.id, { date: oldIssueDate + ' → ' + newIssueDate, reason: 'wash_defer' }, laundryId);
        details.visit_moved = true;
      } else {
        details.visit_moved = false;
      }
    }
    logEvent(actor, 'wash_defer', washId, details, laundryId);
    Object.keys(patch).forEach(function (k) { w[k] = patch[k]; });
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    return ok_({ wash: w });
  });
}

// Внеплановая стирка из цеха: сегодня, выдача завтра, created_by по роли.
function addUnplannedWash(token, clientId, comment) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const today = todayStr_();
    // Не дублируем: у клиента уже есть открытая стирка на сегодня
    const dup = db.findRowsByTenant_(SHEETS.WASHES, function (x) {
      return x.client_id === clientId && x.wash_date === today &&
        ['planned', 'no_linen', 'in_progress'].indexOf(x.status) !== -1;
    }, 100, laundryId).length;
    if (dup) return err_('Стирка этого клиента уже в плане на сегодня');
    const w = {
      id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: today, issue_date: addDaysStr_(today, 1), status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: comment || '',
      created_by: session.role, created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    db.appendRowTenant_(SHEETS.WASHES, w, laundryId);
    ensureShift_(today, laundryId);
    logEvent(actorOf_(session), 'wash_create', w.id, { client_id: clientId, unplanned: true }, laundryId);
    return ok_({ wash: w });
  });
}

function getShiftCloseState(token) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const today = todayStr_();
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) { return w.wash_date === today; }, 1000, laundryId)
    .map(function (r) { return r.obj; });
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const blockers = shiftBlockers_(washes, today).map(function (w) {
    w.client_name = clientName_(w.client_id, clients);
    return w;
  });
  const log = db.readTailByTenant_(SHEETS.LOG, 1000, laundryId);
  return ok_({
    date: today,
    blockers: blockers,
    notReady: notReadyForDelivery_(addDaysStr_(today, 1), laundryId),
    report: buildDayReport_(today, washes, log),
    shift: getShiftByDate_(today, laundryId) ? getShiftByDate_(today, laundryId).obj : null
  });
}

// Клиенты развоза на date без готового чистого белья. Обслуженные точки
// (закрытый визит или чистое уже у водителя) пропускаем — предупреждать не о чем.
// Причины: washing_incomplete (стирка дня подготовки не завершена),
// partial (завершена частично), no_clean (нет чистого на складе).
function notReadyForDelivery_(date, laundryId) {
  const visits = getVisitsByDate_(date, laundryId);
  if (!visits.length) return [];
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const storage = storageSummaryByClient_(laundryId);
  const prepDay = addDaysStr_(date, -1);
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
    return w.status !== 'cancelled';
  }, 2000, laundryId).map(function (r) { return r.obj; });
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
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const today = todayStr_();
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) { return w.wash_date === today; }, 1000, laundryId)
    .map(function (r) { return r.obj; });
  const blockers = shiftBlockers_(washes, today);
  if (blockers.length && !force) {
    return err_('Есть незавершённые стирки: ' + blockers.map(function (w) { return w.id; }).join(', '));
  }
  let shift = getShiftByDate_(today, laundryId) || (function () {
    ensureShift_(today, laundryId);
    return getShiftByDate_(today, laundryId);
  })();
  if (shift.obj.status === 'closed') return err_('Смена уже закрыта');
  const log = db.readTailByTenant_(SHEETS.LOG, 1000, laundryId);
  const report = buildDayReport_(today, washes, log);
  const s = shift.obj;
  s.status = 'closed';
  s.closed_at = timeStr_();
  s.total_kg = report.totalKg;
  s.washes_done = report.washesDone;
  s.washes_deferred = report.deferred;
  db.updateRow_(SHEETS.SHIFTS, shift.rowNumber, s);
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  logEvent(actorOf_(session), 'shift_close', s.id, { total_kg: s.total_kg, washes_done: s.washes_done,
    unfinished: blockers.map(function (w) { return w.id; }) }, laundryId);
  // Дайджест (spec §8.3): fallback уже отправил → только короткое подтверждение;
  // иначе — полный дайджест. Дайджест и чат владельца — per-tenant.
  const tg = require('./telegram');
  if (String(s.digest_sent) === 'да') {
    tg.sendTelegram_(null, 'Смена закрыта в ' + s.closed_at + ' ✓', laundryId).catch(function () {});
  } else {
    await tg.sendDigestLocked_(today, laundryId);
  }
  // Предупреждение владельцу: смена закрыта с незавершёнными стирками
  if (blockers.length) {
    tg.sendTelegram_(null, '⚠ Смена ' + today + ' закрыта с незавершёнными стирками:\n' +
      blockers.map(function (w) {
        return '• ' + clientName_(w.client_id, clients) + ' — ' + (w.status === 'in_progress' ? 'в работе' : 'не начата');
      }).join('\n') +
      '\nПеренести их на другой день может только владелец.', laundryId).catch(function () {});
  }
  // Предупреждение владельцу: кто не готов к завтрашнему развозу
  const notReady = notReadyForDelivery_(addDaysStr_(today, 1), laundryId);
  if (notReady.length) {
    const REASONS = { washing_incomplete: 'стирка не завершена', partial: 'стирка частичная', no_clean: 'нет чистого белья' };
    tg.sendTelegram_(null, '⚠ К развозу на ' + addDaysStr_(today, 1) + ' не готовы:\n' +
      notReady.map(function (n) { return '• ' + n.client_name + ' — ' + REASONS[n.reason]; }).join('\n'),
      laundryId).catch(function () {});
  }
  return ok_({ shift: s, report: report, notReady: notReady });
}

// --- Владелец ---

function getDeliveryPlan(token, date) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const all = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
    return w.wash_date === date || w.issue_date === date;
  }, 1000, laundryId).map(function (r) { return r.obj; });
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
    clients: db.getClients_(laundryId).filter(function (c) { return c.active === 'да'; })
  });
}

function addToDelivery(token, clientId, washDate, issueDate, comment) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const w = {
      id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: washDate, issue_date: issueDate, status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: comment || '',
      created_by: 'owner', created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    db.appendRowTenant_(SHEETS.WASHES, w, laundryId);
    logEvent(actorOf_(session), 'wash_create', w.id, { client_id: clientId, wash_date: washDate, issue_date: issueDate }, laundryId);
    return ok_({ wash: w });
  });
}

function cancelWash(token, washId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    const check = checkTransition_('cancel', found && found.obj);
    if (!check.ok) return err_(check.error);
    found.obj.status = 'cancelled';
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent(actorOf_(session), 'wash_cancel', washId, {}, laundryId);
    return ok_({ wash: found.obj });
  });
}

// Полное удаление ошибочно созданной стирки (owner). В отличие от отмены,
// запись исчезает из отчётов совсем. Разрешено для любой невыданной стирки:
// у завершённых (done/stored/partial) заодно удаляются позиции и складские
// строки этой стирки (в т.ч. израсходованные — бельё «убирается» из учёта).
// Выданную клиенту (issued) удалять нельзя — это уже факт выдачи.
function deleteWash(token, washId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
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
    logEvent(actorOf_(session), 'wash_delete', washId, {
      client_id: w.client_id, wash_date: w.wash_date, status: w.status,
      kg: w.dirty_weight_kg, items_total: w.items_total
    }, laundryId);
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
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const VERDICTS = { no_dirty: 1, already_clean: 1, has_dirty: 1 };
  if (!VERDICTS[verdict]) return err_('Неизвестный verdict');
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    if (!found) return err_('Стирка не найдена');
    const w = found.obj;
    if (w.status !== 'planned' && w.status !== 'no_linen') {
      return err_('Подтверждение возможно только для стирки «К работе»');
    }
    if (verdict === 'has_dirty') {
      if (openStorage_(w.client_id, 'dirty', laundryId).length === 0) {
        addStorageEntry_(w.client_id, 'dirty', {}, laundryId);
      }
      if (w.status === 'no_linen') {
        w.status = 'planned';
        w.done_at = '';
        db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
      }
      logEvent(actorOf_(session), 'storage_check', washId, { verdict: verdict }, laundryId);
      return ok_({ wash: w });
    }
    w.status = verdict === 'no_dirty' ? 'no_linen' : 'ready_clean';
    w.done_at = nowStr_();
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    logEvent(actorOf_(session), 'storage_check', washId, { verdict: verdict }, laundryId);
    return ok_({ wash: w });
  });
}

function markIssued(token, washId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    const check = checkTransition_('issue', found && found.obj);
    if (!check.ok) return err_(check.error);
    found.obj.status = 'issued';
    found.obj.issued_at = nowStr_();
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    // Чистая запись этой стирки уходит со склада
    db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
      return s.wash_id === washId && s.kind === 'clean' && !s.consumed_at;
    }, 1000, laundryId).forEach(function (r) {
      r.obj.consumed_at = found.obj.issued_at;
      db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
    });
    logEvent(actorOf_(session), 'wash_issue', washId, {}, laundryId);
    return ok_({ wash: found.obj });
  });
}

// Правка issue_date у done/stored статус не меняет (spec §4.3).
function updateIssueDate(token, washId, issueDate) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    if (!found) return err_('Стирка не найдена');
    if (['done', 'stored'].indexOf(found.obj.status) === -1) {
      return err_('Менять дату выдачи можно только у завершённой стирки');
    }
    const old = found.obj.issue_date;
    found.obj.issue_date = issueDate;
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent(actorOf_(session), 'wash_edit', washId, { issue_date: old + ' → ' + issueDate }, laundryId);
    return ok_({ wash: found.obj });
  });
}

// --- Канбан «Неделя»: планирование развозов ---
// Карточка = визит развоза (клиент в день D). Стирки дня формируются из развоза
// на завтра (см. getDayList). Хранение и права — в deliveries.js.

// Копия прошлой недели: planned-визиты со сдвигом +7 дней.
function copyPrevWeek_(monday, laundryId, actor) {
  const src = getVisitsByWeek_(addDaysStr_(monday, -7), laundryId);
  src.forEach(function (v) {
    db.appendRowTenant_(SHEETS.DELIVERIES, {
      id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: addDaysStr_(v.date, 7),
      client_id: v.client_id, ord: v.ord, status: 'planned',
      delivered_at: '', pickup: '', driver_comment: '',
      created_by: 'owner', created_at: nowStr_()
    }, laundryId);
  });
  if (src.length) logEvent(actor, 'week_copy', monday, { copied: src.length }, laundryId);
}

function getWeekPlan(token, monday) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const mon = mondayOf_(monday || todayStr_());
  return withLock_(function () {
    let week = getVisitsByWeek_(mon, laundryId);
    // Идемпотентная материализация: копируем прошлую неделю, только если эта пустая.
    if (!week.length) {
      copyPrevWeek_(mon, laundryId, actorOf_(session));
      week = getVisitsByWeek_(mon, laundryId);
    }
    const clients = {};
    db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
    const storage = storageSummaryByClient_(laundryId);
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
      clients: db.getClients_(laundryId).filter(function (c) { return c.active === 'да'; }) });
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
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const stored = db.findRowsByTenant_(SHEETS.WASHES, function (w) { return w.status === 'stored'; }, 1000, laundryId)
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
  db.findRowsByTenant_(SHEETS.WASHES, function () { return true; }, 1000, laundryId)
    .forEach(function (r) { washById[r.obj.id] = r.obj; });
  const open = db.findRowsByTenant_(SHEETS.STORAGE, function (s) { return !s.consumed_at; }, 2000, laundryId)
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
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const types = {};
  db.getItemTypes_().forEach(function (t) { types[t.id] = t.name; });
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function () { return true; }, 1000, laundryId)
    .map(function (r) { return r.obj; });
  const log = db.readTailByTenant_(SHEETS.LOG, 1000, laundryId);
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
  const shift = getShiftByDate_(date, laundryId);
  return ok_({ report: report, washes: sortDayList_(dayWashes), shift: shift ? shift.obj : null });
}

// --- Справочники (owner). Записи сбрасывают кэш (spec §10) ---

function saveClient(token, client) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
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
      const found = findTenantRow_(SHEETS.CLIENTS, client.id, laundryId);
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
      db.appendRowTenant_(SHEETS.CLIENTS, saved, laundryId);
    }
    db.invalidateRefCache_();
    return ok_({ client: saved });
  });
}

// Удаление = архивация (active=нет, spec §7.3).
function deleteClient(token, clientId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
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
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
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
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  return ok_({ clients: db.getClients_(session.laundryId), itemTypes: db.getItemTypes_() });
}

// --- Прачки (owner): вкладка «Прачки» ---

// Список активных прачек с TV-ключами (per-tenant Settings). Owner-only:
// раньше метод был публичным для выбора прачки на входе, но вход теперь
// по логину+паролю без выбора прачки — список нужен только владельцу.
function listLaundries(token) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundries = db.readAll_('Laundries')
    .filter(function (l) { return l.active === 'да'; })
    .map(function (l) {
      return { id: l.id, name: l.name, tvKey: db.getSettings_(l.id).TV_KEY || '' };
    });
  return ok_({ laundries: laundries });
}

// Новая прачка из веб-интерфейса (без ENV-сида). TV-ключ табла генерируется
// случайно и кладётся в per-tenant Settings новой прачки.
function createLaundry(token, data) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const name = String((data && data.name) || '').trim();
  if (!name) return err_('Укажите название прачки');
  return withLock_(function () {
    let maxId = 0;
    db.readAll_('Laundries').forEach(function (l) { maxId = Math.max(maxId, Number(l.id) || 0); });
    const laundry = { id: String(maxId + 1), name: name, active: 'да' };
    db.appendRow_('Laundries', laundry);
    db.setTenantSetting_(laundry.id, 'LAUNDRY_NAME', name);
    const tvKey = crypto.randomBytes(12).toString('hex');
    db.setTenantSetting_(laundry.id, 'TV_KEY', tvKey);
    db.invalidateRefCache_();
    logEvent(actorOf_(session), 'laundry_create', laundry.id, { name: name }, session.laundryId);
    return ok_({ laundry: { id: laundry.id, name: name }, tvKey: tvKey });
  });
}

// Переименование прачки: запись в Laundries + per-tenant Settings LAUNDRY_NAME.
function updateLaundry(token, data) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const name = String((data && data.name) || '').trim();
  if (!name) return err_('Укажите название прачки');
  const found = db.findById_('Laundries', data && data.id);
  if (!found) return err_('Прачка не найдена');
  found.obj.name = name;
  db.updateRow_('Laundries', found.rowNumber, found.obj);
  db.setTenantSetting_(found.obj.id, 'LAUNDRY_NAME', name);
  db.invalidateRefCache_();
  logEvent(actorOf_(session), 'laundry_update', found.obj.id, { name: name }, session.laundryId);
  return ok_({ laundry: { id: found.obj.id, name: name } });
}

// Деактивация прачки: данные не удаляются, прачка пропадает из списков.
// Нельзя деактивировать активную прачку текущей сессии и последнюю активную.
function deactivateLaundry(token, id) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const found = db.findById_('Laundries', id);
  if (!found) return err_('Прачка не найдена');
  if (String(id) === String(session.laundryId)) {
    return err_('Нельзя отключить активную прачку — переключитесь на другую');
  }
  const activeCount = db.readAll_('Laundries').filter(function (l) { return l.active === 'да'; }).length;
  if (activeCount <= 1) return err_('Нельзя отключить последнюю активную прачку');
  found.obj.active = 'нет';
  db.updateRow_('Laundries', found.rowNumber, found.obj);
  db.invalidateRefCache_();
  logEvent(actorOf_(session), 'laundry_deactivate', id, { name: found.obj.name }, session.laundryId);
  return ok_({ laundry: found.obj });
}

// --- Пользователи (owner): экран «Сотрудники» ---

// Список пользователей прачки (по умолчанию — активной в сессии) + владельцы.
// Отдаём и неактивных (active=нет) — UI их помечает и предлагает «Включить».
// pass_hash/pin из ответа убираем: клиенту хэши не нужны.
function listUsers(token, laundryId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const lid = String(laundryId || session.laundryId);
  const users = db.readAll_('Users').filter(function (u) {
    return u.laundry_id === lid || u.role === 'owner';
  }).map(function (u) {
    return { id: u.id, laundry_id: u.laundry_id, name: u.name, role: u.role,
      login: u.login, active: u.active, client_id: u.client_id };
  });
  return ok_({ users: users });
}

// Создание аккаунта. Логин глобально уникален (вход — только по логину+паролю,
// без выбора прачки). Пароль хранится как scrypt-хэш (util/passwords.js).
// Роль client (задел) требует clientId — ссылку на клиента справочника.
function createUser(token, user) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  user = user || {};
  const ROLES = ['owner', 'worker', 'driver', 'client'];
  if (ROLES.indexOf(user.role) === -1) return err_('Неизвестная роль');
  if (!user.name) return err_('Укажите имя');
  if (!user.login) return err_('Укажите логин');
  if (!user.password) return err_('Укажите пароль');
  if (user.role !== 'owner' && !user.laundryId) return err_('Укажите прачку');
  if (user.role === 'client' && !user.clientId) return err_('Выберите клиента');
  const login = String(user.login).trim();
  const taken = db.readAll_('Users').some(function (u) {
    return u.active === 'да' && u.login === login;
  });
  if (taken) return err_('Логин уже занят');
  const saved = {
    id: db.nextId_('Users', 'usr'),
    laundry_id: user.role === 'owner' ? '' : String(user.laundryId),
    name: user.name, role: user.role, pin: '', active: 'да',
    client_id: user.role === 'client' ? String(user.clientId) : '',
    login: login, pass_hash: hashPassword_(user.password)
  };
  db.appendRow_('Users', saved);
  logEvent(actorOf_(session), 'user_create', saved.id, { name: saved.name, role: saved.role, laundry_id: saved.laundry_id }, session.laundryId);
  return ok_({ user: { id: saved.id, laundry_id: saved.laundry_id, name: saved.name, role: saved.role, login: saved.login, active: saved.active, client_id: saved.client_id } });
}

// Сброс пароля пользователя (owner): новый пароль хэшируется, старый перезаписывается.
function resetUserPassword(token, userId, newPassword) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  if (!newPassword) return err_('Укажите пароль');
  const found = db.findById_('Users', userId);
  if (!found) return err_('Пользователь не найден');
  found.obj.pass_hash = hashPassword_(newPassword);
  db.updateRow_('Users', found.rowNumber, found.obj);
  logEvent(actorOf_(session), 'user_password_reset', userId, { name: found.obj.name }, session.laundryId);
  return ok_({ user: found.obj });
}

// Правка аккаунта: имя, роль, логин, clientId (при роли client). Пароль не
// трогаем — для этого resetUserPassword. Логин глобально уникален (кроме самого
// пользователя). Нельзя менять роль самому себе (owner по своему userId).
function updateUser(token, user) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  user = user || {};
  const found = db.findById_('Users', user.id);
  if (!found) return err_('Пользователь не найден');
  const ROLES = ['owner', 'worker', 'driver', 'client'];
  if (user.role !== undefined && ROLES.indexOf(user.role) === -1) return err_('Неизвестная роль');
  if (user.name !== undefined && !String(user.name).trim()) return err_('Укажите имя');
  if (String(user.id) === String(session.userId) && user.role !== undefined && user.role !== found.obj.role) {
    return err_('Нельзя изменить роль самому себе');
  }
  const u = found.obj;
  if (user.name !== undefined) u.name = String(user.name).trim();
  if (user.role !== undefined) u.role = user.role;
  if (user.login !== undefined) {
    const login = String(user.login).trim();
    if (!login) return err_('Укажите логин');
    const taken = db.readAll_('Users').some(function (x) {
      return x.active === 'да' && x.login === login && x.id !== u.id;
    });
    if (taken) return err_('Логин уже занят');
    u.login = login;
  }
  // Роль client требует ссылку на клиента; у остальных ролей client_id пуст
  if (user.clientId !== undefined || user.role !== undefined) {
    const cid = user.clientId !== undefined ? user.clientId : u.client_id;
    if (u.role === 'client') {
      if (!cid) return err_('Выберите клиента');
      u.client_id = String(cid);
    } else {
      u.client_id = '';
    }
  }
  db.updateRow_('Users', found.rowNumber, u);
  logEvent(actorOf_(session), 'user_update', u.id, { name: u.name, role: u.role, login: u.login }, session.laundryId);
  return ok_({ user: { id: u.id, laundry_id: u.laundry_id, name: u.name, role: u.role, login: u.login, active: u.active, client_id: u.client_id } });
}

function deactivateUser(token, id) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  if (String(id) === String(session.userId)) return err_('Нельзя отключить самого себя');
  const found = db.findById_('Users', id);
  if (!found) return err_('Пользователь не найден');
  found.obj.active = 'нет';
  db.updateRow_('Users', found.rowNumber, found.obj);
  logEvent(actorOf_(session), 'user_deactivate', id, { name: found.obj.name }, session.laundryId);
  return ok_({ user: found.obj });
}

// Возврат доступа отключённому пользователю (пара к deactivateUser).
function reactivateUser(token, id) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const found = db.findById_('Users', id);
  if (!found) return err_('Пользователь не найден');
  found.obj.active = 'да';
  db.updateRow_('Users', found.rowNumber, found.obj);
  logEvent(actorOf_(session), 'user_reactivate', id, { name: found.obj.name }, session.laundryId);
  return ok_({ user: found.obj });
}

// Одноразовые коды привязки Telegram-чата (в памяти процесса, TTL 10 мин).
// Код генерирует владелец с экрана «Сотрудники»; бот принимает код и пишет
// chat_id в per-tenant Settings OWNER_CHAT_ID прачки, к которой привязан код.
const TG_CODE_TTL_MS = 10 * 60 * 1000;
const telegramBindCodes = new Map(); // code → { laundryId, expiresAt }

function makeTelegramBindCode(token) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  // Уборка протухших, чтобы Map не рос
  const now = Date.now();
  for (const [c, rec] of telegramBindCodes) if (rec.expiresAt < now) telegramBindCodes.delete(c);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  telegramBindCodes.set(code, { laundryId: session.laundryId, expiresAt: now + TG_CODE_TTL_MS });
  return ok_({ code: code });
}

// Проверка и погашение кода (вызывается из telegram.js при сообщении боту).
// Возвращает laundryId при успехе, null — код невалиден или протух.
function consumeTelegramBindCode_(code) {
  const rec = telegramBindCodes.get(String(code));
  if (!rec || Date.now() > rec.expiresAt) return null;
  telegramBindCodes.delete(String(code));
  return rec.laundryId;
}

// --- TV-табло (spec §5.3): по ключу прачки, только чтение, только агрегаты дня ---
// Ключ ищется в per-tenant Settings (TV_KEY), данные — только той прачки.
function getTvData(key) {
  if (!key) return err_('Нет доступа');
  const row = db.readAll_('Settings').filter(function (r) {
    return r.key === 'TV_KEY' && r.laundry_id && r.value === String(key);
  })[0];
  if (!row) return err_('Нет доступа');
  const laundryId = row.laundry_id;
  const today = todayStr_();
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) { return isDayWash_(w, today); }, 1000, laundryId)
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
    date: today, laundryName: db.getSettings_(laundryId).LAUNDRY_NAME || 'Прачечная PRO',
    counters: counters, washes: cards, updatedAt: timeStr_()
  });
}

// --- Экспорт и монтирование в Express ---

const { login, logout, switchLaundry } = require('./auth');

// Публичные методы API: имя функции = имя метода (POST /api/<method>, тело { args: [...] }).
const api = {
  login, logout, switchLaundry, listLaundries, createLaundry, updateLaundry, deactivateLaundry,
  getDayList, startWash, completeWash, editWashData, deferWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport,
  saveClient, deleteClient, saveItemType, rememberClientItemType, getRefs,
  listUsers, createUser, updateUser, resetUserPassword, deactivateUser, reactivateUser, makeTelegramBindCode,
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
  login, logout, switchLaundry, listLaundries, createLaundry, updateLaundry, deactivateLaundry,
  ensureShift_, getShiftByDate_, ensureWashesFromDelivery_, notReadyForDelivery_,
  getDayList, startWash, completeWash, editWashData, deferWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport,
  saveClient, deleteClient, saveItemType, rememberClientItemType, getRefs,
  listUsers, createUser, updateUser, resetUserPassword, deactivateUser, reactivateUser, makeTelegramBindCode,
  consumeTelegramBindCode_, getTvData,
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
