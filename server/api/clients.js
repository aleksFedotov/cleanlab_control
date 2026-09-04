// Справочники клиентов и видов белья (owner). Записи сбрасывают кэш (spec §10).
// Вынесено из api.js при делёжке (R1); код перенесён как есть.
const { SHEETS } = require('../schema');
const db = require('../db');
const { logEvent, actorOf_ } = require('../audit');
const { err_, ok_, withLock_, findTenantRow_ } = require('../core');

// --- Справочники (owner). Записи сбрасывают кэш (spec §10) ---

// «Как добраться» — заметка для водителей (обрезка до 2000, не ошибка).
function normalizeAccessNote_(v) {
  return String(v || '').trim().slice(0, 2000);
}

function saveClient(session, client) {
  const laundryId = session.laundryId;
  return withLock_(function () {
    // Нормализация новых полей: item_types — JSON-массив id, accounting — weight|count|both
    if (client.item_types !== undefined) {
      client.item_types = Array.isArray(client.item_types) && client.item_types.length
        ? JSON.stringify(client.item_types) : '';
    }
    if (client.accounting !== undefined &&
        ['weight', 'count', 'both'].indexOf(client.accounting) === -1) {
      client.accounting = '';
    }
    let saved;
    if (client.id) {
      const found = findTenantRow_(SHEETS.CLIENTS, client.id, laundryId);
      if (!found) return err_('Клиент не найден');
      Object.keys(client).forEach(function (k) { found.obj[k] = client[k]; });
      found.obj.access_note = normalizeAccessNote_(found.obj.access_note);
      db.updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
      saved = found.obj;
    } else {
      saved = {
        id: db.nextId_(SHEETS.CLIENTS, 'cli'), name: client.name || '',
        contact: client.contact || '', address: client.address || '',
        type: client.type || 'прочее',
        active: 'да', comment: client.comment || '',
        item_types: client.item_types || '', accounting: client.accounting || '',
        inn: client.inn || '', kpp: client.kpp || '', legal_address: client.legal_address || '',
        access_note: normalizeAccessNote_(client.access_note)
      };
      db.appendRowTenant_(SHEETS.CLIENTS, saved, laundryId);
    }
    db.invalidateRefCache_();
    return ok_({ client: saved });
  });
}

// Удаление = архивация (active=нет, spec §7.3).
function deleteClient(session, clientId) {
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
    if (!found) return err_('Клиент не найден');
    found.obj.active = 'нет';
    db.updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
    db.invalidateRefCache_();
    return ok_({ client: found.obj });
  });
}

// Физическое удаление клиента. Стирки/визиты блокируют (история счетов);
// тарифы и привязки клиента чистятся каскадно — без клиента они мусор.
function purgeClient(session, clientId) {
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
    if (!found) return err_('Клиент не найден');
    const used = db.findRowsByTenant_(SHEETS.WASHES, function (w) {
      return w.client_id === clientId;
    }, 1, laundryId).length
      || db.findRowsByTenant_(SHEETS.DELIVERIES, function (d) {
        return d.client_id === clientId;
      }, 1, laundryId).length;
    if (used) return err_('Клиент используется в стирках или визитах — можно только архивировать');
    db.findRowsByTenant_(SHEETS.CLIENT_TARIFFS, function (t) {
      return t.client_id === clientId;
    }, 1000, laundryId).forEach(function (t) {
      db.deleteRow_(SHEETS.CLIENT_TARIFFS, t.rowNumber);
    });
    db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
      return r.client_id === clientId;
    }, 1000, laundryId).forEach(function (r) {
      db.deleteRow_(SHEETS.CLIENT_ITEM_BILLING, r.rowNumber);
    });
    db.deleteRow_(SHEETS.CLIENTS, found.rowNumber);
    db.invalidateRefCache_();
    logEvent(actorOf_(session), 'client_purge', clientId, { name: found.obj.name }, laundryId);
    return ok_({});
  });
}

