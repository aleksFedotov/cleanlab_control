// Точка входа VPS-бэкенда CleanLab Control (Прачечная PRO).
// Express на localhost:3100; снаружи — Caddy reverse_proxy с авто-HTTPS.
const path = require('node:path');
const express = require('express');
const { config } = require('./config');
const db = require('./db');
const { mountApi } = require('./api');
const { mountTelegram } = require('./telegram');

db.open();
require('./auth').cleanupExpiredSessions_();

// Проактивная материализация дня: стирки из завтрашнего развоза и копия недели
// для всех прачек — при старте и ежедневно в 00:05 (раньше создавались лениво,
// по открытию экранов «План»/«Стирка», и утро начиналось с пустого дня).
const { materializeTodayAllLaundries_ } = require('./api');
materializeTodayAllLaundries_();
(function scheduleDailyMaterialize() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 5, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(function tick() {
    try {
      materializeTodayAllLaundries_();
    } catch (e) {
      console.error('daily materialize failed:', e);
    }
    setTimeout(tick, 24 * 3600 * 1000);
  }, next - now).unref();
})();

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

mountApi(app);
mountTelegram(app);

// Фронт: копия src/Index.html с fetch-адаптером вместо google.script.run.
app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.PORT, () => {
  console.log(`cleanlab-server listening on localhost:${config.PORT}`);
});
