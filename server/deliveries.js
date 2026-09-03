// Визиты развоза (таблица Deliveries) — порт src/Deliveries.gs.
// Визит = «водитель заезжает к клиенту в день D», без привязки к состоянию белья.
// Статусы: planned → delivered | picked | both | empty, плюс cancelled.
// Мультитенантность: все выборки и записи — в рамках session.laundryId.
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, todayStr_, logEvent, actorOf_ } = require('./audit');
const { addDaysStr_, err_, ok_, clientName_, resolvePrice_, effectiveTariffs_ } = require('./core');
const { requireRole_ } = require('./auth');
const { addStorageEntry_, openStorage_, storageSummaryByClient_ } = require('./storage');

// LockService в GAS; в однопроцессном Node с синхронным better-sqlite3 не нужен.
function withLock_(fn) { return fn(); }

const VISIT_FINAL = ['delivered', 'picked', 'both', 'empty'];

function isOpenVisit_(v) { return v.status === 'planned'; }

// Этаж подъёма (P2): пусто/1/2 = без доплаты; доплачивается всё выше 2-го.
function normalizeLiftFloor_(floor) {
  if (floor === undefined || floor === null || floor === '') return '';
  const n = Math.floor(Number(floor));
  return n > 2 ? String(n) : '';
}

// Визиты на дату (без отменённых), по порядку ord.
function getVisitsByDate_(date, laundryId) {
  return db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return v.date === date && v.status !== 'cancelled';
  }, 1000, laundryId).map(function (r) { return r.obj; })
    .sort(function (a, b) { return (Number(a.ord) || 0) - (Number(b.ord) || 0); });
}

// Визиты недели [monday .. monday+6], сгруппированные по дате.
function getVisitsByWeek_(monday, laundryId) {
  const sun = addDaysStr_(monday, 6);
  return db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return v.date >= monday && v.date <= sun && v.status !== 'cancelled';
  }, 2000, laundryId).map(function (r) { return r.obj; });
}

// Визит + состояние склада клиента (есть чистое / есть грязное).
function decorateVisit_(v, clients, storage) {
  const s = storage[v.client_id] || { dirty: 0, clean: 0, cleanKg: 0, cleanItems: 0, cleanBags: 0 };
  v.client_name = clientName_(v.client_id, clients);
  v.has_clean = s.clean > 0;
  v.has_dirty = s.dirty > 0;
  v.clean_kg = s.cleanKg;
  v.clean_items = s.cleanItems;
  v.clean_stock_bags = s.cleanBags;
  return v;
}

// Строка чужой прачки для API не существует
function findTenantVisit_(visitId, laundryId) {
  const found = db.findById_(SHEETS.DELIVERIES, visitId);
  if (!found || found.obj.laundry_id !== String(laundryId)) return null;
  return found;
}

// --- API ---

function getDeliveryVisits(token, date) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  date = date || todayStr_();
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const storage = storageSummaryByClient_(laundryId);
  // Ленивый require: api.js и deliveries.js взаимно зависят (notReadyForDelivery_ в api.js).
  const { notReadyForDelivery_ } = require('./api');
  return ok_({
    date: date,
    visits: getVisitsByDate_(date, laundryId).map(function (v) { return decorateVisit_(v, clients, storage); }),
    notReady: notReadyForDelivery_(date, laundryId),
    clients: db.getClients_(laundryId).filter(function (c) { return c.active === 'да'; })
  });
}

function addDeliveryVisit(token, clientId, date, ord) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    // Не дублируем: один клиент — один открытый визит на дату
    const dup = getVisitsByDate_(date, laundryId).some(function (v) { return v.client_id === clientId; });
    if (dup) return err_('Клиент уже в развозе на эту дату');
    const v = {
      id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: date, client_id: clientId,
      ord: ord || (getVisitsByDate_(date, laundryId).length + 1), status: 'planned',
      delivered_at: '', pickup: '', driver_comment: '',
      created_by: session.role, created_at: nowStr_()
    };
    db.appendRowTenant_(SHEETS.DELIVERIES, v, laundryId);
    logEvent(actorOf_(session), 'visit_create', v.id, { client_id: clientId, date: date }, laundryId);
    return ok_({ visit: v });
  });
}