// Создавать новый тип («Другое…») может и работник с экрана стирки;
// переименование существующего — только владелец. Базовая роль (owner|worker)
// проверяется в mountApi по API_ROLES; здесь — уточнение для правки.
// billing_item_id — позиция в счёте (только штучная wash_pcs, пусто = в счёт по весу).
function saveItemType(session, itemType) {
  if (itemType && itemType.id && session.role !== 'owner') return err_('Нет доступа');
  if (itemType.billing_item_id !== undefined) {
    const bid = String(itemType.billing_item_id || '');
    if (bid) {
      const bi = db.findById_(SHEETS.BILLING_ITEMS, bid);
      if (!bi || bi.obj.kind !== 'wash_pcs') return err_('Позиция в счёте должна быть штучной');
    }
    itemType.billing_item_id = bid;
  }
  return withLock_(function () {
    let saved;
    if (itemType.id) {
      const found = db.findById_(SHEETS.ITEM_TYPES, itemType.id);
      if (!found) return err_('Тип не найден');
      Object.keys(itemType).forEach(function (k) { found.obj[k] = itemType[k]; });
      db.updateRow_(SHEETS.ITEM_TYPES, found.rowNumber, found.obj);
      saved = found.obj;
    } else {
      let maxSort = 0;
      db.getItemTypes_().forEach(function (t) { maxSort = Math.max(maxSort, Number(t.sort) || 0); });
      saved = {
        id: db.nextId_(SHEETS.ITEM_TYPES, 'itm'), name: itemType.name || '',
        sort: maxSort + 1, active: 'да', billing_item_id: itemType.billing_item_id || ''
      };
      db.appendRow_(SHEETS.ITEM_TYPES, saved);
    }
    db.invalidateRefCache_();
    return ok_({ itemType: saved });
  });
}

// Работник с экрана стирки добавил вид белья и попросил запомнить его для клиента.
// Имеет смысл только когда у клиента уже настроен свой список (иначе показываются все типы).
function rememberClientItemType(session, clientId, itemTypeId) {
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = findTenantRow_(SHEETS.CLIENTS, clientId, laundryId);
    if (!found) return err_('Клиент не найден');
    const list = db.parseJsonList_(found.obj.item_types) || [];
    if (list.indexOf(itemTypeId) === -1) {
      list.push(itemTypeId);
      found.obj.item_types = JSON.stringify(list);
      db.updateRow_(SHEETS.CLIENTS, found.rowNumber, found.obj);
      db.invalidateRefCache_();
    }
    return ok_({ client: found.obj });
  });
}

// Физическое удаление вида белья. Блокируется, если вид привязан
// у клиента (item_types) или есть per-клиентская привязка к позиции счёта —
// иначе только архивация (active=нет). ItemTypes — глобальный справочник
// (без laundry_id), клиентов проверяем только своей прачки.
function deleteItemType(session, itemTypeId) {
  const laundryId = session.laundryId;
  return withLock_(function () {
    const found = db.findById_(SHEETS.ITEM_TYPES, itemTypeId);
    if (!found) return err_('Тип не найден');
    const inClients = db.getClients_(laundryId).some(function (c) {
      return (db.parseJsonList_(c.item_types) || []).indexOf(itemTypeId) !== -1;
    });
    const inBindings = db.findRowsByTenant_(SHEETS.CLIENT_ITEM_BILLING, function (r) {
      return r.item_type_id === itemTypeId;
    }, 1, laundryId).length;
    if (inClients || inBindings) {
      return err_('Вид белья используется у клиентов — можно только архивировать');
    }
    db.deleteRow_(SHEETS.ITEM_TYPES, found.rowNumber);
    db.invalidateRefCache_();
    logEvent(actorOf_(session), 'item_type_delete', itemTypeId, { name: found.obj.name }, laundryId);
    return ok_({});
  });
}

// Полные справочники для экрана владельца (включая архивные).
function getRefs(session) {
  return ok_({ clients: db.getClients_(session.laundryId), itemTypes: db.getItemTypes_() });
}
module.exports = {
  saveClient, deleteClient, purgeClient,
  saveItemType, deleteItemType, rememberClientItemType, getRefs
};
