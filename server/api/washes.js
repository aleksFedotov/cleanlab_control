// Стирки, смены, склад, неделя-канбан, отчёты и финсводка — ядро api.js.
// Вынесено из api.js при делёжке (R1); код перенесён как есть.
const { SHEETS } = require('../schema');
const db = require('../db');
const { nowStr_, todayStr_, logEvent, actorOf_ } = require('../audit');
const core = require('../core');
const {
  addDaysStr_, mondayOf_, checkTransition_, applyDefer_, canEditWashData_,
  isDayWash_, sortDayList_, shiftBlockers_, buildDayReport_, completionStatus_,
  err_, ok_, round1_, clientName_, resolveBillingItemForType_,
  withLock_, timeStr_, findTenantRow_, ensureShift_, getShiftByDate_
} = core;
const { addStorageEntry_, openStorage_, consumeStorage_, storageSummaryByClient_ } = require('../storage');
const deliveries = require('../deliveries');
const { getVisitsByDate_, getVisitsByWeek_, decorateVisit_, isOpenVisit_, ensureVisit_ } = deliveries;
const { billingItems_ } = require('./billing');

// --- Общие чтения ---

// Уведомление владельцу в Telegram о действиях работника со стирками
// (добавление/перенос/удаление). Действия самого владельца не шлём.
function notifyOwnerOnWorkerAction_(session, text, laundryId) {
  if (session.role !== 'worker') return;
  require('../telegram').sendTelegram_(null, text, laundryId).catch(function () {});
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

function getDayList(session, date) {
  const laundryId = session.laundryId;
  date = date || todayStr_();
  return withLock_(function () {
    ensureWashesFromDelivery_(date, laundryId);
    const clients = {};
    db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
    // Доска дня показывает все стирки дня, включая выданные (issued): день должен
    // читаться целиком и задним числом. Исключаем только cancelled (isDayWash_ — без issued).
    const washes = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
      return w.wash_date === date && w.status !== 'cancelled';
    }, 1000, laundryId).map(function (r) { return r.obj; });
    const shift = getShiftByDate_(date, laundryId);
    const storage = storageSummaryByClient_(laundryId);
    // P7: «Осталось со вчера» — незавершённые стирки вчерашнего дня.
    // partial с deferred_reason='hold' исключаем: владелец уже решил «оставить на складе».
    const yesterday = addDaysStr_(date, -1);
    const overdue = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
      if (w.wash_date !== yesterday) return false;
      if (w.status === 'planned' || w.status === 'no_linen' || w.status === 'in_progress') return true;
      return w.status === 'partial' && w.deferred_reason !== 'hold';
    }, 1000, laundryId).map(function (r) { return r.obj; });
    // На следующий день показываем только «в работе» или карточки, по которым
    // грязное бельё лежало на складе уже в день стирки (created_at <= вчера).
    // Привезённое сегодня — для сегодняшней стирки, вчерашний долг не оживляет.
    const dirtyByWashDay = {};
    db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
      return !s.consumed_at && s.kind === 'dirty' && String(s.created_at).slice(0, 10) <= yesterday;
    }, 2000, laundryId).forEach(function (r) { dirtyByWashDay[r.obj.client_id] = true; });
    const actionable = overdue.filter(function (w) {
      if (w.status === 'in_progress') return true;
      return !!dirtyByWashDay[w.client_id];
    });
    // WashItems грузим один раз для всех стирок дня: planned/in_progress — это
    // признак «остаток частичной стирки» (partial_rest), у завершённых — состав
    // постиранного (items), чтобы работник мог исправить ошибочное завершение.
    const dayIds = {};
    washes.concat(actionable).forEach(function (w) {
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
    // Декорация карточки дня — общая для washes и overdue (P7)
    const decorate = function (w) {
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
    };
    return ok_({
      date: date,
      laundryName: db.getSettings_(laundryId).LAUNDRY_NAME || 'CleanLab Pro',
      washes: sortDayList_(washes).map(decorate),
      overdue: actionable.map(decorate),
      shift: shift ? shift.obj : null,
      clients: db.getClients_(laundryId).filter(function (c) { return c.active === 'да'; }),
      itemTypes: db.getItemTypes_().filter(function (t) { return t.active === 'да'; })
    });
  });
}

