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
  err_, ok_, round1_, clientName_, resolveBillingItemForType_
} = core;
const { addStorageEntry_, openStorage_, consumeStorage_, storageSummaryByClient_ } = require('./storage');
const deliveries = require('./deliveries');
const workhours = require('./workhours');
const payroll = require('./payroll');
const { getVisitsByDate_, getVisitsByWeek_, decorateVisit_, isOpenVisit_, ensureVisit_ } = deliveries;

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

// Уведомление владельцу в Telegram о действиях работника со стирками
// (добавление/перенос/удаление). Действия самого владельца не шлём.
function notifyOwnerOnWorkerAction_(session, text, laundryId) {
  if (session.role !== 'worker') return;
  require('./telegram').sendTelegram_(null, text, laundryId).catch(function () {});
}

function clientNameById_(clientId, laundryId) {
  const c = db.getClients_(laundryId).filter(function (x) { return x.id === clientId; })[0];
  return c ? c.name : clientId;
}

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
    // WashItems грузим один раз для всех стирок дня: planned/in_progress — это
    // признак «остаток частичной стирки» (partial_rest), у завершённых — состав
    // постиранного (items), чтобы работник мог исправить ошибочное завершение.
    const dayIds = {};
    washes.forEach(function (w) {
      if (w.status !== 'cancelled') dayIds[w.id] = true;
    });
    const prevItems = {};
    db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return !!dayIds[wi.wash_id]; }, 1000)
      .forEach(function (r) {
        (prevItems[r.obj.wash_id] = prevItems[r.obj.wash_id] || []).push(r.obj);
      });
    const types = {};
    db.getItemTypes_().forEach(function (t) { types[t.id] = t.name; });
    // P2: типы белья, идущие в счёт поштучно — работник должен отобрать их до взвешивания.
    // Эффективная привязка: ClientItemBilling ?? ItemTypes.billing_item_id (core.resolveBillingItemForType_).
    const itemTypesById = {};
    db.getItemTypes_().forEach(function (t) { itemTypesById[t.id] = t; });
    const pieceBillingById = {};
    db.readAll_(SHEETS.BILLING_ITEMS).forEach(function (b) {
      if (b.kind === 'wash_pcs' && b.active === 'да') pieceBillingById[b.id] = true;
    });
    const clientBindings = db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function () { return true; }, 10000, laundryId)
      .map(function (r) { return r.obj; });
    const pieceTypesFor_ = function (clientId, typeIds) {
      const out = [];
      typeIds.forEach(function (tid) {
        const bid = resolveBillingItemForType_(clientId, tid, clientBindings, itemTypesById);
        if (bid && pieceBillingById[bid] && itemTypesById[tid]) out.push(itemTypesById[tid].name);
      });
      return out;
    };
    const mapItem = function (wi) {
      return {
        item_type_id: wi.item_type_id,
        qty: Number(wi.qty) || 0,
        item_name: types[wi.item_type_id] || wi.item_type_id
      };
    };
    return ok_({
      date: date,
      laundryName: db.getSettings_(laundryId).LAUNDRY_NAME || 'CleanLab Pro',
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
        // Пустой список типов у клиента = все типы (как в формах стирки)
        w.piece_types = pieceTypesFor_(w.client_id,
          w.client_item_types && w.client_item_types.length ? w.client_item_types : Object.keys(itemTypesById));
        // Остаток частичной стирки: показываем, что часть уже постирана
        const prev = prevItems[w.id];
        if (prev && prev.length) {
          if (w.status === 'planned' || w.status === 'in_progress') {
            w.partial_rest = true;
            w.prev_items = prev.map(mapItem);
            w.prev_kg = w.dirty_weight_kg;
            w.prev_bags = w.bags;
          } else {
            // Состав постиранного у завершённых — для правки с экрана работника
            w.items = prev.map(mapItem);
          }
        }
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
    // Грязное бельё клиента уходит со склада в стирку; wash_id на израсходованных
    // записях — связь партии для веса ноги-забора в счёте (P2)
    consumeStorage_(w.client_id, 'dirty', laundryId, w.id);
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
    // Достирка остатка частичной стирки (у стирки уже есть WashItems — их пишет
    // только завершение): итоги суммируем с первой частью, иначе затирались бы.
    const prevTotal = db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) {
      return wi.wash_id === washId;
    }, 1000).length - valid.length > 0;
    if (prevTotal) {
      w.items_total = (Number(w.items_total) || 0) + total;
      w.bags = (Number(w.bags) || 0) + Math.max(0, Math.floor(Number(bags) || 0));
      w.dirty_weight_kg = round1_((Number(w.dirty_weight_kg) || 0) + Number(weightKg));
    } else {
      w.items_total = total;
      w.bags = Math.max(0, Math.floor(Number(bags) || 0)); // мешков получилось после стирки
      w.dirty_weight_kg = round1_(weightKg);
    }
    w.done_at = nowStr_();
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    // Результат стирки — чистое бельё на складе (достирка добавляет вторую clean-запись)
    addStorageEntry_(w.client_id, 'clean', {
      weight_kg: round1_(weightKg), items_total: total, wash_id: washId
    }, laundryId);
    ensureShift_(w.wash_date, laundryId);
    logEvent(actorOf_(session), 'wash_done', washId, { status: w.status, items: valid, kg: w.dirty_weight_kg, bags: w.bags, rest: prevTotal || undefined }, laundryId);
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
    // Смена дня гарантированно существует: иначе правка упиралась бы в «смена
    // закрыта», если стирка завершена, а смена по какой-то причине не открыта
    ensureShift_(w.wash_date, laundryId);
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
      // сохраняется; остаток при повторном завершении добавит вторую clean-запись
      // склада, а итоги стирки (items_total/bags/dirty_weight_kg) суммируются.
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
    notifyOwnerOnWorkerAction_(session,
      '↪ ' + actor + ': стирка перенесена — ' + clientNameById_(w.client_id, laundryId) +
      ': ' + details.from + ' → ' + details.to + (details.reason ? ', ' + details.reason : ''), laundryId);
    Object.keys(patch).forEach(function (k) { w[k] = patch[k]; });
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    return ok_({ wash: w });
  });
}