// Автовизит: создать planned-визит клиента на дату, если его ещё нет (без дублей,
// без ошибки). Вызывается из updateIssueDate — чистое с новой датой выдачи должно
// появиться в плане/развозе на этот день.
function ensureVisit_(clientId, date, laundryId, actor) {
  const visits = getVisitsByDate_(date, laundryId);
  if (visits.some(function (v) { return v.client_id === clientId; })) return null;
  const v = {
    id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: date, client_id: clientId,
    ord: visits.length + 1, status: 'planned',
    delivered_at: '', pickup: '', driver_comment: '',
    created_by: actor || 'auto', created_at: nowStr_()
  };
  db.appendRowTenant_(SHEETS.DELIVERIES, v, laundryId);
  logEvent(actor || 'auto', 'visit_create', v.id, { client_id: clientId, date: date, auto: true }, laundryId);
  return v;
}

function moveDeliveryVisit(token, visitId, newDate) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantVisit_(visitId, laundryId);
    if (!found) return err_('Визит не найден');
    if (!isOpenVisit_(found.obj)) return err_('Можно переносить только запланированные визиты');
    const old = found.obj.date;
    found.obj.date = newDate;
    db.updateRow_(SHEETS.DELIVERIES, found.rowNumber, found.obj);
    logEvent(actorOf_(session), 'visit_move', visitId, { date: old + ' → ' + newDate }, laundryId);
    return ok_({ visit: found.obj });
  });
}

function removeDeliveryVisit(token, visitId) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantVisit_(visitId, laundryId);
    if (!found) return err_('Визит не найден');
    if (!isOpenVisit_(found.obj)) return err_('Можно убирать только запланированные визиты');
    found.obj.status = 'cancelled';
    db.updateRow_(SHEETS.DELIVERIES, found.rowNumber, found.obj);
    logEvent(actorOf_(session), 'visit_cancel', visitId, {}, laundryId);
    return ok_({ visit: found.obj });
  });
}

// Подтверждение владельцем «только забрать грязное»: чистое на точку не нужно,
// визит перестаёт считаться неготовым к развозу (notReadyForDelivery_).
function setPickupOnly(token, visitId, flag) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantVisit_(visitId, laundryId);
    if (!found) return err_('Визит не найден');
    if (!isOpenVisit_(found.obj)) return err_('Можно менять только запланированные визиты');
    found.obj.pickup_only = flag ? 'да' : '';
    db.updateRow_(SHEETS.DELIVERIES, found.rowNumber, found.obj);
    logEvent(actorOf_(session), 'visit_pickup_only', visitId, { pickup_only: found.obj.pickup_only }, laundryId);
    return ok_({ visit: found.obj });
  });
}

// --- Водитель ---

// Груз водителя по ВСЕМ визитам прачки (любая дата): чистое взятое, но не отданное;
// грязное забранное, но не сданное на склад. Мешки грязного не считаем — по точкам.
function driverCargo_(laundryId) {
  const cargo = { clean_bags: 0, clean_points: 0, dirty_points: 0 };
  db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
    return v.status !== 'cancelled' &&
      ((v.clean_taken_at && v.status !== 'delivered' && v.status !== 'both') ||
       (v.picked_at && !v.dirty_handed_at));
  }, 2000, laundryId).forEach(function (r) {
    const v = r.obj;
    if (v.clean_taken_at && v.status !== 'delivered' && v.status !== 'both') {
      cargo.clean_points++;
      cargo.clean_bags += Number(v.clean_bags) || 0;
    }
    if (v.picked_at && !v.dirty_handed_at) cargo.dirty_points++;
  });
  return cargo;
}

