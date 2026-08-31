// Зарплаты (P3): авторасчёт по точкам развоза (водители) и табелю (работники).
// Водитель: точки × ставка_за_точку + этажи × ставка_подъёма + корректировки.
// Точка — выполненный визит прачки: status не cancelled/empty и закрыт хотя бы
// один трек (delivered_at или picked_at); «только забор» — тоже точка. Привязки
// к user_id нет: водитель на прачке один, все водители получают одинаковые цифры.
// Работник: shift_base / shift_norm_hours × часы (WorkHours) + корректировки.
// Ставки: PayRates (непустое поле) → Settings[PAY_*] → встроенный дефолт.
// Округление — один раз на итоге периода. Мультитенантность — по session.laundryId.
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, logEvent, actorOf_ } = require('./audit');
const { err_, ok_ } = require('./core');
const { requireRole_ } = require('./auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Дефолтные ставки прачки: ключ Settings → встроенный дефолт.
const RATE_DEFAULTS = {
  point_rate: { key: 'PAY_POINT_RATE', def: 250 },
  lift_floor_rate: { key: 'PAY_LIFT_FLOOR_RATE', def: 100 },
  shift_base: { key: 'PAY_SHIFT_BASE', def: 4000 },
  shift_norm_hours: { key: 'PAY_SHIFT_NORM_HOURS', def: 12 }
};

function num_(v) {
  const n = Number(v);
  return v !== '' && v !== null && v !== undefined && isFinite(n) ? n : null;
}

// Ставка по цепочке: PayRates → Settings → дефолт. Вернёт { value, missing }.
// «Стёртый дефолт» (ключ в Settings есть, но пуст/не число) без override —
// аномалия: ставка 0 и missing=true, сотрудника молча не пропускаем.
function resolveRate_(field, rateRow, settings) {
  const fromRow = rateRow ? num_(rateRow[field]) : null;
  if (fromRow !== null) return { value: fromRow, missing: false };
  const conf = RATE_DEFAULTS[field];
  if (Object.prototype.hasOwnProperty.call(settings, conf.key)) {
    const fromSettings = num_(settings[conf.key]);
    if (fromSettings !== null) return { value: fromSettings, missing: false };
    return { value: 0, missing: true };
  }
  return { value: conf.def, missing: false };
}

// Выполненный визит для зарплаты водителя (строже getDeliveryPointStats:
// empty не считается вовсе, даже с picked_at).
function isPaidVisit_(v) {
  return v.status !== 'cancelled' && v.status !== 'empty' && (v.delivered_at || v.picked_at);
}

// Чистая функция расчёта. Все данные — входом (уже отфильтрованные по прачке).
// Даты — строки 'yyyy-MM-dd', сравнение строками.
function computePayroll_(input) {
  const from = input.from, to = input.to;
  const settings = input.settings || {};
  const users = (input.users || []).filter(function (u) {
    return u.role !== 'owner' && u.active === 'да';
  });
  const ratesByUser = {};
  (input.payRates || []).forEach(function (r) { ratesByUser[r.user_id] = r; });

  // Визиты прачки за период (общие для всех водителей) с разбивкой по дням
  const dayVisits = {};
  (input.deliveries || []).forEach(function (v) {
    if (v.date < from || v.date > to || !isPaidVisit_(v)) return;
    const d = dayVisits[v.date] || (dayVisits[v.date] = { points: 0, lift_floors: 0 });
    d.points++;
    const floor = Number(v.lift_floor) || 0;
    if (floor > 2) d.lift_floors += floor - 2;
  });

  // Часы работников по user_id и дням
  const hoursBy = {};
  (input.workHours || []).forEach(function (w) {
    if (w.date < from || w.date > to) return;
    const h = Number(w.hours) || 0;
    if (!h) return;
    const u = hoursBy[w.user_id] || (hoursBy[w.user_id] = {});
    u[w.date] = (u[w.date] || 0) + h;
  });

  // Корректировки по user_id и дням
  const adjBy = {};
  (input.adjustments || []).forEach(function (a) {
    if (a.date < from || a.date > to) return;
    const amt = Number(a.amount) || 0;
    const u = adjBy[a.user_id] || (adjBy[a.user_id] = {});
    u[a.date] = (u[a.date] || 0) + amt;
  });

  const employees = users.map(function (u) {
    const rateRow = ratesByUser[u.id];
    const pointRate = resolveRate_('point_rate', rateRow, settings);
    const liftRate = resolveRate_('lift_floor_rate', rateRow, settings);
    const shiftBase = resolveRate_('shift_base', rateRow, settings);
    const shiftNorm = resolveRate_('shift_norm_hours', rateRow, settings);
    const adj = adjBy[u.id] || {};

    const dayMap = {};
    let points = 0, liftFloors = 0, hours = 0, adjustmentsTotal = 0;
    function day(date) {
      return dayMap[date] || (dayMap[date] = { date: date, points: 0, lift_floors: 0, hours: 0, amount: 0 });
    }
    if (u.role === 'driver') {
      Object.keys(dayVisits).forEach(function (date) {
        const dv = dayVisits[date];
        const d = day(date);
        d.points = dv.points;
        d.lift_floors = dv.lift_floors;
        d.amount = dv.points * pointRate.value + dv.lift_floors * liftRate.value;
        points += dv.points;
        liftFloors += dv.lift_floors;
      });
    } else if (u.role === 'worker') {
      const perDay = hoursBy[u.id] || {};
      const rate = shiftNorm.value ? shiftBase.value / shiftNorm.value : 0;
      Object.keys(perDay).forEach(function (date) {
        const d = day(date);
        d.hours = perDay[date];
        d.amount = rate * perDay[date];
        hours += perDay[date];
      });
    }
    Object.keys(adj).forEach(function (date) {
      day(date).amount += adj[date];
      adjustmentsTotal += adj[date];
    });

    const amountPoints = points * pointRate.value;
    const amountLifts = liftFloors * liftRate.value;
    const amountShift = u.role === 'worker' && shiftNorm.value
      ? shiftBase.value / shiftNorm.value * hours : 0;
    const days = Object.keys(dayMap).sort().map(function (k) { return dayMap[k]; });
    return {
      user_id: u.id, name: u.name, role: u.role,
      points: points, lift_floors: liftFloors, hours: hours,
      point_rate: pointRate.value, lift_floor_rate: liftRate.value,
      shift_base: shiftBase.value, shift_norm_hours: shiftNorm.value,
      amount_points: amountPoints, amount_lifts: amountLifts, amount_shift: amountShift,
      adjustments_total: adjustmentsTotal,
      total: Math.round(amountPoints + amountLifts + amountShift + adjustmentsTotal),
      rate_missing: pointRate.missing || liftRate.missing || shiftBase.missing || shiftNorm.missing,
      days: days
    };
  });
  return { from: from, to: to, employees: employees };
}

// Собрать вход computePayroll_ по прачке сессии.
function loadPayrollInput_(laundryId, from, to) {
  const max = 100000; // findRowsByTenant_ сканирует только хвост — лимит завышаем
  return {
    from: from, to: to,
    users: db.findRowsByTenant_(SHEETS.USERS, function () { return true; }, max, laundryId)
      .map(function (r) { return r.obj; }),
    deliveries: db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
      return v.date >= from && v.date <= to;
    }, max, laundryId).map(function (r) { return r.obj; }),
    workHours: db.findRowsByTenant_(SHEETS.WORK_HOURS, function (w) {
      return w.date >= from && w.date <= to;
    }, max, laundryId).map(function (r) { return r.obj; }),
    payRates: db.findRowsByTenant_(SHEETS.PAY_RATES, function () { return true; }, max, laundryId)
      .map(function (r) { return r.obj; }),
    adjustments: db.findRowsByTenant_(SHEETS.PAY_ADJUSTMENTS, function (a) {
      return a.date >= from && a.date <= to;
    }, max, laundryId).map(function (r) { return r.obj; }),
    settings: db.getSettings_(laundryId)
  };
}