// «Оставить на складе» по частичной (spec: решение принимает владелец): запоминаем
// решение маркером hold в deferred_reason, дату НЕ переносим, статус остаётся partial.
// Иначе запись навсегда висит «требует решения», хотя решение уже принято.
function holdPartialWash(token, washId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    if (!found) return err_('Стирка не найдена');
    const w = found.obj;
    if (w.status !== 'partial') return err_('Не частичная стирка');
    w.deferred_reason = 'hold'; // маркер решения «оставить на складе»
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    logEvent(actorOf_(session), 'wash_hold', washId, {}, laundryId);
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
    notifyOwnerOnWorkerAction_(session,
      '➕ ' + actorOf_(session) + ': новая внеплановая стирка — ' + clientNameById_(clientId, laundryId) +
      (w.comment ? ' (' + w.comment + ')' : ''), laundryId);
    return ok_({ wash: w });
  });
}

function getShiftCloseState(token) {
  const session = requireRole_(token, ['owner', 'worker']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const today = todayStr_();
  // Любой экран дня материализует стирки из завтрашнего развоза (раньше — только getDayList)
  ensureWashesFromDelivery_(today, laundryId);
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
  const session = requireRole_(token, ['owner', 'worker']);
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
    notifyOwnerOnWorkerAction_(session,
      '🗑 ' + actorOf_(session) + ': удалена стирка — ' + clientNameById_(w.client_id, laundryId) +
      ' (' + w.wash_date + ')', laundryId);
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
    // Чистое с новой датой выдачи появляется в плане/развозе на этот день
    ensureVisit_(found.obj.client_id, issueDate, laundryId, actorOf_(session));
    return ok_({ wash: found.obj });
  });
}

// --- Канбан «Неделя»: планирование развозов ---
// Карточка = визит развоза (клиент в день D). Стирки дня формируются из развоза
// на завтра (см. getDayList). Хранение и права — в deliveries.js.

// Неделя уже материализована? Маркер — событие week_copy в Log этой прачки.
// После первой копии неделя принадлежит владельцу: его правки (удаление визитов)
// не должны затираться повторным копированием.
function weekMaterialized_(monday, laundryId) {
  return db.findRowsByTenant_(SHEETS.LOG, function (e) {
    return e.action === 'week_copy' && e.entity === monday;
  }, 1, laundryId).length > 0;
}

// Копия прошлой недели: planned-визиты со сдвигом +7 дней. Слияние, а не «всё
// или ничего»: пары клиент+дата, уже существующие на этой неделе (включая
// отменённые — владелец мог снять визит осознанно), не трогаем.
function copyPrevWeek_(monday, laundryId, actor) {
  const src = getVisitsByWeek_(addDaysStr_(monday, -7), laundryId);
  // Копировать нечего — маркер не ставим: попробуем снова, когда прошлая неделя заполнится
  if (!src.length) return;
  const sun = addDaysStr_(monday, 6);
  const existing = {};
  db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return v.date >= monday && v.date <= sun;
  }, 2000, laundryId).forEach(function (r) { existing[r.obj.client_id + '|' + r.obj.date] = true; });
  let created = 0;
  src.forEach(function (v) {
    const date = addDaysStr_(v.date, 7);
    const key = v.client_id + '|' + date;
    if (existing[key]) return;
    existing[key] = true;
    db.appendRowTenant_(SHEETS.DELIVERIES, {
      id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: date,
      client_id: v.client_id, ord: v.ord, status: 'planned',
      delivered_at: '', pickup: '', driver_comment: '',
      created_by: 'owner', created_at: nowStr_()
    }, laundryId);
    created++;
  });
  // Маркер материализации — даже при created=0 (все пары уже существовали)
  logEvent(actor, 'week_copy', monday, { copied: created }, laundryId);
}

// Проактивная материализация дня для всех активных прачек (index.js: при старте
// и ежедневно в 00:05). Раньше и план недели, и стирки дня создавались лениво —
// только при открытии экранов «План»/«Стирка», из-за чего утром день был пуст,
// пока кто-то не откроет нужный экран. Идемпотентно.
function materializeTodayAllLaundries_() {
  const today = todayStr_();
  // Неделя, содержащая завтрашний день: из её развоза формируются сегодняшние
  // стирки. В воскресенье это следующая неделя — её копия нужна до полуночи.
  const tomorrowWeek = mondayOf_(addDaysStr_(today, 1));
  db.readAll_(SHEETS.LAUNDRIES)
    .filter(function (l) { return l.active === 'да'; })
    .forEach(function (l) {
      if (!weekMaterialized_(tomorrowWeek, l.id)) copyPrevWeek_(tomorrowWeek, l.id, 'auto');
      ensureWashesFromDelivery_(today, l.id);
    });
}

