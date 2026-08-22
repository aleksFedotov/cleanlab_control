# VPS-бэкенд CleanLab Control (server/)

Единственная платформа проекта: Node/Express + SQLite (better-sqlite3). GAS-версия удалена.

## Запуск

```bash
cd server
npm install        # один раз
cp .env.example .env   # заполнить токены, OWNER_LOGIN/OWNER_PASSWORD и имена прачек
node --env-file=.env index.js
```

Сервер слушает `localhost:3100`:
- `/health` — проверка живости;
- `/api/<method>` (POST, тело `{args: [...]}`) — все методы API (`api.js`);
- `/telegram/webhook?secret=<WEBHOOK_SECRET>` — webhook бота;
- `/` — веб-приложение (`public/index.html`), `/tv.html?key=<TV_KEY>` — табло.

БД — SQLite в `server/data/cleanlab.sqlite` (создаётся сама, в git не попадает).

## Мультитенантность

Несколько прачек в одной установке: таблицы `Laundries` и `Users`, `laundry_id` в операционных таблицах. Вход: логин + пароль (scrypt-хэш в Users, логин глобально уникален); роли `owner` (все прачки, переключение через `switchLaundry`), `worker`, `driver`, `client` (задел, вход не настроен). Сессии персистентные — таблица `Sessions`, TTL 30 дней. При первом старте на пустой БД `migrateToV2_` (db.js) сидит прачки, а `migrateToV3_` upsert-ит владельца из ENV при каждом старте. Подробности — `docs/spec.md`.

## Инициализация данных

```bash
node --env-file=.env -e "require('./setup').setup()"
```

Идемпотентно: сеет стартовые типы белья и дефолтные `Settings` (таблицы и сид прачек создаются и при старте сервера).

## Конфигурация (server/.env)

См. `.env.example`: `BOT_TOKEN`, `LAUNDRY_NAME`, `OWNER_LOGIN`, `OWNER_PASSWORD`, опционально `LAUNDRY2_NAME`, `WEBHOOK_SECRET`, `TV_KEY` / `TV_KEY_2`, `PORT` (по умолчанию 3100), `DB_PATH`, `APP_TZ` (по умолчанию Europe/Moscow). `OWNER_CHAT_ID` не нужен — бот запишет его в Settings per-tenant после ввода одноразового 6-значного кода привязки (экран «Сотрудники»).

## Тесты

```bash
npm test   # из server/ или из корня — Node-тесты против SQLite in-memory
```