// --- Сотрудник ---

function startWash(session, washId, weightKg) {
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
    // записях — связь партии для веса ноги-забора в счёте (P2). Откат — в cancelWash.
    consumeStorage_(w.client_id, 'dirty', laundryId, w.id);
    ensureShift_(w.wash_date, laundryId);
    logEvent(actorOf_(session), 'wash_start', washId, { weight: w.dirty_weight_kg }, laundryId);
    return ok_({ wash: w });
  });
}

function completeWash(session, washId, items, weightKg, mode, bags) {
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
function editWashData(session, washId, weightKg, items, bags) {
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

function deferWash(session, washId, newDate, reason) {
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
function holdPartialWash(session, washId) {
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
function addUnplannedWash(session, clientId, comment) {
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

function getShiftCloseState(session) {
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
async function closeShift(session, force) {
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
  const tg = require('../telegram');
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

function getDeliveryPlan(session, date) {
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

function addToDelivery(session, clientId, washDate, issueDate, comment) {
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

// Отмена стирки (owner). Из in_progress — в т.ч. для цепочки правок P6.1:
// грязные записи партии возвращаются на склад (снимаем расход startWash),
// физическое бельё снова висит в «К стирке» и undo_pickup по точке разблокируется.
function cancelWash(session, washId) {
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    const check = checkTransition_('cancel', found && found.obj);
    if (!check.ok) return err_(check.error);
    found.obj.status = 'cancelled';
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    // Возврат израсходованного грязного на склад: записи, забранные этой стиркой.
    const returned = db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
      return s.kind === 'dirty' && s.wash_id === washId;
    }, 1000, laundryId);
    returned.forEach(function (r) {
      r.obj.consumed_at = '';
      r.obj.wash_id = '';
      db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
    });
    logEvent(actorOf_(session), 'wash_cancel', washId, { storage_returned: returned.length }, laundryId);
    return ok_({ wash: found.obj });
  });
}

// Полное удаление ошибочно созданной стирки (owner). В отличие от отмены,
// запись исчезает из отчётов совсем. Разрешено для любой невыданной стирки:
// у завершённых (done/stored/partial) заодно удаляются позиции и складские
// строки этой стирки (в т.ч. израсходованные — бельё «убирается» из учёта).
// Выданную клиенту (issued) удалять нельзя — это уже факт выдачи.
function deleteWash(session, washId) {
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
function confirmStorageCheck(session, washId, verdict) {
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

function markIssued(session, washId) {
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
function updateIssueDate(session, washId, issueDate) {
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

function getWeekPlan(session, monday) {
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

function getStorage(session) {
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

function getDayReport(session, date) {
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
  // Таблица отчёта — все стирки дня, включая выданные (issued): картина дня полная,
  // issued дополнительно учитываются в сводке report.issued
  const dayWashes = washes.filter(function (w) { return w.wash_date === date; }).map(function (w) {
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
function getSummaryReport(session, from, to) {
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
function getFinanceSummary(session, from, to) {
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
      // Клиент мог быть удалён вне purgeClient (старые данные): счёт всё равно строим
      client: clients[cid] || { id: cid, name: s.client_name, active: 'нет' }, from: from, to: to,
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
module.exports = {
  notifyOwnerOnWorkerAction_, clientNameById_,
  ensureWashesFromDelivery_, notReadyForDelivery_, materializeTodayAllLaundries_,
  weekMaterialized_, copyPrevWeek_,
  getDayList, startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport, getSummaryReport, getFinanceSummary
};
