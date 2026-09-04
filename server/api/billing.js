// Прайс и счета (P2, docs/tickets.md). Owner-only, события в Log.
// Вынесено из api.js при делёжке (R1); код перенесён как есть.
const { SHEETS } = require('../schema');
const db = require('../db');
const { logEvent, actorOf_ } = require('../audit');
const { requireRole_ } = require('../auth');
const core = require('../core');
const { err_, ok_, withLock_, findTenantRow_ } = core;

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
module.exports = {
  BILLING_KINDS, billingItems_,
  listBillingItems, saveBillingItem, deleteBillingItem,
  listTariffs, saveTariff, saveClientItemBilling, listClientItemBilling, getClientInvoice
};
