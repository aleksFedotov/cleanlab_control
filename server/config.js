// Конфигурация из ENV — замена PropertiesService.getScriptProperties().
// Локально можно положить значения в server/.env (не коммитится) и загрузить через --env-file:
//   node --env-file=.env index.js
const config = {
  PORT: Number(process.env.PORT || 3100),
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  // Первая прачка: имя и пины первых пользователей (сидится в migrateToV2_ при пустой Laundries)
  LAUNDRY_NAME: process.env.LAUNDRY_NAME || 'Прачечная PRO',
  OWNER_PIN: process.env.OWNER_PIN || '',
  WORKER_PIN: process.env.WORKER_PIN || '',
  DRIVER_PIN: process.env.DRIVER_PIN || '',
  // Вторая прачка (необязательно): создаётся сидом, только если задано имя
  LAUNDRY2_NAME: process.env.LAUNDRY2_NAME || '',
  LAUNDRY2_WORKER_PIN: process.env.LAUNDRY2_WORKER_PIN || '',
  LAUNDRY2_DRIVER_PIN: process.env.LAUNDRY2_DRIVER_PIN || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  TV_KEY: process.env.TV_KEY || '',
  TV_KEY_2: process.env.TV_KEY_2 || '',
  // OWNER_CHAT_ID в GAS записывал бот в Script Properties после ввода PIN.
  // Здесь храним его в Settings-таблице per-tenant (см. telegram.js) — ENV не нужен.
};

module.exports = { config };
