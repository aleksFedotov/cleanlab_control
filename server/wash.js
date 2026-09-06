// Жизненный цикл стирки (R3): именные команды домена.
// Каждая команда владеет переходом статуса и его эффектами (Storage/Shifts/Log/Telegram).
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, logEvent, actorOf_ } = require('./audit');
const core = require('./core');
const {
  checkTransition_, err_, ok_, round1_, findTenantRow_, ensureShift_, getShiftByDate_,
  canEditWashData_, completionStatus_
} = core;
const { addStorageEntry_, consumeStorage_ } = require('./storage');

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

module.exports = {
  notifyOwnerOnWorkerAction_, clientNameById_,
  startWash, completeWash, editWashData
};