function getWeekPlan(token, monday) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const mon = mondayOf_(monday || todayStr_());
  return withLock_(function () {
    let week = getVisitsByWeek_(mon, laundryId);
    // Идемпотентная материализация: один раз сливаем прошлую неделю (недостающие
    // пары клиент+дата), дальше неделя в руках владельца. Маркер — week_copy в Log.
    if (!weekMaterialized_(mon, laundryId)) {
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
      // Решение владельца «оставить на складе» по частичной (holdPartialWash)
      s.wash_hold = w && w.status === 'partial' && w.deferred_reason === 'hold' ? 1 : 0;
      s.issue_date = w ? w.issue_date : '';
      s.bags = w ? (Number(w.bags) || 0) : 0;
      return s;
    });
  // Остатки частичных стирок: clean-записи, чья стирка в статусе partial, а также
  // planned/in_progress с уже постиранной частью (перенесённый остаток — clean-запись
  // есть, а стирка снова в плане; без этого такая запись пропадала бы со склада).
  // (у done/stored-стирок clean-записи тоже есть — их не считаем остатками).
  return ok_({
    stored: stored,
    dirty: open.filter(function (s) { return s.kind === 'dirty'; }),
    clean: open.filter(function (s) { return s.kind === 'clean'; }),
    // cleanReady — чистое полностью завершённых (done) стирок: stored показываются карточками выше
    cleanReady: open.filter(function (s) { return s.kind === 'clean' && s.wash_status === 'done'; }),
    partialClean: open.filter(function (s) {
      return s.kind === 'clean' && ['partial', 'planned', 'in_progress'].indexOf(s.wash_status) !== -1;
    }),
    itemTypes: db.getItemTypes_()
  });
}

function getDayReport(token, date) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  // Как и getDayList: отчёт по дню материализует стирки из развоза на date+1
  ensureWashesFromDelivery_(date, laundryId);
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

// Сводный отчёт за произвольный период: итоги по клиентам (мешки/вес/вещи/стирки)
// + разбивка по видам вещей. Учитываются только завершённые стирки (DONE_STATUSES).
function getSummaryReport(token, from, to) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) {
    return err_('Некорректный период');
  }
  const DONE = core.DONE_STATUSES;
  // Полный скан журнала: период может быть годовым, хвостового лимита недостаточно
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
    return w.wash_date >= from && w.wash_date <= to && DONE.indexOf(w.status) !== -1;
  }, 100000, laundryId).map(function (r) { return r.obj; });
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const types = {};
  db.getItemTypes_().forEach(function (t) { types[t.id] = t.name; });
  const byClient = {};
  const washToClient = {};
  washes.forEach(function (w) {
    washToClient[w.id] = w.client_id;
    const s = byClient[w.client_id] || (byClient[w.client_id] = {
      client_id: w.client_id, client_name: clientName_(w.client_id, clients),
      washes: 0, bags: 0, weight_kg: 0, items_total: 0, itemsByType: {}
    });
    s.washes++;
    s.bags += Number(w.bags) || 0;
    s.weight_kg = round1_(s.weight_kg + (Number(w.dirty_weight_kg) || 0));
    s.items_total += Number(w.items_total) || 0;
  });
  db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) { return !!washToClient[wi.wash_id]; }, 100000)
    .forEach(function (r) {
      const wi = r.obj;
      const s = byClient[washToClient[wi.wash_id]];
      s.itemsByType[wi.item_type_id] = (s.itemsByType[wi.item_type_id] || 0) + (Number(wi.qty) || 0);
    });
  const result = Object.keys(byClient).map(function (cid) {
    const s = byClient[cid];
    s.items = Object.keys(s.itemsByType).map(function (tid) {
      return { item_type_id: tid, item_name: types[tid] || tid, qty: s.itemsByType[tid] };
    }).sort(function (a, b) { return b.qty - a.qty; });
    delete s.itemsByType;
    return s;
  }).sort(function (a, b) { return a.client_name < b.client_name ? -1 : 1; });
  return ok_({ from: from, to: to, clients: result });
}