// Статистика дня водителя: сколько точек посещено (любой финальный статус,
// включая empty — водитель до точки доехал) и доплата за подъём (P2).
// Этаж выше 2-го: per_floor=да — за каждый этаж выше 2-го, иначе за факт.
// Цена — как в счёте: тариф клиента → дефолт прачки; без цены — lift_missing.
function driverDayStats_(visits, laundryId) {
  const stats = {
    visited: visits.filter(function (v) { return VISIT_FINAL.indexOf(v.status) >= 0; }).length,
    lift_qty: 0, lift_total: 0, lift_missing: false
  };
  // Прайс и дефолтные тарифы глобальны (v7)
  const lift = db.readAll_(SHEETS.BILLING_ITEMS)
    .filter(function (b) { return b.kind === 'lift' && b.active !== 'нет'; })[0];
  if (!lift) return stats;
  const tariffs = effectiveTariffs_(db.readAll_(SHEETS.CLIENT_TARIFFS), laundryId);
  visits.forEach(function (v) {
    const floor = Math.floor(Number(v.lift_floor) || 0);
    if (floor <= 2) return;
    const qty = lift.per_floor === 'да' ? floor - 2 : 1;
    stats.lift_qty += qty;
    const price = resolvePrice_(tariffs, v.client_id, lift.id);
    if (price === null) stats.lift_missing = true;
    else stats.lift_total += qty * price;
  });
  stats.lift_total = Math.round(stats.lift_total * 100) / 100;
  return stats;
}

