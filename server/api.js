// Серверное API (spec §6) — порт src/Api.gs. Каждая функция принимает токен первым параметром.
// Мультитенантность: прачка берётся из сессии (session.laundryId), все чтения/записи
// операционных таблиц фильтруются по ней; строка чужой прачки для API не существует.
// LockService не нужен: однопроцессный Node + синхронный better-sqlite3.
// Express-монтирование: каждая публичная функция → POST /api/<имя>, тело { args: [...] }.
// Фасад (R1): доменная логика в модулях api/*, здесь — сборка api и монтирование.
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

// --- Экспорт и монтирование в Express ---

const { login, logout, switchLaundry } = require('./auth');

// Публичные методы API: имя функции = имя метода (POST /api/<method>, тело { args: [...] }).
const api = {
  login, logout, switchLaundry, listLaundries, createLaundry, updateLaundry, deactivateLaundry,
  getDayList, startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport, getSummaryReport, getFinanceSummary,
  saveClient, deleteClient, purgeClient, saveItemType, deleteItemType, rememberClientItemType, getRefs,
  listBillingItems, saveBillingItem, deleteBillingItem,
  listTariffs, saveTariff, saveClientItemBilling, listClientItemBilling, getClientInvoice,
  listUsers, createUser, updateUser, resetUserPassword, deactivateUser, reactivateUser, deleteUser, makeTelegramBindCode,
  getTvData,
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

function mountApi(app) {
  app.post('/api/:method', async (req, res) => {
    const fn = api[req.params.method];
    if (!fn) return res.status(404).json(err_('Неизвестный метод: ' + req.params.method));
    try {
      const args = (req.body && req.body.args) || [];
      const result = await fn.apply(null, args);
      res.json(result);
    } catch (e) {
      console.error('API ' + req.params.method + ' failed:', e);
      res.status(500).json(err_(String(e && e.message || e)));
    }
  });
}

module.exports = {
  mountApi, api,
  err_, ok_, withLock_, round1_, timeStr_,
  login, logout, switchLaundry, listLaundries, createLaundry, updateLaundry, deactivateLaundry,
  ensureShift_, getShiftByDate_, ensureWashesFromDelivery_, notReadyForDelivery_, materializeTodayAllLaundries_,
  getDayList, startWash, completeWash, editWashData, deferWash, holdPartialWash, addUnplannedWash,
  getShiftCloseState, closeShift,
  getDeliveryPlan, addToDelivery, cancelWash, deleteWash, confirmStorageCheck, markIssued, updateIssueDate,
  getWeekPlan, addWeekCard, moveWeekCard, removeWeekCard,
  getStorage, getDayReport, getSummaryReport, getFinanceSummary,
  saveClient, deleteClient, purgeClient, saveItemType, deleteItemType, rememberClientItemType, getRefs,
  listBillingItems, saveBillingItem, deleteBillingItem,
  listTariffs, saveTariff, saveClientItemBilling, listClientItemBilling, getClientInvoice,
  listUsers, createUser, updateUser, resetUserPassword, deactivateUser, reactivateUser, deleteUser, makeTelegramBindCode,
  consumeTelegramBindCode_, getTvData,
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
  setWorkHours: workhours.setWorkHours,
  getWorkHours: workhours.getWorkHours,
  getDeliveryPointStats: workhours.getDeliveryPointStats,
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
