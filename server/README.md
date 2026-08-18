# Локальный запуск VPS-бэкенда (server/)

Ветка `vps-migration`. Работает независимо от GAS-версии (`src/` не тронут).

## Запуск

```bash
cd server
npm install        # один раз
cp .env.example .env   # заполнить PIN'ы и токены
node --env-file=.env index.js
```

Сервер слушает `localhost:3100`:
- `/health` — проверка живости;
- `/api/<method>` (POST, тело `{args: [...]}`) — все методы бывшего `Api.gs`;
- `/telegram/webhook?secret=<WEBHOOK_SECRET>` — webhook бота;
- `/` — веб-приложение (`server/public/index.html`, копия `src/Index.html` с fetch-адаптером вместо `google.script.run`).

БД — SQLite в `server/data/cleanlab.sqlite` (создаётся сама, в git не попадает).

## Инициализация данных

```bash
node --env-file=.env -e "require('./setup').setup()"
```

Идемпотентно: создаёт таблицы (при старте сервера тоже), сеет стартовые типы белья и `Settings` (`SCHEMA_VERSION=1`).

## Конфигурация (server/.env)

Те же секреты, что в GAS Script Properties: `BOT_TOKEN`, `OWNER_PIN`, `WORKER_PIN`, `DRIVER_PIN`, `WEBHOOK_SECRET`, `TV_KEY`. Плюс `PORT` (по умолчанию 3100), `DB_PATH`, `APP_TZ` (по умолчанию Europe/Moscow). `OWNER_CHAT_ID` не нужен — бот запишет его в таблицу Settings после ввода PIN владельца.

## Тесты

```bash
cd server && npm test   # 41 тест против SQLite-слоя
npm test                # из корня — 65 GAS-тестов, работают как раньше
```