// Точки на дату: визиты + состояние склада клиента + груз водителя.
function getDriverRoute(token, date) {
  const session = requireRole_(token, ['driver', 'owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  date = date || todayStr_();
  const clients = {};
  db.getClients_(laundryId).forEach(function (c) { clients[c.id] = c; });
  const storage = storageSummaryByClient_(laundryId);
  const visits = getVisitsByDate_(date, laundryId);
  return ok_({
    date: date,
    laundryName: db.getSettings_(laundryId).LAUNDRY_NAME || 'CleanLab Pro',
    cargo: driverCargo_(laundryId),
    stats: driverDayStats_(visits, laundryId),
    visits: visits.map(function (v) {
      const c = clients[v.client_id] || {};
      v.address = c.address || '';
      v.access_note = c.access_note || '';
      return decorateVisit_(v, clients, storage);
    })
  });
}

// Действия водителя. Статус точки (status) и местонахождение белья — раздельно:
// take_clean    — чистое со склада к водителю (складские записи → consumed_at='driver');
// deliver_clean — чистое отдано клиенту (стирки → issued, точка → delivered/both);
// pickup_dirty  — грязное забрано к водителю (точка → picked/both, склад НЕ трогаем);
// empty         — на точке ничего нет (только если чистое не взято).
// Чистое со склада → водителю по конкретному визиту.
// Возвращает кол-во мешков или null, если чистого на складе нет.
// Мутирует v (clean_taken_at, clean_bags) — запись визита на диске делает вызывающий.
function takeCleanForVisit_(v, laundryId) {
  const clean = openStorage_(v.client_id, 'clean', laundryId);
  if (!clean.length) return null;
  let bags = 0;
  clean.forEach(function (r) {
    // Мешки хранятся на стирке, а не на складской записи
    if (r.obj.wash_id) {
      const w = db.findById_(SHEETS.WASHES, r.obj.wash_id);
      if (w) bags += Number(w.obj.bags) || 0;
    }
    r.obj.consumed_at = 'driver'; // маркер «у водителя»: склад его больше не показывает
    db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
  });
  v.clean_taken_at = nowStr_();
  v.clean_bags = bags;
  return bags;
}

// Массово: взять чистое по всем открытым точкам дня, где оно есть на складе.
function driverTakeAllClean(token, date) {
  const session = requireRole_(token, ['driver', 'owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  date = date || todayStr_();
  return withLock_(function () {
    let taken = 0, bags = 0;
    db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
      return v.date === date && v.status === 'planned' && !v.clean_taken_at;
    }, 1000, laundryId).forEach(function (r) {
      const b = takeCleanForVisit_(r.obj, laundryId);
      if (b === null) return; // чистого нет — точку пропускаем
      db.updateRow_(SHEETS.DELIVERIES, r.rowNumber, r.obj);
      taken++;
      bags += b;
    });
    logEvent(actorOf_(session), 'take_all_clean', date, { points: taken, bags: bags }, laundryId);
    return ok_({ taken: taken, bags: bags });
  });
}

function driverAction(token, visitId, action, liftFloor) {
  const session = requireRole_(token, ['driver', 'owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  const ACTIONS = ['take_clean', 'deliver_clean', 'pickup_dirty', 'both', 'empty'];
  if (ACTIONS.indexOf(action) === -1) return err_('Неизвестное действие');
  return withLock_(function () {
    const found = findTenantVisit_(visitId, laundryId);
    if (!found) return err_('Визит не найден');
    const v = found.obj;
    if (VISIT_FINAL.indexOf(v.status) !== -1) return err_('Визит уже закрыт');

    // Этаж подъёма при подтверждении визита (P2): пусто/1/2 = без доплаты
    if (liftFloor !== undefined) v.lift_floor = normalizeLiftFloor_(liftFloor);

    if (action === 'take_clean') {
      if (v.clean_taken_at) return err_('Чистое уже взято');
      if (takeCleanForVisit_(v, laundryId) === null) return err_('Чистого белья на складе нет');
    }

    if (action === 'both') {
      // «Отдал чистое и забрал грязное» одной кнопкой: обе операции атомарно.
      if (!v.clean_taken_at) return err_('Сначала возьмите чистое на складе');
      if (v.delivered_at) return err_('Чистое уже отдано');
      if (v.picked_at) return err_('Грязное уже забрано');
    }

    if (action === 'deliver_clean' || action === 'both') {
      if (!v.clean_taken_at) return err_('Сначала возьмите чистое на складе');
      // Стирки, чьё чистое уехало к клиенту, помечаются выданными
      db.findRowsByTenant_(SHEETS.STORAGE, function (s) {
        return s.client_id === v.client_id && s.kind === 'clean' && s.consumed_at === 'driver';
      }, 500, laundryId).forEach(function (r) {
        r.obj.consumed_at = nowStr_();
        db.updateRow_(SHEETS.STORAGE, r.rowNumber, r.obj);
        if (r.obj.wash_id) {
          const w = db.findById_(SHEETS.WASHES, r.obj.wash_id);
          if (w && (w.obj.status === 'done' || w.obj.status === 'stored')) {
            w.obj.status = 'issued';
            w.obj.issued_at = nowStr_();
            db.updateRow_(SHEETS.WASHES, w.rowNumber, w.obj);
          }
        }
      });
      v.status = v.picked_at ? 'both' : 'delivered';
      v.delivered_at = nowStr_();
    }

    if (action === 'pickup_dirty' || action === 'both') {
      if (v.picked_at) return err_('Грязное уже забрано');
      v.picked_at = nowStr_();
      v.pickup = 'да';
      // Если чистое уже отдано (или его не было и не взято) — точка закрыта
      if (v.delivered_at) v.status = 'both';
      else if (!v.clean_taken_at) v.status = 'picked';
      // иначе: чистое у водителя, точка остаётся открытой до «Отдал чистое»
    }

    if (action === 'empty') {
      if (v.clean_taken_at) return err_('Чистое уже взято — отвезите его клиенту');
      v.status = 'empty';
      v.delivered_at = nowStr_();
    }

    db.updateRow_(SHEETS.DELIVERIES, found.rowNumber, v);
    logEvent(actorOf_(session), 'visit_' + action, visitId, { client_id: v.client_id, date: v.date }, laundryId);
    if (liftFloor !== undefined) {
      logEvent(actorOf_(session), 'visit_lift', visitId, { floor: v.lift_floor || '—' }, laundryId);
    }
    return ok_({ visit: v, cargo: driverCargo_(laundryId) });
  });
}

// Правка этажа подъёма владельцем задним числом (P2): счёт пересчитывается,
// т.к. строится по текущему lift_floor визита.
function setVisitLiftFloor(token, visitId, floor) {
  const session = requireRole_(token, ['owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantVisit_(visitId, laundryId);
    if (!found) return err_('Визит не найден');
    found.obj.lift_floor = normalizeLiftFloor_(floor);
    db.updateRow_(SHEETS.DELIVERIES, found.rowNumber, found.obj);
    logEvent(actorOf_(session), 'visit_lift', visitId, { floor: found.obj.lift_floor || '—' }, laundryId);
    return ok_({ visit: found.obj });
  });
}

// «Передать грязное на склад»: всё забранное грязное уезжает на склад разом.
function driverHandover(token) {
  const session = requireRole_(token, ['driver', 'owner']);
  if (!session) return err_('Нет доступа');
  const laundryId = session.laundryId;
  return withLock_(function () {
    const rows = db.findRowsByTenant_(SHEETS.DELIVERIES, function (v) {
      return v.status !== 'cancelled' && v.picked_at && !v.dirty_handed_at;
    }, 1000, laundryId);
    rows.forEach(function (r) {
      addStorageEntry_(r.obj.client_id, 'dirty', {}, laundryId);
      r.obj.dirty_handed_at = nowStr_();
      db.updateRow_(SHEETS.DELIVERIES, r.rowNumber, r.obj);
    });
    if (rows.length) logEvent(actorOf_(session), 'visit_handover', '-', { visits: rows.length }, laundryId);
    return ok_({ handed: rows.length, cargo: driverCargo_(laundryId) });
  });
}

// --- Одноразовая миграция (в GAS запускалась вручную из редактора) ---

// Чистое на складе (done/stored) с датой выдачи сегодня или позже должно быть
// в плане/развозе — раньше смена issue_date визит не создавала. Дедуп — через
// ensureVisit_ (один клиент — один визит на дату). Запуск: node -e "require('./deliveries').migrateIssueDatesToVisits()"
function migrateIssueDatesToVisits() {
  return withLock_(function () {
    const today = todayStr_();
    let created = 0;
    db.readTail_(SHEETS.WASHES, 5000).forEach(function (w) {
      if (w.status !== 'done' && w.status !== 'stored') return;
      if (!w.client_id || !w.issue_date || w.issue_date < today) return;
      if (ensureVisit_(w.client_id, w.issue_date, w.laundry_id || '1', 'migration')) created++;
    });
    if (created) logEvent('migration', 'migrate_issue_dates', '-', { created: created });
    console.log('migrateIssueDatesToVisits: создано визитов ' + created);
    return created;
  });
}

// До смены модели «Неделя» хранила карточки как стирки (Washes), теперь это
// визиты развоза (Deliveries). Переносим: дата визита = issue_date стирки
// (день выдачи), дедуп по клиент+дата, отменённые стирки пропускаем.
// Тенант визита наследуется от стирки.
function migrateWashesToVisits() {
  return withLock_(function () {
    const existing = {};
    db.readTail_(SHEETS.DELIVERIES, 5000).forEach(function (v) {
      existing[v.client_id + '|' + v.date] = true;
    });
    let created = 0;
    db.readTail_(SHEETS.WASHES, 5000).forEach(function (w) {
      if (w.status === 'cancelled') return;
      const date = w.issue_date || w.wash_date;
      const key = w.client_id + '|' + date;
      if (!w.client_id || !date || existing[key]) return;
      existing[key] = true;
      db.appendRow_(SHEETS.DELIVERIES, {
        id: db.nextId_(SHEETS.DELIVERIES, 'del'), date: date, client_id: w.client_id,
        ord: 0, status: 'planned',
        delivered_at: '', pickup: '', driver_comment: '',
        created_by: 'migration', created_at: nowStr_(),
        laundry_id: w.laundry_id || '1'
      });
      created++;
    });
    if (created) logEvent('migration', 'migrate_visits', '-', { created: created });
    console.log('migrateWashesToVisits: создано визитов ' + created);
    return created;
  });
}

module.exports = {
  VISIT_FINAL, isOpenVisit_, getVisitsByDate_, getVisitsByWeek_, decorateVisit_, ensureVisit_,
  getDeliveryVisits, addDeliveryVisit, moveDeliveryVisit, removeDeliveryVisit, setPickupOnly,
  driverCargo_, getDriverRoute, takeCleanForVisit_, driverTakeAllClean,
  driverAction, driverHandover, setVisitLiftFloor, normalizeLiftFloor_,
  migrateWashesToVisits, migrateIssueDatesToVisits
};