// Финансовая сводка (P4): объёмы getSummaryReport + денежный слой buildInvoice_
// по каждому активному клиенту прачки. Read-only, один проход по данным.
function getFinanceSummary(token, from, to) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || from > to) {
    return err_('Некорректный период');
  }
  const inPeriod = function (ts) {
    const d = String(ts || '').slice(0, 10);
    return d >= from && d <= to;
  };
  const DONE = core.DONE_STATUSES;
  // Стирки: постиранные в периоде (DONE_STATUSES, для объёмов и строк счёта)
  // ИЛИ выданные в периоде (для веса ноги-доставки в buildInvoice_)
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
    return (w.wash_date >= from && w.wash_date <= to && DONE.indexOf(w.status) !== -1) ||
      inPeriod(w.issued_at);
  }, 100000, laundryId).map(function (r) { return r.obj; });
  const washIds = {};
  washes.forEach(function (w) { washIds[w.id] = true; });
  const washItems = db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) {
    return !!washIds[wi.wash_id];
  }, 100000).map(function (r) { return r.obj; });
  const visits = db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return inPeriod(v.date);
  }, 100000, laundryId).map(function (r) { return r.obj; });
  const storageRows = db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
    return s.kind === 'dirty' && inPeriod(s.created_at);
  }, 100000, laundryId).map(function (r) { return r.obj; });
  const itemTypes = db.getItemTypes_();
  const clientItemBilling = db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function () {
    return true;
  }, 100000, laundryId).map(function (r) { return r.obj; });
  const billingItems = billingItems_();
  // kind позиции прайса по id: у строк счёта buildInvoice_ поля kind нет
  const kindByBillingId = {};
  billingItems.forEach(function (b) { kindByBillingId[b.id] = b.kind; });
  const tariffs = core.effectiveTariffs_(db.readAll_(SHEETS.CLIENT_TARIFFS), laundryId);
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  // Объёмы: только стирки по wash_date со статусами DONE_STATUSES (как getSummaryReport)
  const byClient = {};
  washes.forEach(function (w) {
    if (!(w.wash_date >= from && w.wash_date <= to && DONE.indexOf(w.status) !== -1)) return;
    const s = byClient[w.client_id] || (byClient[w.client_id] = {
      client_id: w.client_id, client_name: clientName_(w.client_id, clients),
      washes: 0, bags: 0, weight_kg: 0, items_total: 0
    });
    s.washes++;
    s.bags += Number(w.bags) || 0;
    s.weight_kg = round1_(s.weight_kg + (Number(w.dirty_weight_kg) || 0));
    s.items_total += Number(w.items_total) || 0;
  });
  const totals = { washes: 0, weight_kg: 0, items_total: 0, amount: 0 };
  const result = Object.keys(byClient).map(function (cid) {
    const s = byClient[cid];
    const clientWashes = washes.filter(function (w) { return w.client_id === cid; });
    const clientWashIds = {};
    clientWashes.forEach(function (w) { clientWashIds[w.id] = true; });
    const invoice = core.buildInvoice_({
      client: clients[cid], from: from, to: to,
      washes: clientWashes,
      washItems: washItems.filter(function (wi) { return !!clientWashIds[wi.wash_id]; }),
      itemTypes: itemTypes,
      clientItemBilling: clientItemBilling.filter(function (r) { return r.client_id === cid; }),
      billingItems: billingItems,
      tariffs: tariffs,
      visits: visits.filter(function (v) { return v.client_id === cid; }),
      storageRows: storageRows.filter(function (s2) { return s2.client_id === cid; })
    });
    let trips = 0, lifts = 0;
    invoice.lines.forEach(function (l) {
      const kind = kindByBillingId[l.billing_item_id];
      if (kind === 'trip') trips += l.qty;
      if (kind === 'lift') lifts += l.qty;
    });
    totals.washes += s.washes;
    totals.weight_kg = round1_(totals.weight_kg + s.weight_kg);
    totals.items_total += s.items_total;
    totals.amount = Math.round((totals.amount + invoice.total) * 100) / 100;
    return {
      client_id: cid, client_name: s.client_name,
      washes: s.washes, bags: s.bags, weight_kg: s.weight_kg, items_total: s.items_total,
      trips: trips, lifts: lifts, amount: invoice.total,
      missing_prices: invoice.missing_prices.length, lines: invoice.lines
    };
  }).sort(function (a, b) { return a.client_name < b.client_name ? -1 : 1; });
  return ok_({ from: from, to: to, clients: result, totals: totals });
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
        type: client.type || 'прочее',
        active: 'да', comment: client.comment || '',
        item_types: client.item_types || '', accounting: client.accounting || '',
        inn: client.inn || '', kpp: client.kpp || '', legal_address: client.legal_address || ''
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

// Физическое удаление клиента. Стирки/визиты блокируют (история счетов);
// тарифы и привязки клиента чистятся каскадно — без клиента они мусор.
function purgeClient(token, clientId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
    if (!found) return err_('Клиент не найден');
    const used = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
      return w.client_id === clientId;
    }, 1, laundryId).length
      || db.findRowsByTenant_(SHEETS.DELIVERIES, function (d) {
        return d.client_id === clientId;
      }, 1, laundryId).length;
    if (used) return err_('Клиент используется в стирках или визитах — можно только архивировать');
    db.findRowsByTenant_(SHEETS.CLIENT_TARIFFS, function (t) {
      return t.client_id === clientId;
    }, 1000, laundryId).forEach(function (t) {
      db.deleteRow_(SHEETS.CLIENT_TARIFFS, t.rowNumber);
    });
    db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
      return r.client_id === clientId;
    }, 1000, laundryId).forEach(function (r) {
      db.deleteRow_(SHEETS.CLIENT_ITEM_BILLING, r.rowNumber);
    });
    db.deleteRow_(SHEETS.CLIENTS, found.rowNumber);
    db.invalidateRefCache_();
    logEvent(actorOf_(session), 'client_purge', clientId, { name: found.obj.name }, laundryId);
    return ok_({});
  });
}

