// Ядро бизнес-логики (spec §4, §8.2) — порт src/Core.gs.
// Чистые функции без зависимостей от окружения. Даты — строки 'yyyy-MM-dd'.

const TERMINAL_STATUSES = ['issued', 'cancelled'];
// partial = стирка завершена частично: чистая часть на складе, клиент НЕ готов к выдаче
// ready_clean = стирать не нужно: чистое бельё уже на складе, клиент готов к развозу
const DONE_STATUSES = ['done', 'stored', 'partial', 'issued', 'ready_clean'];

// --- Даты (строковая арифметика без TZ-сюрпризов) ---

function parseDate_(s) {
  const p = s.split('-');
  return { y: Number(p[0]), m: Number(p[1]), d: Number(p[2]) };
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function addDaysStr_(dateStr, days) {
  const p = parseDate_(dateStr);
  const t = Date.UTC(p.y, p.m - 1, p.d) + days * 86400000;
  const dt = new Date(t);
  return dt.getUTCFullYear() + '-' + pad2_(dt.getUTCMonth() + 1) + '-' + pad2_(dt.getUTCDate());
}

// Понедельник недели, содержащей dateStr.
function mondayOf_(dateStr) {
  const p = parseDate_(dateStr);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // 0=вс..6=сб
  return addDaysStr_(dateStr, -((dow + 6) % 7));
}

// --- Переходы статусов (spec §4.1) ---

function completionStatus_(washDate, issueDate) {
  return issueDate > addDaysStr_(washDate, 1) ? 'stored' : 'done';
}

const TRANSITIONS = {
  start: { from: ['planned', 'no_linen'] },
  complete: { from: ['in_progress'] },
  issue: { from: ['done', 'stored'] },
  cancel: { from: ['planned', 'no_linen'] },
  defer: { from: ['planned', 'in_progress', 'partial'] }
};

// Проверка перехода: {ok:true} или {ok:false, error}. Повтор недопустим (идемпотентность
// на уровне API: перечитывание статуса + отклонение).
function checkTransition_(action, wash) {
  const t = TRANSITIONS[action];
  if (!wash) return { ok: false, error: 'Стирка не найдена' };
  if (t.from.indexOf(wash.status) === -1) {
    return { ok: false, error: 'Нельзя ' + action + ' из статуса ' + wash.status };
  }
  return { ok: true };
}

// Перенос: статус и вес сохраняются, меняется только wash_date (+ след переноса).
function applyDefer_(wash, newDate, reason) {
  return {
    wash_date: newDate,
    deferred_from: wash.wash_date,
    deferred_reason: reason || ''
  };
}

// Правка данных завершённой (spec §4.2): owner — всегда, worker — пока смена дня открыта.
function canEditWashData_(role, wash, shiftOfDay) {
  if (['done', 'stored', 'partial'].indexOf(wash.status) === -1) return false;
  if (role === 'owner') return true;
  return !!shiftOfDay && shiftOfDay.status === 'open';
}

// --- Списки и блокировки (spec §3.5, §4.4) ---

function isDayWash_(wash, date) {
  return wash.wash_date === date && TERMINAL_STATUSES.indexOf(wash.status) === -1;
}

// Сначала незавершённые (planned, in_progress) в порядке постановки, затем завершённые.
function sortDayList_(washes) {
  const isOpen = function (w) { return w.status === 'planned' || w.status === 'in_progress'; };
  return washes.slice().sort(function (a, b) {
    return (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0);
  });
}

// Блокируют закрытие смены: план на сегодня и не завершены (spec §4.4).
function shiftBlockers_(washes, date) {
  return washes.filter(function (w) {
    return w.wash_date === date && (w.status === 'planned' || w.status === 'in_progress');
  });
}

// --- Агрегаты отчёта за день (spec §8.2, день плана = wash_date) ---

function parseDetails_(ev) {
  if (typeof ev.details === 'string') {
    try { return JSON.parse(ev.details); } catch (e) { return {}; }
  }
  return ev.details || {};
}

function buildDayReport_(date, washes, logEvents) {
  let kg = 0, doneCount = 0, cancelled = 0, stored = 0, issued = 0, deferred = 0;
  washes.forEach(function (w) {
    if (w.wash_date === date) {
      if (DONE_STATUSES.indexOf(w.status) !== -1) {
        kg += Number(w.dirty_weight_kg) || 0;
        doneCount++;
      }
      if (w.status === 'cancelled') cancelled++;
      // «Ушло на склад»: чистое done/stored/partial физически лежит на складе
      // (issued сюда не входит — его уже отдали клиенту)
      if (['done', 'stored', 'partial'].indexOf(w.status) !== -1) stored++;
    }
    // Выдано: issued_at внутри даты
    if (w.status === 'issued' && String(w.issued_at || '').indexOf(date) === 0) issued++;
  });
  // Перенесено: события wash_defer с исходной датой = дата (корректно для цепочек)
  (logEvents || []).forEach(function (ev) {
    if (ev.action === 'wash_defer' && parseDetails_(ev).from === date) deferred++;
  });
  return {
    date: date,
    totalKg: Math.round(kg * 10) / 10,
    washesDone: doneCount,
    deferred: deferred,
    cancelled: cancelled,
    stored: stored,
    issued: issued
  };
}

// --- Формат Telegram-дайджеста (spec §8.3) ---

function formatWashLine_(wash, clientName) {
  let line = '• ' + clientName + ' — ' + (wash.dirty_weight_kg || 0) + ' кг, ' +
    (wash.items_total || 0) + ' шт';
  if (wash.deferred_from) line += ' (перенесена с ' + wash.deferred_from + ')';
  return line;
}

function formatDigest_(laundryName, date, report, washLines, shift) {
  const lines = ['📊 ' + laundryName + ' — итоги ' + date, ''];
  if (!report || report.washesDone === 0) {
    lines.push('За ' + date + ' стирок не было');
  } else {
    lines.push('Постирано: ' + report.totalKg + ' кг (' + report.washesDone + ' стирок)');
    if (report.deferred) lines.push('Перенесено: ' + report.deferred);
    if (report.cancelled) lines.push('Отменено: ' + report.cancelled);
    if (report.stored) lines.push('На складе: ' + report.stored);
    if (report.issued) lines.push('Выдано: ' + report.issued);
    if (washLines && washLines.length) {
      lines.push('');
      washLines.forEach(function (l) { lines.push(l); });
    }
  }
  lines.push('');
  if (shift && shift.status === 'closed') {
    lines.push('Смена закрыта в ' + shift.closed_at + ' ✓');
  } else {
    lines.push('⚠ Смена ещё не закрыта');
  }
  return lines.join('\n');
}

// --- Авторасчёт счетов (P2, docs/tickets.md) ---

// Статусы стирок, попадающих в счёт: cancelled и partial исключены
// (partial попадёт при достирке — итоги суммируются, как в getDayList).
const INVOICE_WASH_STATUSES = ['done', 'stored', 'issued'];

// Эффективные тарифы прачки (v7): из полного списка ClientTariffs оставляет
// глобальные дефолты (client_id='') и клиентские переопределения этой прачки.
function effectiveTariffs_(tariffs, laundryId) {
  return (tariffs || []).filter(function (t) {
    return !t.client_id || String(t.laundry_id) === String(laundryId);
  });
}

// Цена позиции: переопределение клиента → глобальный дефолт (client_id пуст) → null.
function resolvePrice_(tariffs, clientId, billingItemId) {
  const own = (tariffs || []).filter(function (t) {
    return t.client_id === clientId && t.billing_item_id === billingItemId && t.price !== '';
  })[0];
  if (own) return Number(own.price);
  const def = (tariffs || []).filter(function (t) {
    return !t.client_id && t.billing_item_id === billingItemId && t.price !== '';
  })[0];
  if (def) return Number(def.price);
  return null;
}

// Привязка типа белья к позиции счёта: ClientItemBilling клиента (пустое
// billing_item_id = «у этого клиента тип идёт в вес») → ItemTypes.billing_item_id
// → '' (весовая позиция по умолчанию). '' = строки в счёте не даёт (считается в кг).
function resolveBillingItemForType_(clientId, itemTypeId, clientItemBilling, itemTypesById) {
  const row = (clientItemBilling || []).filter(function (r) {
    return r.client_id === clientId && r.item_type_id === itemTypeId;
  })[0];
  if (row) return row.billing_item_id || '';
  const t = itemTypesById[itemTypeId];
  return (t && t.billing_item_id) || '';
}

// Ярус: первая позиция с max_kg > вес (по возрастанию max_kg), иначе позиция
// без яруса (legacy), иначе null — рейс без подходящей позиции строки в счёте
// не даёт: доставка от N кг бесплатна (P2.2, сидовская «Доставка» без яруса
// удалена миграцией v6).
function pickByTier_(items, weightKg) {
  const tiered = items.filter(function (i) { return i.max_kg; })
    .sort(function (a, b) { return Number(a.max_kg) - Number(b.max_kg); });
  for (let k = 0; k < tiered.length; k++) {
    if (Number(tiered[k].max_kg) > weightKg) return tiered[k];
  }
  const plain = items.filter(function (i) { return !i.max_kg; });
  return plain.length ? plain[0] : null;
}

// Позиция для ноги рейса: у визита с одной ногой сначала oneway-позиции.
function pickTripPosition_(tripItems, weightKg, singleLeg) {
  const oneway = tripItems.filter(function (t) { return t.oneway === 'да'; });
  const regular = tripItems.filter(function (t) { return t.oneway !== 'да'; });
  if (singleLeg && oneway.length) {
    const o = pickByTier_(oneway, weightKg);
    if (o) return o;
  }
  return pickByTier_(regular, weightKg);
}

// Вес ноги-забора: Σ dirty_weight_kg стирок, связанных с dirty-записями склада,
// созданными в дату визита (связь проставляется при «В работу»). Дедуп по стирке.
function pickupWeightKg_(visit, storageRows, washesById) {
  const ids = {};
  (storageRows || []).forEach(function (s) {
    if (s.kind !== 'dirty' || s.client_id !== visit.client_id || !s.wash_id) return;
    if (String(s.created_at || '').slice(0, 10) !== visit.date) return;
    ids[s.wash_id] = true;
  });
  let kg = 0;
  Object.keys(ids).forEach(function (id) {
    const w = washesById[id];
    if (w) kg += Number(w.dirty_weight_kg) || 0;
  });
  return round1_(kg);
}

// Вес ноги-доставки: Σ dirty_weight_kg стирок, выданных в дату визита
// (та же партия → тот же ярус, что у забора; чистый вес не используем).
function deliveryWeightKg_(visit, washes) {
  let kg = 0;
  (washes || []).forEach(function (w) {
    if (String(w.issued_at || '').slice(0, 10) === visit.date) {
      kg += Number(w.dirty_weight_kg) || 0;
    }
  });
  return round1_(kg);
}

// Счёт клиента за период. Чистая функция: все данные передаются входом.
// input: { client, from, to, washes, washItems, itemTypes, clientItemBilling,
//          billingItems, tariffs, visits, storageRows }
// → { client, from, to, lines: [{billing_item_id, name, ext_code, unit, qty, price, amount}],
//     total, missing_prices: [billing_item_id, ...] }
function buildInvoice_(input) {
  const client = input.client;
  const from = input.from, to = input.to;
  const items = (input.billingItems || []).filter(function (b) { return b.active === 'да'; })
    .sort(function (a, b) { return (Number(a.sort) || 0) - (Number(b.sort) || 0); });
  const itemById = {};
  items.forEach(function (b) { itemById[b.id] = b; });
  const weightItem = items.filter(function (b) { return b.kind === 'wash_weight'; })[0];
  const qtyBy = {};
  function add(id, qty) {
    if (!id || !itemById[id] || !qty) return;
    qtyBy[id] = round1_((qtyBy[id] || 0) + qty);
  }

  // Стирки: весовая строка = Σ dirty_weight_kg
  const washes = (input.washes || []).filter(function (w) {
    return w.client_id === client.id && INVOICE_WASH_STATUSES.indexOf(w.status) !== -1 &&
      w.wash_date >= from && w.wash_date <= to;
  });
  let kg = 0;
  washes.forEach(function (w) { kg += Number(w.dirty_weight_kg) || 0; });
  if (weightItem) add(weightItem.id, round1_(kg));

  // Штучные строки: WashItems этих стирок по цепочке привязки, тип «в весе» строки не даёт
  const washIds = {};
  washes.forEach(function (w) { washIds[w.id] = true; });
  const itemTypesById = {};
  (input.itemTypes || []).forEach(function (t) { itemTypesById[t.id] = t; });
  (input.washItems || []).forEach(function (wi) {
    if (!washIds[wi.wash_id]) return;
    const bid = resolveBillingItemForType_(client.id, wi.item_type_id,
      input.clientItemBilling, itemTypesById);
    if (bid) add(bid, Math.floor(Number(wi.qty) || 0));
  });

  // Рейсы: ноги визитов клиента в периоде (cancelled/empty не тарифицируются)
  const trips = items.filter(function (b) { return b.kind === 'trip'; });
  const lift = items.filter(function (b) { return b.kind === 'lift'; })[0];
  const clientWashes = (input.washes || []).filter(function (w) {
    return w.client_id === client.id && w.status !== 'cancelled';
  });
  const washesById = {};
  clientWashes.forEach(function (w) { washesById[w.id] = w; });
  (input.visits || []).filter(function (v) {
    return v.client_id === client.id && v.date >= from && v.date <= to &&
      v.status !== 'cancelled' && v.status !== 'empty';
  }).forEach(function (v) {
    const legs = [];
    if (v.picked_at) legs.push('pickup');
    if (v.delivered_at) legs.push('delivery');
    legs.forEach(function (leg) {
      const legKg = leg === 'pickup'
        ? pickupWeightKg_(v, input.storageRows, washesById)
        : deliveryWeightKg_(v, clientWashes);
      const pos = pickTripPosition_(trips, legKg, legs.length === 1);
      if (pos) add(pos.id, 1);
    });
    // Подъём: этаж выше 2-го; per_floor=да — за каждый этаж выше 2-го, иначе за факт
    const floor = Math.floor(Number(v.lift_floor) || 0);
    if (floor > 2 && lift) add(lift.id, lift.per_floor === 'да' ? floor - 2 : 1);
  });

  // Строки счёта в порядке sort позиций прайса
  const lines = [];
  const missing = [];
  let total = 0;
  items.forEach(function (b) {
    const qty = qtyBy[b.id];
    if (!qty) return;
    const price = resolvePrice_(input.tariffs, client.id, b.id);
    let amount = null;
    if (price === null) {
      missing.push(b.id);
    } else {
      amount = Math.round(qty * price * 100) / 100;
      total += amount;
    }
    lines.push({
      billing_item_id: b.id, name: b.name, ext_code: b.ext_code || '',
      unit: b.unit, qty: qty, price: price, amount: amount
    });
  });
  return {
    client: client, from: from, to: to, lines: lines,
    total: Math.round(total * 100) / 100, missing_prices: missing
  };
}

// --- Общие хелперы из Api.gs, нужные нескольким модулям ---

function err_(m) { return { ok: false, error: m }; }
function ok_(data) { data = data || {}; data.ok = true; return data; }

function round1_(n) { return Math.round(Number(n) * 10) / 10; }

function clientName_(clientId, clientsById) {
  const c = clientsById[clientId];
  return c ? c.name : clientId;
}

module.exports = {
  TERMINAL_STATUSES, DONE_STATUSES,
  parseDate_, pad2_, addDaysStr_, mondayOf_,
  completionStatus_, TRANSITIONS, checkTransition_, applyDefer_, canEditWashData_,
  isDayWash_, sortDayList_, shiftBlockers_, parseDetails_, buildDayReport_,
  formatWashLine_, formatDigest_,
  INVOICE_WASH_STATUSES, resolvePrice_, resolveBillingItemForType_, effectiveTariffs_,
  pickByTier_, pickTripPosition_, pickupWeightKg_, deliveryWeightKg_, buildInvoice_,
  err_, ok_, round1_, clientName_
};
