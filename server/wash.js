// Жизненный цикл стирки (R3): именные команды домена.
// Каждая команда владает переходом статуса и его эффектами (Storage/Shifts/Log/Telegram)
// и атомарна: тело обёрнуто в db.transaction_, при сбое откатываются все записи.
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, todayStr_, logEvent, actorOf_ } = require('./audit');
const core = require('./core');
const {
  addDaysStr_, checkTransition_, applyDefer_, err_, ok_, round1_, clientName_,
  findTenantRow_, ensureShift_, getShiftByDate_, canEditWashData_, completionStatus_
} = core;
const { addStorageEntry_, consumeStorage_, openStorage_, storageSummaryByClient_ } = require('./storage');
const deliveries = require('./deliveries');
const { getVisitsByDate_, ensureVisit_, isOpenVisit_ } = deliveries;

// Уведомление владельцу в Telegram о действиях работника со стирками
// (добавление/перенос/удаление). Действия самого владельца не шлём.
// Вызов — только после коммита транзакции команды: отправка асинхронна
// (HTTP) и по откаченной команде уходить не должна.
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
  return db.transaction_(function () {
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
  return db.transaction_(function () {
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
  return db.transaction_(function () {
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
  // Текст уведомления собирается внутри транзакции, отправка — после коммита:
  // уведомление не должно уйти, если команда откатилась.
  let notifyText = null;
  const result = db.transaction_(function () {
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
    notifyText = '↪ ' + actor + ': стирка перенесена — ' + clientNameById_(w.client_id, laundryId) +
      ': ' + details.from + ' → ' + details.to + (details.reason ? ', ' + details.reason : '');
    Object.keys(patch).forEach(function (k) { w[k] = patch[k]; });
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    return ok_({ wash: w });
  });
  if (result.ok) notifyOwnerOnWorkerAction_(session, notifyText, laundryId);
  return result;
}

// «Оставить на складе» по частичной (spec: решение принимает владелец): запоминаем
// решение маркером hold в deferred_reason, дату НЕ переносим, статус остаётся partial.
// Иначе запись навсегда висит «требует решения», хотя решение уже принято.
function holdPartialWash(session, washId) {
  const laundryId = session.laundryId;
  return db.transaction_(function () {
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

// Внеплановая стирка из цеха = стирка на склад: сегодня, без даты выдачи
// (P9). Дату назначит владелец (updateIssueDate), когда решит отправить запас клиенту.
function addUnplannedWash(session, clientId, comment) {
  const laundryId = session.laundryId;
  const today = todayStr_();
  let notifyText = null;
  const result = db.transaction_(function () {
    // Не дублируем: у клиента уже есть открытая стирка на сегодня
    const dup = db.findRowsByTenant_(SHEETS.WASHES, function (x) {
      return x.client_id === clientId && x.wash_date === today &&
        ['planned', 'no_linen', 'in_progress'].indexOf(x.status) !== -1;
    }, 100, laundryId).length;
    if (dup) return err_('Стирка этого клиента уже в плане на сегодня');
    const w = {
      id: db.nextId_(SHEETS.WASHES, 'wash'), client_id: clientId,
      wash_date: today, issue_date: '', status: 'planned',
      dirty_weight_kg: '', items_total: '', comment: comment || '',
      created_by: session.role, created_at: nowStr_(),
      started_at: '', done_at: '', issued_at: '', deferred_from: '', deferred_reason: ''
    };
    db.appendRowTenant_(SHEETS.WASHES, w, laundryId);
    ensureShift_(today, laundryId);
    logEvent(actorOf_(session), 'wash_create', w.id, { client_id: clientId, unplanned: true }, laundryId);
    notifyText = '➕ ' + actorOf_(session) + ': новая внеплановая стирка — ' + clientNameById_(clientId, laundryId) +
      (w.comment ? ' (' + w.comment + ')' : '');
    return ok_({ wash: w });
  });
  if (result.ok) notifyOwnerOnWorkerAction_(session, notifyText, laundryId);
  return result;
}

// Отмена стирки (owner). Из in_progress — в т.ч. для цепочки правок P6.1:
// грязные записи партии возвращаются на склад (снимаем расход startWash),
// физическое бельё снова висит в «К стирке» и undo_pickup по точке разблокируется.
function cancelWash(session, washId) {
  const laundryId = session.laundryId;
  return db.transaction_(function () {
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
  let notifyText = null;
  const result = db.transaction_(function () {
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
    notifyText = '🗑 ' + actorOf_(session) + ': удалена стирка — ' + clientNameById_(w.client_id, laundryId) +
      ' (' + w.wash_date + ')';
    db.deleteRow_(SHEETS.WASHES, found.rowNumber);
    return ok_({ id: washId });
  });
  if (result.ok) notifyOwnerOnWorkerAction_(session, notifyText, laundryId);
  return result;
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
  return db.transaction_(function () {
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
    // already_clean: факт чистого на складе проверяется (P8) — иначе зелёная
    // карточка при пустом складе. Чистое «у водителя» openStorage_ отсекает.
    if (verdict === 'already_clean' &&
        openStorage_(w.client_id, 'clean', laundryId).length === 0) {
      return err_('Чистого белья этого клиента на складе нет. ' +
        'Если бельё физически на полке — внесите его вручную.');
    }
    w.status = verdict === 'no_dirty' ? 'no_linen' : 'ready_clean';
    w.done_at = nowStr_();
    db.updateRow_(SHEETS.WASHES, found.rowNumber, w);
    logEvent(actorOf_(session), 'storage_check', washId, { verdict: verdict }, laundryId);
    return ok_({ wash: w });
  });
}

// Ручное внесение чистого на склад (P8): бельё физически на полке, а записи
// в системе нет (досистемный запас, бумажные накладные, потерянная запись).
// wash_id принципиально пустой — стирки за записью нет, в производственные
// отчёты запись не попадает. Мешки обязательны: это сверка водителя.
// Комментарий обязателен: исключительный путь, «откуда бельё» фиксируется.
// items (опционально) — разбивка по видам [{item_type_id, qty}], как при
// завершении стирки: пишется в WashItems со storage_id записи (wash_id='').
// Если items непуст, items_total = сумме qty, переданный itemsTotal игнорируется
// (клиент шлёт сумму со степперов, источник истины — разбивка).
function addManualClean(session, clientId, weightKg, itemsTotal, bags, comment, items) {
  const laundryId = session.laundryId;
  const actor = actorOf_(session);
  let notifyText = null;
  const result = db.transaction_(function () {
    const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
    if (!found || found.obj.active !== 'да') return err_('Клиент не найден или неактивен');
    const bagsN = Number(bags);
    if (!(Number.isInteger(bagsN) && bagsN > 0)) return err_('Укажите количество мешков');
    const countOnly = found.obj.accounting === 'count';
    const kg = round1_(weightKg);
    // Разбивка по видам: тип должен существовать и быть активным; qty целое > 0;
    // дубликаты типов суммируем (клиент мог собрать список из двух источников).
    const activeTypes = {};
    db.getItemTypes_().forEach(function (t) {
      if (t.active === 'да') activeTypes[t.id] = true;
    });
    const byType = {};
    const order = [];
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i];
      const qty = Number(it && it.qty);
      if (!activeTypes[it && it.item_type_id]) return err_('Неизвестный вид белья: ' + (it && it.item_type_id));
      if (!(Number.isInteger(qty) && qty > 0)) return err_('Количество должно быть целым > 0');
      if (!byType[it.item_type_id]) order.push(it.item_type_id);
      byType[it.item_type_id] = (byType[it.item_type_id] || 0) + qty;
    }
    const valid = order.map(function (tid) { return { item_type_id: tid, qty: byType[tid] }; });
    let total = 0;
    valid.forEach(function (it) { total += it.qty; });
    // Без разбивки — как раньше, одно число; с разбивкой — её сумма
    const itemsN = valid.length ? total : Math.floor(Number(itemsTotal) || 0);
    if (!countOnly && !(kg > 0)) return err_('Укажите вес чистого белья');
    if (countOnly && !(itemsN > 0)) return err_('Укажите количество штук');
    const text = String(comment || '').trim();
    if (!text) return err_('Укажите комментарий — откуда бельё');
    const entry = addStorageEntry_(clientId, 'clean', {
      weight_kg: kg > 0 ? kg : '', items_total: itemsN > 0 ? itemsN : '', bags: bagsN
    }, laundryId);
    valid.forEach(function (it) {
      db.appendRow_(SHEETS.WASH_ITEMS, {
        id: db.nextId_(SHEETS.WASH_ITEMS, 'wi'), wash_id: '', storage_id: entry.id,
        item_type_id: it.item_type_id, qty: it.qty
      });
    });
    logEvent(actor, 'storage_manual_clean', entry.id, {
      client_id: clientId, kg: kg || 0, items: itemsN || 0, bags: bagsN, comment: text,
      breakdown: valid.length ? valid : undefined
    }, laundryId);
    notifyText = '📦 ' + actor + ': чистое внесено вручную — ' +
      clientNameById_(clientId, laundryId) + ': ' + (kg || 0) + ' кг, ' + bagsN +
      ' мешк. (' + text + ')';
    return ok_({ entry: entry });
  });
  if (result.ok) notifyOwnerOnWorkerAction_(session, notifyText, laundryId);
  return result;
}

function markIssued(session, washId) {
  const laundryId = session.laundryId;
  return db.transaction_(function () {
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

// Переход «чистое выдано клиенту» по визиту развоза (R4): чистые записи визита
// (visit_id + consumed_at='driver') израсходованы, их стирки (done|stored) → issued.
// Перенос логики driverAction/deliver_clean. Визит не пишет — мутирует v
// (status, delivered_at), запись на диске делает вызывающий, обёрнутый в транзакцию.
// Одна метка времени на всю операцию: сцепка стирок в unissueForVisit_
// (issued_at === delivered_at) работает только при равных метках.
function issueForVisit_(v, laundryId) {
  const ts = nowStr_();
  db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
    return s.visit_id === v.id && s.kind === 'clean' && s.consumed_at === 'driver';
  }, 500, laundryId).forEach(function (r) {
    r.obj.consumed_at = ts;
    db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
    if (r.obj.wash_id) {
      const w = db.findById_(SHEETS.WASHES, r.obj.wash_id);
      if (w && (w.obj.status === 'done' || w.obj.status === 'stored')) {
        w.obj.status = 'issued';
        w.obj.issued_at = ts;
        db.updateRow_(SHEETS.WASHES, w.rowNumber, w.obj);
      }
    }
  });
  v.status = v.picked_at ? 'both' : 'delivered';
  v.delivered_at = ts;
}

// Откат выдачи по визиту (обратный к issueForVisit_): стирки выдачи → stored,
// чистое визита — снова у водителя. Возвращает warn ('washes_not_found' — правили
// вручную, визит всё равно откатываем) или null. Визит не пишет — мутирует v.
// Сцепка стирка↔визит остаётся по метке issued_at === delivered_at: у Washes нет
// visit_id, вносить его — отдельный тикет (принятый остаточный риск, см. R4).
function unissueForVisit_(v, laundryId) {
  const issued = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
    return w.client_id === v.client_id && w.status === 'issued' && w.issued_at === v.delivered_at;
  }, 500, laundryId);
  // Визит откатываем в любом случае; предупреждение — только если стирки не нашлись
  v.delivered_at = '';
  v.status = v.picked_at ? 'picked' : 'planned';
  if (!issued.length) return 'washes_not_found'; // правили вручную — визит всё равно откатываем
  issued.forEach(function (r) {
    r.obj.status = 'stored';
    r.obj.issued_at = '';
    db.updateRow_(SHEETS.WASHES, r.rowNumber, r.obj);
  });
  // Чистое ищется по складским записям визита (visit_id), не по метке времени
  db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
    return s.visit_id === v.id && s.kind === 'clean';
  }, 500, laundryId).forEach(function (sr) {
    sr.obj.consumed_at = 'driver';
    db.updateRow_(SHEETS.STORAGE, sr.rowNumber, sr.obj);
  });
  return null;
}

// Правка issue_date у done/stored статус не меняет (spec §4.3).
function updateIssueDate(session, washId, issueDate) {
  const laundryId = session.laundryId;
  return db.transaction_(function () {
    const found = findTenantRow_(SHEETS.WASHES, washId, laundryId);
    if (!found) return err_('Стирка не найдена');
    if (['done', 'stored'].indexOf(found.obj.status) === -1) {
      return err_('Менять дату выдачи можно только у завершённой стирки');
    }
    const old = found.obj.issue_date;
    if (issueDate === old) return err_('Дата не изменилась');
    found.obj.issue_date = issueDate;
    db.updateRow_(SHEETS.WASHES, found.rowNumber, found.obj);
    logEvent(actorOf_(session), 'wash_edit', washId,
      { issue_date: issueDate ? old + ' → ' + issueDate : old + ' → снята' }, laundryId);
    // Визит создаём только при НАЗНАЧЕНИИ даты. Снятие даты визит НЕ отменяет:
    // если на старую дату визит уже есть, владелец убирает его на странице «План»
    // (cancelDeliveryVisit) — автоотмена могла бы снести чужие планы.
    if (issueDate) ensureVisit_(found.obj.client_id, issueDate, laundryId, actorOf_(session));
    return ok_({ wash: found.obj });
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

module.exports = {
  notifyOwnerOnWorkerAction_, clientNameById_,
  startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  cancelWash, deleteWash, confirmStorageCheck, addManualClean, markIssued, updateIssueDate, notReadyForDelivery_,
  issueForVisit_, unissueForVisit_
};