// Расчёт по всем сотрудникам прачки (owner).
function getPayroll(token, from, to) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    return err_('Некорректный период');
  }
  return ok_(computePayroll_(loadPayrollInput_(session.laundryId, from, to)));
}

// Водитель — свой авто-отчёт за период (без чужих данных).
function getMyPayroll(token, from, to) {
  const session = requireRole_(token, ['driver']);
  if (!session) return err_('Нет доступа');
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    return err_('Некорректный период');
  }
  const res = computePayroll_(loadPayrollInput_(session.laundryId, from, to));
  const me = res.employees.filter(function (e) {
    return e.user_id === String(session.userId);
  })[0];
  if (!me) return err_('Сотрудник не найден');
  return ok_({
    from: res.from, to: res.to,
    points: me.points, lift_floors: me.lift_floors,
    point_rate: me.point_rate, lift_floor_rate: me.lift_floor_rate,
    amount_points: me.amount_points, amount_lifts: me.amount_lifts,
    adjustments_total: me.adjustments_total, total: me.total,
    rate_missing: me.rate_missing, days: me.days
  });
}

// Ставки прачки + имена сотрудников (owner).
function listPayRates(token) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const namesBy = {};
  db.findRowsByTenant_(SHEETS.USERS, function () { return true; }, 100000, laundryId)
    .forEach(function (r) { namesBy[r.obj.id] = r.obj.name; });
  const rates = db.findRowsByTenant_(SHEETS.PAY_RATES, function () { return true; }, 100000, laundryId)
    .map(function (r) {
      const o = r.obj;
      return {
        id: o.id, user_id: o.user_id, name: namesBy[o.user_id] || o.user_id,
        point_rate: o.point_rate, lift_floor_rate: o.lift_floor_rate,
        shift_base: o.shift_base, shift_norm_hours: o.shift_norm_hours
      };
    });
  return ok_({ rates: rates });
}

