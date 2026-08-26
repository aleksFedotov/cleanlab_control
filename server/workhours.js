// Учёт рабочих часов работников (таблица WorkHours) + статистика точек развоза.
// Часы отмечает сам работник (только себе) или владелец (любому работнику прачки).
// Статистика развозов считается автоматически из Deliveries: «выполненная точка» —
// визит с delivered_at или picked_at; водитель на прачке один, привязки к user_id нет.
// Мультитенантность: все выборки и записи — в рамках session.laundryId.
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, logEvent, actorOf_ } = require('./audit');
const { err_, ok_ } = require('./core');
const { requireRole_ } = require('./auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Строка часов работника на дату в рамках тенанта (для upsert).
function findEntry_(userId, date, laundryId) {
  const rows = db.findRowsByTenant_(SHEETS.WORK_HOURS, function (r) {
    return r.user_id === String(userId) && r.date === date;
  }, 1000, laundryId);
  return rows.length ? rows[rows.length - 1] : null;
}

// Отметка/правка часов. Работник — только себе; владелец — любому работнику
// своей прачки. hours=0 или пусто — удалить отметку. Дата любая (в т.ч. будущая).
function setWorkHours(token, userId, date, hours) {
  const session = requireRole_(token, ['worker', 'owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  if (!DATE_RE.test(date || '')) return err_('Некорректная дата');
  const h = hours === '' || hours === null || hours === undefined ? null : Number(hours);
  if (h !== null && (!isFinite(h) || h < 0 || h > 24)) return err_('Часы: число от 0 до 24');
  if (session.role === 'worker') {
    // Работник пишет только себе; userId можно опустить — подставляем из сессии
    if (userId && String(userId) !== String(session.userId)) return err_('Нет доступа');
    userId = session.userId;
  }
  // Цель — активный работник этой прачки (для owner проверяем явно)
  const target = db.findById_('Users', userId);
  if (!target || target.obj.role !== 'worker' || target.obj.laundry_id !== String(laundryId)) {
    return err_('Работник не найден');
  }
  const existing = findEntry_(userId, date, laundryId);
  if (h === null || h === 0) {
    if (existing) {
      db.deleteRow_(SHEETS.WORK_HOURS, existing.rowNumber);
      logEvent(actorOf_(session), 'workhours_clear', existing.obj.id, { user_id: userId, date: date }, laundryId);
    }
    return ok_({ cleared: true });
  }
  if (existing) {
    existing.obj.hours = String(h);
    existing.obj.updated_by = actorOf_(session);
    existing.obj.updated_at = nowStr_();
    db.updateRow_(SHEETS.WORK_HOURS, existing.rowNumber, existing.obj);
    logEvent(actorOf_(session), 'workhours_set', existing.obj.id, { user_id: userId, date: date, hours: h }, laundryId);
    return ok_({ entry: existing.obj });
  }
  const entry = {
    id: db.nextId_(SHEETS.WORK_HOURS, 'wh'), user_id: String(userId), date: date,
    hours: String(h), updated_by: actorOf_(session), updated_at: nowStr_()
  };
  db.appendRowTenant_(SHEETS.WORK_HOURS, entry, laundryId);
  logEvent(actorOf_(session), 'workhours_set', entry.id, { user_id: userId, date: date, hours: h }, laundryId);
  return ok_({ entry: entry });
}

// Часы за период. Работник — только свои; владелец — всех работников прачки
// + список работников (табель показывает и тех, у кого нет отметок).
function getWorkHours(token, from, to) {
  const session = requireRole_(token, ['worker', 'owner']);
  if (!session) return err_('Нет доступа');
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    return err_('Некорректный период');
  }
  const laundryId = session.laundryId;
  const pred = function (r) {
    return r.date >= from && r.date <= to &&
      (session.role === 'owner' || r.user_id === String(session.userId));
  };
  // Полный скан: период может быть годовым, хвостового лимита недостаточно
  const entries = db.findRowsByTenant_(SHEETS.WORK_HOURS, pred, 100000, laundryId)
    .map(function (r) { return r.obj; });
  const res = { entries: entries };
  if (session.role === 'owner') {
    res.workers = db.readAll_('Users').filter(function (u) {
      return u.role === 'worker' && u.laundry_id === String(laundryId) && u.active === 'да';
    }).map(function (u) { return { id: u.id, name: u.name }; });
  }
  return ok_(res);
}

// Статистика точек развоза по дням (owner). «Выполненная точка» — визит,
// где закрыт хотя бы один трек: delivered_at (отвёз чистое) или picked_at
// (забрал грязное). Точки «empty» и «cancelled» не считаются.
function getDeliveryPointStats(token, from, to) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    return err_('Некорректный период');
  }
  const laundryId = session.laundryId;
  const visits = db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return v.date >= from && v.date <= to && v.status !== 'cancelled';
  }, 100000, laundryId).map(function (r) { return r.obj; });
  const byDate = {};
  visits.forEach(function (v) {
    const delivered = !!v.delivered_at && v.status !== 'empty';
    const picked = !!v.picked_at;
    if (!delivered && !picked) return;
    const d = byDate[v.date] || (byDate[v.date] = { date: v.date, total: 0, only_delivery: 0, only_pickup: 0, both: 0 });
    d.total++;
    if (delivered && picked) d.both++;
    else if (delivered) d.only_delivery++;
    else d.only_pickup++;
  });
  const days = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
  return ok_({ from: from, to: to, days: days });
}

module.exports = { setWorkHours, getWorkHours, getDeliveryPointStats };
