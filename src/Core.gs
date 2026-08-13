// Ядро бизнес-логики (spec §4, §8.2). Чистые функции без GAS-зависимостей —
// одинаково выполняются в GAS и в Node-тестах. Даты — строки 'yyyy-MM-dd'.

var TERMINAL_STATUSES = ['issued', 'cancelled'];
var DONE_STATUSES = ['done', 'stored', 'issued'];

// --- Даты (строковая арифметика без TZ-сюрпризов) ---

function parseDate_(s) {
  var p = s.split('-');
  return { y: Number(p[0]), m: Number(p[1]), d: Number(p[2]) };
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function addDaysStr_(dateStr, days) {
  var p = parseDate_(dateStr);
  var t = Date.UTC(p.y, p.m - 1, p.d) + days * 86400000;
  var dt = new Date(t);
  return dt.getUTCFullYear() + '-' + pad2_(dt.getUTCMonth() + 1) + '-' + pad2_(dt.getUTCDate());
}

// Понедельник недели, содержащей dateStr.
function mondayOf_(dateStr) {
  var p = parseDate_(dateStr);
  var dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // 0=вс..6=сб
  return addDaysStr_(dateStr, -((dow + 6) % 7));
}

// --- Переходы статусов (spec §4.1) ---

function completionStatus_(washDate, issueDate) {
  return issueDate > addDaysStr_(washDate, 1) ? 'stored' : 'done';
}

var TRANSITIONS = {
  start: { from: ['planned'] },
  complete: { from: ['in_progress'] },
  issue: { from: ['done', 'stored'] },
  cancel: { from: ['planned'] },
  defer: { from: ['planned', 'in_progress'] }
};

// Проверка перехода: {ok:true} или {ok:false, error}. Повтор недопустим (идемпотентность
// на уровне API: перечитывание статуса + отклонение).
function checkTransition_(action, wash) {
  var t = TRANSITIONS[action];
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
  if (['done', 'stored'].indexOf(wash.status) === -1) return false;
  if (role === 'owner') return true;
  return !!shiftOfDay && shiftOfDay.status === 'open';
}

// --- Списки и блокировки (spec §3.5, §4.4) ---

function isDayWash_(wash, date) {
  return wash.wash_date === date && TERMINAL_STATUSES.indexOf(wash.status) === -1;
}

// Сначала незавершённые (planned, in_progress) в порядке постановки, затем завершённые.
function sortDayList_(washes) {
  var isOpen = function (w) { return w.status === 'planned' || w.status === 'in_progress'; };
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
  var kg = 0, doneCount = 0, cancelled = 0, stored = 0, issued = 0, deferred = 0;
  washes.forEach(function (w) {
    if (w.wash_date === date) {
      if (DONE_STATUSES.indexOf(w.status) !== -1) {
        kg += Number(w.dirty_weight_kg) || 0;
        doneCount++;
      }
      if (w.status === 'cancelled') cancelled++;
      if (w.status === 'stored') stored++;
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
  var line = '• ' + clientName + ' — ' + (wash.dirty_weight_kg || 0) + ' кг, ' +
    (wash.items_total || 0) + ' шт';
  if (wash.deferred_from) line += ' (перенесена с ' + wash.deferred_from + ')';
  return line;
}

function formatDigest_(laundryName, date, report, washLines, shift) {
  var lines = ['📊 ' + laundryName + ' — итоги ' + date, ''];
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
