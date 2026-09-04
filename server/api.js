// Серверное API (spec §6) — порт src/Api.gs.
// Мультитенантность: прачка берётся из сессии (session.laundryId), все чтения/записи
// операционных таблиц фильтруются по ней; строка чужой прачки для API не существует.
// LockService не нужен: однопроцессный Node + синхронный better-sqlite3.
// Express-монтирование: каждая публичная функция → POST /api/<имя>, тело { args: [...] }.
// Фасад (R1): доменная логика в модулях api/*, здесь — таблица ролей, сборка api
// и монтирование. Проверка роли — в mountApi до вызова метода (шаг 3).
const core = require('./core');
const { err_, ok_, withLock_, round1_, timeStr_, ensureShift_, getShiftByDate_ } = core;
const deliveries = require('./deliveries');
const workhours = require('./workhours');
const payroll = require('./payroll');
const {
  listBillingItems, saveBillingItem, deleteBillingItem,
  listTariffs, saveTariff, saveClientItemBilling, listClientItemBilling, getClientInvoice
} = require('./api/billing');
const {
  listUsers, createUser, updateUser, resetUserPassword,
  deactivateUser, reactivateUser, deleteUser,
  makeTelegramBindCode, consumeTelegramBindCode_
} = require('./api/users');
const {
  saveClient, deleteClient, purgeClient,
  saveItemType, deleteItemType, rememberClientItemType, getRefs
} = require('./api/clients');
const {
  listLaundries, createLaundry, updateLaundry, deactivateLaundry, getTvData
} = require('./api/laundries');
const {
  ensureWashesFromDelivery_, notReadyForDelivery_, materializeTodayAllLaundries_,
  getDayList, startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport, getSummaryReport, getFinanceSummary
} = require('./api/washes');

// --- Таблица ролей (R1, шаг 3) ---
// Метод → разрешённые роли. Значения перенесены один в один из requireRole_-
// вызовов тел методов (api/*, deliveries.js, workhours.js, payroll.js, auth.js).
// login, logout, getTvData — без проверки (getTvData авторизуется ключом прачки).
const OWNER = ['owner'];
const OWNER_WORKER = ['owner', 'worker'];
const DRIVER_OWNER = ['driver', 'owner'];
const API_ROLES = {
  // auth.js (token-first, самопроверка внутри)
  switchLaundry: OWNER,
  // api/washes.js
  getDayList: OWNER_WORKER, startWash: OWNER_WORKER, completeWash: OWNER_WORKER,
  editWashData: OWNER_WORKER, deferWash: OWNER_WORKER, holdPartialWash: OWNER,
  addUnplannedWash: OWNER_WORKER, getShiftCloseState: OWNER_WORKER, closeShift: OWNER_WORKER,
  getDeliveryPlan: OWNER, addToDelivery: OWNER, cancelWash: OWNER, deleteWash: OWNER_WORKER,
  confirmStorageCheck: OWNER_WORKER, markIssued: OWNER, updateIssueDate: OWNER,
  getWeekPlan: OWNER, addWeekCard: OWNER, moveWeekCard: OWNER, removeWeekCard: OWNER,
  getStorage: OWNER, getDayReport: OWNER, getSummaryReport: OWNER, getFinanceSummary: OWNER,
  // api/clients.js (saveItemType: базовая роль owner|worker, правка уточняется в теле)
  saveClient: OWNER, deleteClient: OWNER, purgeClient: OWNER,
  saveItemType: OWNER_WORKER, deleteItemType: OWNER, rememberClientItemType: OWNER_WORKER,
  getRefs: OWNER,
  // api/billing.js
  listBillingItems: OWNER, saveBillingItem: OWNER, deleteBillingItem: OWNER,
  listTariffs: OWNER, saveTariff: OWNER, saveClientItemBilling: OWNER,
  listClientItemBilling: OWNER, getClientInvoice: OWNER,
  // api/users.js
  listUsers: OWNER, createUser: OWNER, updateUser: OWNER, resetUserPassword: OWNER,
  deactivateUser: OWNER, reactivateUser: OWNER, deleteUser: OWNER, makeTelegramBindCode: OWNER,
  // api/laundries.js (getTvData — без проверки)
  listLaundries: OWNER, createLaundry: OWNER, updateLaundry: OWNER, deactivateLaundry: OWNER,
  // deliveries.js (legacy: token-first, requireRole_ остался в телах)
  getDeliveryVisits: OWNER, addDeliveryVisit: OWNER, moveDeliveryVisit: OWNER,
  removeDeliveryVisit: OWNER, setPickupOnly: OWNER, getDriverRoute: DRIVER_OWNER,
  driverTakeAllClean: DRIVER_OWNER, driverAction: DRIVER_OWNER, driverHandover: DRIVER_OWNER,
  setVisitLiftFloor: OWNER,
  // workhours.js (legacy)
  setWorkHours: OWNER_WORKER, getWorkHours: OWNER_WORKER, getDeliveryPointStats: OWNER,
  // payroll.js (legacy)
  getPayroll: OWNER, getMyPayroll: ['driver'], listPayRates: OWNER, savePayRate: OWNER,
  savePayAdjustment: OWNER, deletePayAdjustment: OWNER, listPayAdjustments: OWNER,
  listPaySettings: OWNER, savePaySettings: OWNER
};