// Проверка: цель — сотрудник прачки сессии (как в setWorkHours).
function checkTarget_(session, userId) {
  const target = db.findById_('Users', userId);
  if (!target || target.obj.laundry_id !== String(session.laundryId)) return null;
  return target;
}

// Upsert переопределения ставок сотрудника (owner). Принимаем только 4 числовых
// поля; пустое значение = '' (действует дефолт прачки).
function savePayRate(token, userId, fields) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  if (!checkTarget_(session, userId)) return err_('Нет доступа');
  fields = fields || {};
  const clean = {};
  for (const f of Object.keys(RATE_DEFAULTS)) {
    const v = fields[f];
    if (v === '' || v === null || v === undefined) { clean[f] = ''; continue; }
    const n = Number(v);
    if (!isFinite(n) || n < 0) return err_('Ставка: неотрицательное число или пусто');
    clean[f] = String(n);
  }
  const existing = db.findRowsByTenant_(SHEETS.PAY_RATES, function (r) {
    return r.user_id === String(userId);
  }, 1000, laundryId);
  const row = existing.length ? existing[existing.length - 1] : null;
  if (row) {
    Object.keys(clean).forEach(function (f) { row.obj[f] = clean[f]; });
    db.updateRow_(SHEETS.PAY_RATES, row.rowNumber, row.obj);
    logEvent(actorOf_(session), 'payrate_set', row.obj.id, { user_id: userId, fields: clean }, laundryId);
    return ok_({ rate: row.obj });
  }
  const entry = {
    id: db.nextId_(SHEETS.PAY_RATES, 'pr'), user_id: String(userId),
    point_rate: clean.point_rate, lift_floor_rate: clean.lift_floor_rate,
    shift_base: clean.shift_base, shift_norm_hours: clean.shift_norm_hours
  };
  db.appendRowTenant_(SHEETS.PAY_RATES, entry, laundryId);
  logEvent(actorOf_(session), 'payrate_set', entry.id, { user_id: userId, fields: clean }, laundryId);
  return ok_({ rate: entry });
}

// Ручная корректировка (owner): премия/штраф суммой со знаком на дату.
function savePayAdjustment(token, userId, date, amount, comment) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  if (!DATE_RE.test(date || '')) return err_('Некорректная дата');
  const amt = Number(amount);
  if (amount === '' || amount === null || amount === undefined || !isFinite(amt)) {
    return err_('Сумма: число со знаком');
  }
  if (!checkTarget_(session, userId)) return err_('Нет доступа');
  const entry = {
    id: db.nextId_(SHEETS.PAY_ADJUSTMENTS, 'adj'), user_id: String(userId),
    date: date, amount: String(amt), comment: String(comment || ''),
    created_by: session.name, created_at: nowStr_()
  };
  db.appendRowTenant_(SHEETS.PAY_ADJUSTMENTS, entry, laundryId);
  logEvent(actorOf_(session), 'pay_adjust', entry.id,
    { user_id: userId, date: date, amount: amt, comment: entry.comment }, laundryId);
  return ok_({ adjustment: entry });
}

