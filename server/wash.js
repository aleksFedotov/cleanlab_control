// Жизненный цикл стирки (R3): именные команды домена.
// Каждая команда владеет переходом статуса и его эффектами (Storage/Shifts/Log/Telegram).
const { SHEETS } = require('./schema');
const db = require('./db');
const { nowStr_, logEvent, actorOf_ } = require('./audit');
const core = require('./core');
const {
  checkTransition_, err_, ok_, round1_, findTenantRow_, ensureShift_
} = core;
const { consumeStorage_ } = require('./storage');

// Уведомление владельцу в Telegram о действиях работника со стирками
// (добавление/перенос/удаление). Действия самого владельца не шлём.
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
}

module.exports = {
  notifyOwnerOnWorkerAction_, clientNameById_,
  startWash
};