// Создавать новый тип («Другое…») может и работник с экрана стирки;
// переименование существующего — только владелец.
// billing_item_id — позиция в счёте (только штучная wash_pcs, пусто = в счёт по весу).
function saveItemType(token, itemType) {
  const roles = itemType && itemType.id ? ['owner'] : ['owner', 'worker'];
  const session = requireRole_(token, roles);
  if (!session) return err_('Нет доступа');
  if (itemType.billing_item_id !== undefined) {
    const bid = String(itemType.billing_item_id || '');
    if (bid) {
      const bi = db.findById_(SHEETS.BILLING_ITEMS, bid);
      if (!bi || bi.obj.kind !== 'wash_pcs') return err_('Позиция в счёте должна быть штучной');
    }
    itemType.billing_item_id = bid;
  }
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
        sort: maxSort + 1, active: 'да', billing_item_id: itemType.billing_item_id || ''
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

// Физическое удаление вида белья. Блокируется, если вид привязан
// у клиента (item_types) или есть per-клиентская привязка к позиции счёта —
// иначе только архивация (active=нет). ItemTypes — глобальный справочник
// (без laundry_id), клиентов проверяем только своей прачки.
function deleteItemType(token, itemTypeId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = db.findById_(SHEETS.ITEM_TYPES, itemTypeId);
    if (!found) return err_('Тип не найден');
    const inClients = db.getClients_(laundryId).some(function (c) {
      return (db.parseJsonList_(c.item_types) || []).indexOf(itemTypeId) !== -1;
    });
    const inBindings = db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
      return r.item_type_id === itemTypeId;
    }, 1, laundryId).length;
    if (inClients || inBindings) {
      return err_('Вид белья используется у клиентов — можно только архивировать');
    }
    db.deleteRow_(SHEETS.ITEM_TYPES, found.rowNumber);
    db.invalidateRefCache_();
    logEvent(actorOf_(session), 'item_type_delete', itemTypeId, { name: found.obj.name }, laundryId);
    return ok_({});
  });
}

// Полные справочники для экрана владельца (включая архивные).
function getRefs(token) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  return ok_({ clients: db.getClients_(session.laundryId), itemTypes: db.getItemTypes_() });
}

// --- Прайс и счета (P2, docs/tickets.md). Owner-only, события в Log ---

const BILLING_KINDS = ['wash_weight', 'wash_pcs', 'trip', 'lift'];

// Прайс глобальный (v7): laundry_id у позиций пуст, список общий для всех прачек.
function billingItems_() {
  return db.readAll_(SHEETS.BILLING_ITEMS)
    .sort(function (a, b) { return (Number(a.sort) || 0) - (Number(b.sort) || 0); });
}

function listBillingItems(token) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  return ok_({ items: billingItems_() });
}

function saveBillingItem(token, item) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    item = item || {};
    const kind = BILLING_KINDS.indexOf(item.kind) !== -1 ? item.kind : '';
    if (!kind) return err_('Неизвестный вид позиции');
    // P2.2: позиции доставки и подъёма фиксированы — свободное создание
    // только для стирки (по весу / поштучно).
    if (!item.id && (kind === 'trip' || kind === 'lift')) {
      return err_('Позиции доставки и подъёма фиксированы');
    }
    if (item.id) {
      const found = db.findById_(SHEETS.BILLING_ITEMS, item.id);
      if (!found) return err_('Позиция прайса не найдена');
      if (found.obj.kind === 'trip' || found.obj.kind === 'lift') {
        return saveLogisticsItem_(session, found, item, laundryId);
      }
    }
    const name = String(item.name || '').trim();
    if (!name) return err_('Укажите название позиции');
    const active = item.active === 'нет' ? 'нет' : 'да';
    // Ровно одна активная весовая позиция на весь глобальный прайс (весовая по умолчанию)
    if (kind === 'wash_weight' && active === 'да') {
      const dup = billingItems_().filter(function (b) {
        return b.kind === 'wash_weight' && b.active === 'да' && b.id !== item.id;
      })[0];
      if (dup) return err_('Активная весовая позиция уже есть: ' + dup.name);
    }
    const normalized = {
      name: name, unit: kind === 'wash_weight' ? 'кг' : 'шт', kind: kind,
      oneway: '', max_kg: '', per_floor: '',
      ext_code: String(item.ext_code || '').trim(),
      active: active
    };
    let saved;
    if (item.id) {
      const found = db.findById_(SHEETS.BILLING_ITEMS, item.id);
      Object.keys(normalized).forEach(function (k) { found.obj[k] = normalized[k]; });
      if (Number(item.sort) > 0) found.obj.sort = String(Number(item.sort));
      db.updateRow_(SHEETS.BILLING_ITEMS, found.rowNumber, found.obj);
      saved = found.obj;
    } else {
      let maxSort = 0;
      billingItems_().forEach(function (b) { maxSort = Math.max(maxSort, Number(b.sort) || 0); });
      saved = Object.assign({
        id: db.nextId_(SHEETS.BILLING_ITEMS, 'bi'), laundry_id: '', sort: String(maxSort + 1)
      }, normalized);
      db.appendRow_(SHEETS.BILLING_ITEMS, saved);
    }
    logEvent(actorOf_(session), 'billing_item_save', saved.id,
      { name: saved.name, kind: saved.kind, active: saved.active }, laundryId);
    return ok_({ item: saved });
  });
}

