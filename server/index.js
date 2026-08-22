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