// --- Экспорт и монтирование в Express ---

const { login, logout, switchLaundry, requireRole_ } = require('./auth');

// Методы доменных модулей api/* принимают session первым параметром
// (requireRole_ из их тел убран — роль проверяется здесь, по API_ROLES).
const sessionFirst = {
  getDayList, startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan,
  getStorage, getDayReport, getSummaryReport, getFinanceSummary,
  saveClient, deleteClient, purgeClient, saveItemType, deleteItemType, rememberClientItemType, getRefs,
  listBillingItems, saveBillingItem, deleteBillingItem,
  listTariffs, saveTariff, saveClientItemBilling, listClientItemBilling, getClientInvoice,
  listUsers, createUser, updateUser, resetUserPassword, deactivateUser, reactivateUser, deleteUser, makeTelegramBindCode,
  listLaundries, createLaundry, updateLaundry, deactivateLaundry
};

// Обёртка token → session для прямых вызовов api.<method>(token, ...)
// (тесты и вспомогательный код зовут методы с токеном, как раньше).
function guarded_(name, fn) {
  return function (token) {
    const session = requireRole_(token, API_ROLES[name]);
    if (!session) return err_('Нет доступа');
    return fn.apply(null, [session].concat(Array.prototype.slice.call(arguments, 1)));
  };
}

// Публичные методы API: имя функции = имя метода (POST /api/<method>, тело { args: [...] }).
const api = {
  login, logout, switchLaundry, getTvData,
  // Обёртки над deliveries.js: token-first, делегируют как раньше
  addWeekCard, moveWeekCard, removeWeekCard,
  // Развозы и водитель (логика в deliveries.js)
  getDeliveryVisits: deliveries.getDeliveryVisits,
  addDeliveryVisit: deliveries.addDeliveryVisit,
  moveDeliveryVisit: deliveries.moveDeliveryVisit,
  removeDeliveryVisit: deliveries.removeDeliveryVisit,
  setPickupOnly: deliveries.setPickupOnly,
  getDriverRoute: deliveries.getDriverRoute,
  driverTakeAllClean: deliveries.driverTakeAllClean,
  driverAction: deliveries.driverAction,
  driverHandover: deliveries.driverHandover,
  setVisitLiftFloor: deliveries.setVisitLiftFloor,
  // Табель: часы работников и статистика развозов (логика в workhours.js)
  setWorkHours: workhours.setWorkHours,
  getWorkHours: workhours.getWorkHours,
  getDeliveryPointStats: workhours.getDeliveryPointStats,
  // Зарплаты (логика в payroll.js)
  getPayroll: payroll.getPayroll,
  getMyPayroll: payroll.getMyPayroll,
  listPayRates: payroll.listPayRates,
  savePayRate: payroll.savePayRate,
  savePayAdjustment: payroll.savePayAdjustment,
  deletePayAdjustment: payroll.deletePayAdjustment,
  listPayAdjustments: payroll.listPayAdjustments,
  listPaySettings: payroll.listPaySettings,
  savePaySettings: payroll.savePaySettings
};
Object.keys(sessionFirst).forEach(function (name) { api[name] = guarded_(name, sessionFirst[name]); });

function mountApi(app) {
  app.post('/api/:method', async (req, res) => {
    const name = req.params.method;
    const fn = api[name];
    if (!fn) return res.status(404).json(err_('Неизвестный метод: ' + name));
    try {
      const args = (req.body && req.body.args) || [];
      // Проверка роли до вызова метода (R1, шаг 3). Методы вне API_ROLES
      // (login, logout, getTvData) вызываются как есть.
      const roles = API_ROLES[name];
      if (roles) {
        const session = requireRole_(args[0], roles);
        if (!session) return res.json(err_('Нет доступа'));
        const impl = sessionFirst[name];
        // Методы новых модулей получают session первым параметром; legacy-
        // модули (deliveries/workhours/payroll/auth) — token, проверка роли
        // в их телах сохраняется и срабатывает повторно.
        const result = impl
          ? await impl.apply(null, [session].concat(args.slice(1)))
          : await fn.apply(null, args);
        return res.json(result);
      }
      const result = await fn.apply(null, args);
      res.json(result);
    } catch (e) {
      console.error('API ' + name + ' failed:', e);
      res.status(500).json(err_(String(e && e.message || e)));
    }
  });
}

// Экспорты собираются один раз из объекта api (шаг 2 R1): все публичные методы
// доступны и как api.<method>, и как прямые ключи module.exports. Отдельно —
// хелперы, которых нет в api: их используют deliveries.js, workhours.js,
// payroll.js, telegram.js, index.js и тесты.
module.exports = Object.assign({ mountApi, api, API_ROLES }, api, {
  err_, ok_, withLock_, round1_, timeStr_,
  ensureShift_, getShiftByDate_,
  ensureWashesFromDelivery_, notReadyForDelivery_, materializeTodayAllLaundries_,
  consumeTelegramBindCode_
});