// Правка фиксированных логистических позиций (P2.2).
// Системный набор: пороговая (trip с max_kg, oneway ≠ да), oneway-trip, lift per_floor.
// Пороговой разрешены max_kg и ext_code (имя генерируется из N); oneway/lift —
// только ext_code; legacy (созданные до запрета) — только архивация (active).
function saveLogisticsItem_(session, found, item, laundryId) {
  const it = found.obj;
  const isThreshold = it.kind === 'trip' && it.max_kg && it.oneway !== 'да';
  const isSystem = isThreshold
    || (it.kind === 'trip' && it.oneway === 'да')
    || (it.kind === 'lift' && it.per_floor === 'да');
  const attempt = function (field, val) {
    return val !== undefined && String(val) !== String(it[field] || '');
  };
  if (!isSystem) {
    // legacy: только активность
    const locked = ['name', 'unit', 'kind', 'oneway', 'max_kg', 'per_floor', 'ext_code']
      .some(function (f) { return attempt(f, item[f]); });
    if (locked) return err_('Позиция устарела: можно только архивировать');
    it.active = item.active === 'нет' ? 'нет' : 'да';
    db.updateRow_(SHEETS.BILLING_ITEMS, found.rowNumber, it);
    logEvent(actorOf_(session), 'billing_item_save', it.id,
      { name: it.name, kind: it.kind, active: it.active }, laundryId);
    return ok_({ item: it });
  }
  if (isThreshold) {
    const prevThreshold = it.max_kg;
    if (item.max_kg !== undefined) {
      const n = Number(item.max_kg);
      if (!Number.isInteger(n) || n <= 0) return err_('Порог доставки — целое число больше 0');
      it.max_kg = String(n);
    }
    if (item.ext_code !== undefined) it.ext_code = String(item.ext_code).trim();
    // Имя позиции в счёте генерируется из порога N
    it.name = 'Доставка менее ' + it.max_kg + ' кг';
    db.updateRow_(SHEETS.BILLING_ITEMS, found.rowNumber, it);
    logEvent(actorOf_(session), 'billing_item_save', it.id, {
      name: it.name, kind: it.kind, active: it.active,
      max_kg: prevThreshold !== it.max_kg ? { was: prevThreshold, now: it.max_kg } : it.max_kg
    }, laundryId);
    return ok_({ item: it });
  }
  // Системные oneway-trip и lift: только код НФ
  if (attempt('name', item.name) || attempt('active', item.active)
    || attempt('oneway', item.oneway) || attempt('max_kg', item.max_kg)
    || attempt('per_floor', item.per_floor)) {
    return err_('Название, параметры и активность системной позиции зафиксированы');
  }
  if (item.ext_code !== undefined) it.ext_code = String(item.ext_code).trim();
  db.updateRow_(SHEETS.BILLING_ITEMS, found.rowNumber, it);
  logEvent(actorOf_(session), 'billing_item_save', it.id,
    { name: it.name, kind: it.kind, active: it.active }, laundryId);
  return ok_({ item: it });
}

// Удаление запрещено, если позиция используется в тарифах, привязках клиентов
// или типах белья — только архивация (active=нет), чтобы не ломать историю счетов.
function deleteBillingItem(token, itemId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = db.findById_(SHEETS.BILLING_ITEMS, itemId);
    if (!found) return err_('Позиция прайса не найдена');
    // P2.2: логистические позиции (системные и legacy) удалять нельзя
    if (found.obj.kind === 'trip' || found.obj.kind === 'lift') {
      return err_('Позиции доставки и подъёма удалять нельзя');
    }
    // Позиция глобальная — использование проверяем по всем прачкам
    const inTariffs = db.findRowsBy_(SHEETS.CLIENT_TARIFFS, function (t) {
      return t.billing_item_id === itemId;
    }, 10000).length;
    const inBindings = db.findRowsBy_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
      return r.billing_item_id === itemId;
    }, 10000).length;
    const inTypes = db.getItemTypes_().filter(function (t) {
      return t.billing_item_id === itemId;
    }).length;
    if (inTariffs || inBindings || inTypes) {
      return err_('Позиция используется (тарифы, привязки или типы белья) — можно только архивировать');
    }
    db.deleteRow_(SHEETS.BILLING_ITEMS, found.rowNumber);
    logEvent(actorOf_(session), 'billing_item_delete', itemId, { name: found.obj.name }, laundryId);
    return ok_({});
  });
}

// Тарифы прачки: глобальные дефолты (client_id='') + переопределения её клиентов.
// С clientId — дефолты + переопределения этого клиента.
function listTariffs(token, clientId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const rows = core.effectiveTariffs_(db.readAll_(SHEETS.CLIENT_TARIFFS), session.laundryId)
    .filter(function (t) { return !clientId || !t.client_id || t.client_id === clientId; });
  return ok_({ tariffs: rows });
}