// Список корректировок прачки (owner), опционально по user_id и периоду дат.
function listPayAdjustments(token, userId, from, to) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return err_('Некорректный период');
  }
  if (from && to && from > to) return err_('Некорректный период');
  const namesBy = {};
  db.findRowsByTenant_(SHEETS.USERS, function () { return true; }, 100000, laundryId)
    .forEach(function (r) { namesBy[r.obj.id] = r.obj.name; });
  const adjustments = db.findRowsByTenant_(SHEETS.PAY_ADJUSTMENTS, function (a) {
    if (userId && a.user_id !== String(userId)) return false;
    if (from && a.date < from) return false;
    if (to && a.date > to) return false;
    return true;
  }, 100000, laundryId).map(function (r) {
    const o = r.obj;
    return {
      id: o.id, user_id: o.user_id, name: namesBy[o.user_id] || o.user_id,
      date: o.date, amount: Number(o.amount) || 0, comment: o.comment,
      created_by: o.created_by, created_at: o.created_at
    };
  });
  return ok_({ adjustments: adjustments });
}

// Удаление корректировки (owner, только своей прачки).
function deletePayAdjustment(token, adjId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const found = db.findById_(SHEETS.PAY_ADJUSTMENTS, adjId);
  if (!found || found.obj.laundry_id !== String(laundryId)) return err_('Корректировка не найдена');
  db.deleteRow_(SHEETS.PAY_ADJUSTMENTS, found.rowNumber);
  logEvent(actorOf_(session), 'pay_adjust_del', adjId,
    { user_id: found.obj.user_id, date: found.obj.date, amount: found.obj.amount }, laundryId);
  return ok_({ deleted: true });
}

// Действующие дефолтные ставки прачки (owner): Settings → встроенный дефолт.
function listPaySettings(token) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const settings = db.getSettings_(session.laundryId);
  const out = {};
  Object.keys(RATE_DEFAULTS).forEach(function (f) {
    const conf = RATE_DEFAULTS[f];
    const v = Object.prototype.hasOwnProperty.call(settings, conf.key)
      ? num_(settings[conf.key]) : null;
    out[f] = v !== null ? v : conf.def;
  });
  return ok_({ settings: out });
}

// Дефолтные ставки прачки (owner). Пустое поле = удалить ключ из Settings
// (возврат к встроенному дефолту), а не записать '' — записанная пустая строка
// для resolveRate_ выглядит как «стёртый дефолт» → rate_missing у всех.
function savePaySettings(token, fields) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  fields = fields || {};
  const clean = {};
  for (const f of Object.keys(RATE_DEFAULTS)) {
    const v = fields[f];
    if (v === '' || v === null || v === undefined) { clean[f] = ''; continue; }
    const n = Number(v);
    if (!isFinite(n) || n < 0) return err_('Ставка: неотрицательное число или пусто');
    clean[f] = String(n);
  }
  Object.keys(clean).forEach(function (f) {
    const key = RATE_DEFAULTS[f].key;
    if (clean[f] === '') {
      const found = db.findRowsByTenant_(SHEETS.SETTINGS, function (r) {
        return r.key === key;
      }, 10, laundryId);
      found.forEach(function (r) { db.deleteRow_(SHEETS.SETTINGS, r.rowNumber); });
    } else {
      db.setTenantSetting_(laundryId, key, clean[f]);
    }
  });
  db.invalidateRefCache_(); // Settings кэшируются (getSettings_) — сбрасываем
  logEvent(actorOf_(session), 'pay_settings_set', String(laundryId), { fields: clean }, laundryId);
  return ok_({ settings: clean });
}

module.exports = {
  computePayroll_,
  getPayroll, getMyPayroll, listPayRates,
  savePayRate, savePayAdjustment, deletePayAdjustment, listPayAdjustments,
  listPaySettings, savePaySettings
};
