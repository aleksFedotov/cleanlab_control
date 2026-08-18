// Конфигурация из ENV — замена PropertiesService.getScriptProperties().
// Локально можно положить значения в server/.env (не коммитится) и загрузить через --env-file:
//   node --env-file=.env index.js
const config = {
  PORT: Number(process.env.PORT || 3100),
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  OWNER_PIN: process.env.OWNER_PIN || '',
  WORKER_PIN: process.env.WORKER_PIN || '',
  DRIVER_PIN: process.env.DRIVER_PIN || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  TV_KEY: process.env.TV_KEY || '',
  // OWNER_CHAT_ID в GAS записывал бот в Script Properties после ввода PIN.
  // Здесь храним его в Settings-таблице (см. telegram.js) — ENV не нужен.
};

module.exports = { config };