// Upsert по (client_id, billing_item_id); price=''/null — снять переопределение.
// clientId пусто = глобальный дефолт (общий для всех прачек, laundry_id='').
function saveTariff(token, clientId, billingItemId, price) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    if (!db.findById_(SHEETS.BILLING_ITEMS, billingItemId)) {
      return err_('Позиция прайса не найдена');
    }
    clientId = clientId || '';
    if (clientId && !findTenantRow_(SHEETS.CLIENTS, clientId, laundryId)) {
      return err_('Клиент не найден');
    }
    // Дефолт глобальный — ищем среди дефолтов любой прачки; клиентское
    // переопределение — только в своей прачке.
    const existing = db.findRowsBy_(SHEETS.CLIENT_TARIFFS, function (t) {
      if (t.client_id !== clientId || t.billing_item_id !== billingItemId) return false;
      return clientId ? String(t.laundry_id) === String(laundryId) : true;
    }, 10000)[0];
    if (price === '' || price === null || price === undefined) {
      if (existing) {
        db.deleteRow_(SHEETS.CLIENT_TARIFFS, existing.rowNumber);
        logEvent(actorOf_(session), 'tariff_set', billingItemId,
          { client_id: clientId, price: '', removed: true }, laundryId);
      }
      return ok_({});
    }
    const p = Number(price);
    if (!(p >= 0)) return err_('Некорректная цена');
    let saved;
    if (existing) {
      existing.obj.price = String(p);
      db.updateRow_(SHEETS.CLIENT_TARIFFS, existing.rowNumber, existing.obj);
      saved = existing.obj;
    } else {
      saved = {
        id: db.nextId_(SHEETS.CLIENT_TARIFFS, 'trf'),
        laundry_id: clientId ? String(laundryId) : '',
        client_id: clientId, billing_item_id: billingItemId, price: String(p)
      };
      db.appendRow_(SHEETS.CLIENT_TARIFFS, saved);
    }
    logEvent(actorOf_(session), 'tariff_set', billingItemId,
      { client_id: clientId, price: saved.price }, laundryId);
    return ok_({ tariff: saved });
  });
}

// Per-клиентская привязка типа белья к позиции счёта (upsert по client_id+item_type_id).
// billingItemId '' — «у этого клиента тип идёт в вес»; null — удалить строку
// (вернуться к дефолтной привязке из ItemTypes).
function saveClientItemBilling(token, clientId, itemTypeId, billingItemId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    if (!findTenantRow_(SHEETS.CLIENTS, clientId, laundryId)) return err_('Клиент не найден');
    if (!db.findById_(SHEETS.ITEM_TYPES, itemTypeId)) return err_('Тип белья не найден');
    if (billingItemId) {
      const bi = db.findById_(SHEETS.BILLING_ITEMS, billingItemId);
      if (!bi || bi.obj.kind !== 'wash_pcs') return err_('Привязка возможна только к штучной позиции прайса');
    }
    const existing = db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
      return r.client_id === clientId && r.item_type_id === itemTypeId;
    }, 100, laundryId)[0];
    if (billingItemId === null) {
      if (existing) db.deleteRow_(SHEETS.CLIENT_ITEM_BILLING, existing.rowNumber);
      logEvent(actorOf_(session), 'client_item_billing', itemTypeId,
        { client_id: clientId, billing_item_id: null, removed: true }, laundryId);
      return ok_({});
    }
    let saved;
    if (existing) {
      existing.obj.billing_item_id = billingItemId || '';
      db.updateRow_(SHEETS.CLIENT_ITEM_BILLING, existing.rowNumber, existing.obj);
      saved = existing.obj;
    } else {
      saved = {
        id: db.nextId_(SHEETS.CLIENT_ITEM_BILLING, 'cib'),
        client_id: clientId, item_type_id: itemTypeId,
        billing_item_id: billingItemId || ''
      };
      db.appendRowTenant_(SHEETS.CLIENT_ITEM_BILLING, saved, laundryId);
    }
    logEvent(actorOf_(session), 'client_item_billing', itemTypeId,
      { client_id: clientId, billing_item_id: saved.billing_item_id }, laundryId);
    return ok_({ binding: saved });
  });
}

function listClientItemBilling(token, clientId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const rows = db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
    return r.client_id === clientId;
  }, 1000, session.laundryId).map(function (r) { return r.obj; });
  return ok_({ bindings: rows });
}

// Счёт клиента за период: сбор данных и чистый расчёт buildInvoice_ (core.js).
function getClientInvoice(token, clientId, from, to) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
  if (!found) return err_('Клиент не найден');
  if (!from || !to) return err_('Укажите период');
  const inPeriod = function (ts) {
    const d = String(ts || '').slice(0, 10);
    return d >= from && d <= to;
  };
  // Стирки: постиранные в периоде ИЛИ выданные в периоде (для веса ноги-доставки)
  const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
    return w.client_id === clientId && (inPeriod(w.wash_date) || inPeriod(w.issued_at));
  }, 5000, laundryId).map(function (r) { return r.obj; });
  const washIds = {};
  washes.forEach(function (w) { washIds[w.id] = true; });
  const washItems = db.findRowsBy_(SHEETS.WASH_ITEMS, function (wi) {
    return !!washIds[wi.wash_id];
  }, 20000).map(function (r) { return r.obj; });
  const visits = db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return v.client_id === clientId && inPeriod(v.date);
  }, 5000, laundryId).map(function (r) { return r.obj; });
  const storageRows = db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
    return s.client_id === clientId && s.kind === 'dirty' && inPeriod(s.created_at);
  }, 5000, laundryId).map(function (r) { return r.obj; });
  const invoice = core.buildInvoice_({
    client: found.obj, from: from, to: to,
    washes: washes, washItems: washItems, itemTypes: db.getItemTypes_(),
    clientItemBilling: db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
      return r.client_id === clientId;
    }, 1000, laundryId).map(function (r) { return r.obj; }),
    billingItems: billingItems_(),
    tariffs: core.effectiveTariffs_(db.readAll_(SHEETS.CLIENT_TARIFFS), laundryId),
    visits: visits, storageRows: storageRows
  });
  return ok_({ invoice: invoice });
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

