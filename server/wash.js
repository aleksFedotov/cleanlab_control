// Жизненный цикл стирки (R3): именные команды домена.
// Каждая команда владеет переходом статуса и его эффектами (Storage/Shifts/Log/Telegram).
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, todayStr_, logEvent, actorOf_ } = require('./audit');
const core = require('./core');
const {
  addDaysStr_, checkTransition_, applyDefer_, err_, ok_, round1_, findTenantRow_,
  ensureShift_, getShiftByDate_, canEditWashData_, completionStatus_
} = core;
const { addStorageEntry_, consumeStorage_, openStorage_ } = require('./storage');
const deliveries = require('./deliveries');
const { getVisitsByDate_, ensureVisit_ } = deliveries;

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

function startWash(session, washId, weightKg) {
  const laundryId = session.laundryId;
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
}

function completeWash(session, washId, items, weightKg, mode, bags) {
  const laundryId = session.laundryId;
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
}

// Правка веса/пересчёта/мешков завершённой (spec §4.2): статус и done_at не меняются.
function editWashData(session, washId, weightKg, items, bags) {
  const laundryId = session.laundryId;
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
}

function deferWash(session, washId, newDate, reason) {
  const laundryId = session.laundryId;
  const actor = actorOf_(session);
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
}

// «Оставить на складе» по частичной (spec: решение принимает владелец): запоминаем
// решение маркером hold в deferred_reason, дату НЕ переносим, статус остаётся partial.
// Иначе запись навсегда висит «требует решения», хотя решение уже принято.
function holdPartialWash(session, washId) {
  const laundryId = session.laundryId;
  const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
  if (!found) return err_('Стирка не найдена');
  const w = found.obj;
  if (w.status !== 'partial') return err_('Не частичная стирка');
  w.deferred_reason = 'hold'; // маркер решения «оставить на складе»
  db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
  logEvent(actorOf_(session), 'wash_hold', washId, {}, laundryId);
  return ok_({ wash: w });
}

// Внеплановая стирка из цеха: сегодня, выдача завтра, created_by по роли.
function addUnplannedWash(session, clientId, comment) {
  const laundryId = session.laundryId;
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
}

// Отмена стирки (owner). Из in_progress — в т.ч. для цепочки правок P6.1:
// грязные записи партии возвращаются на склад (снимаем расход startWash),
// физическое бельё снова висит в «К стирке» и undo_pickup по точке разблокируется.
function cancelWash(session, washId) {
  const laundryId = session.laundryId;
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
}

// Полное удаление ошибочно созданной стирки (owner). В отличие от отмены,
// запись исчезает из отчётов совсем. Разрешено для любой невыданной стирки:
// у завершённых (done/stored/partial) заодно удаляются позиции и складские
// строки этой стирки (в т.ч. израсходованные — бельё «убирается» из учёта).
// Выданную клиенту (issued) удалять нельзя — это уже факт выдачи.
function deleteWash(session, washId) {
  const laundryId = session.laundryId;
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
}

module.exports = {
  notifyOwnerOnWorkerAction_, clientNameById_,
  startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  cancelWash, deleteWash
};