// Необратимое удаление пользователя (в отличие от deactivateUser — строка
// убирается из Users совсем). Нельзя удалить себя и последнего активного
// владельца. Сессии удалённого чистить не нужно: getSession_ отклоняет их,
// когда пользователь не найден (auth.js).
function deleteUser(token, id) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  if (String(id) === String(session.userId)) return err_('Нельзя удалить самого себя');
  const found = db.findById_('Users', id);
  if (!found) return err_('Пользователь не найден');
  if (found.obj.role === 'owner' && found.obj.active === 'да') {
    const otherOwners = db.readAll_('Users').filter(function (u) {
      return u.role === 'owner' && u.active === 'да' && String(u.id) !== String(id);
    });
    if (!otherOwners.length) return err_('Нельзя удалить последнего владельца');
  }
  db.deleteRow_('Users', found.rowNumber);
  logEvent(actorOf_(session), 'user_delete', id, { name: found.obj.name, role: found.obj.role }, session.laundryId);
  return ok_({ id: id });
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
    date: today, laundryName: db.getSettings_(laundryId).LAUNDRY_NAME || 'CleanLab Pro',
    counters: counters, washes: cards, updatedAt: timeStr_()
  });
}

// --- Экспорт и монтирование в Express ---

const { login, logout, switchLaundry } = require('./auth');

// Публичные методы API: имя функции = имя метода (POST /api/<method>, тело { args: [...] }).
const api = {
  login, logout, switchLaundry, listLaundries, createLaundry, updateLaundry, deactivateLaundry,
  getDayList, startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport, getSummaryReport, getFinanceSummary,
  saveClient, deleteClient, purgeClient, saveItemType, deleteItemType, rememberClientItemType, getRefs,
  listBillingItems, saveBillingItem, deleteBillingItem,
  listTariffs, saveTariff, saveClientItemBilling, listClientItemBilling, getClientInvoice,
  listUsers, createUser, updateUser, resetUserPassword, deactivateUser, reactivateUser, deleteUser, makeTelegramBindCode,
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
  driverHandover: deliveries.driverHandover,
  setVisitLiftFloor: deliveries.setVisitLiftFloor,
  // Табель: часы работников и статистика развозов (логика в workhours.js)
  setWorkHours: workhours.setWorkHours,
  getWorkHours: workhours.getWorkHours,
  getDeliveryPointStats: workhours.getDeliveryPointStats,
  // Зарплаты (логика в payroll.js)
  getPayroll: payroll.getPayroll,
  getMyPayroll: payroll.getMyPayroll,
  listPayRates: payroll.listPayRates,
  savePayRate: payroll.savePayRate,
  savePayAdjustment: payroll.savePayAdjustment,
  deletePayAdjustment: payroll.deletePayAdjustment,
  listPayAdjustments: payroll.listPayAdjustments,
  listPaySettings: payroll.listPaySettings,
  savePaySettings: payroll.savePaySettings
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
  ensureShift_, getShiftByDate_, ensureWashesFromDelivery_, notReadyForDelivery_, materializeTodayAllLaundries_,
  getDayList, startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport, getSummaryReport, getFinanceSummary,
  saveClient, deleteClient, purgeClient, saveItemType, deleteItemType, rememberClientItemType, getRefs,
  listBillingItems, saveBillingItem, deleteBillingItem,
  listTariffs, saveTariff, saveClientItemBilling, listClientItemBilling, getClientInvoice,
  listUsers, createUser, updateUser, resetUserPassword, deactivateUser, reactivateUser, deleteUser, makeTelegramBindCode,
  consumeTelegramBindCode_, getTvData,
  getDeliveryVisits: deliveries.getDeliveryVisits,
  addDeliveryVisit: deliveries.addDeliveryVisit,
  moveDeliveryVisit: deliveries.moveDeliveryVisit,
  removeDeliveryVisit: deliveries.removeDeliveryVisit,
  setPickupOnly: deliveries.setPickupOnly,
  getDriverRoute: deliveries.getDriverRoute,
  driverTakeAllClean: deliveries.driverTakeAllClean,
  driverAction: deliveries.driverAction,
  driverHandover: deliveries.driverHandover,
  setVisitLiftFloor: deliveries.setVisitLiftFloor,
  setWorkHours: workhours.setWorkHours,
  getWorkHours: workhours.getWorkHours,
  getDeliveryPointStats: workhours.getDeliveryPointStats,
  getPayroll: payroll.getPayroll,
  getMyPayroll: payroll.getMyPayroll,
  listPayRates: payroll.listPayRates,
  savePayRate: payroll.savePayRate,
  savePayAdjustment: payroll.savePayAdjustment,
  deletePayAdjustment: payroll.deletePayAdjustment,
  listPayAdjustments: payroll.listPayAdjustments,
  listPaySettings: payroll.listPaySettings,
  savePaySettings: payroll.savePaySettings
};
