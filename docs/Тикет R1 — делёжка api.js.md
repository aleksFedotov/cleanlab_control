# R1. Техдолг: делёжка `server/api.js` (god file → доменные модули)

> Рефакторинг без изменения поведения. `server/api.js` вырос до ~1900 строк:
> в фасаде остались стирки/смены, справочники, биллинг (~400 строк),
> пользователи (~200 строк), прачки, TV-табло, Telegram-коды — плюс два
> дублирующихся списка экспорта (`api` и `module.exports`). Делим файл на
> доменные модули по существующему паттерну `deliveries.js` / `payroll.js` /
> `workhours.js`. Схема БД, HTTP-контракт (`POST /api/<method>`, тело
> `{ args: [...] }`), имена методов и тексты ошибок не меняются.

## Принятые решения (контекст)

- **Перенос, не переписывание.** Код перемещается как есть, вместе с
  комментариями-обоснованиями (идемпотентность, `hold`-маркер, суммирование
  частичных стирок) — это документация, не мусор. «Улучшать» логику по ходу
  запрещено.
- **Паттерн уже есть.** Новые модули оформляются так же, как вынесенные
  `deliveries.js` и `payroll.js`; новый стиль не изобретаем.
- **Сначала характеризационные тесты** (шаг 0) — они пишутся против текущего
  кода и дальше не правятся. Это эталон: после каждого шага обязаны быть
  зелёными.
- **TypeScript не вводим** — отдельным тикетом после делёжки (см. «Отложено»).
- **Единственное внутреннее изменение — таблица ролей** (шаг 3): идёт
  последним, отдельным коммитом. Внешний HTTP-контракт при этом не меняется.
- Один шаг = один коммит; после каждого `npm test` зелёный.

## Шаг 0. Характеризационные тесты (до любого переноса)

- `server/test/api.characterization.test.js` (`node --test`, in-memory sqlite)
  фиксирует текущее поведение ключевых путей через публичные функции `api`:
  - `completeWash`: частичная достирка — итоги суммируются, вторая clean-запись
    склада; повторное завершение не дублирует `WashItems`;
  - `deferWash` по `partial`: перенос визита развоза, восстановление
    dirty-записи склада;
  - `holdPartialWash`: маркер `hold` в `deferred_reason`, дата не переносится;
  - `getClientInvoice`: счёт за период строится (выборка washes/visits/storage);
  - `closeShift`: блокеры, `force`, итоги смены;
  - `getDayList`: идемпотентная материализация стирок из развоза
    (`ensureWashesFromDelivery_` — повторный вызов не дублирует стирки);
  - права: worker на owner-методах → «Нет доступа» (3–4 метода выборочно).

## Шаг 1. Механический перенос доменов (по одному коммиту на модуль)

Порядок — от самостоятельных к ядру:

1. `server/api/billing.js` — от `BILLING_KINDS` до `getClientInvoice`
   (включая `saveLogisticsItem_`, `billingItems_`).
2. `server/api/users.js` — `listUsers`…`deleteUser` + Telegram-коды
   (`makeTelegramBindCode`, `consumeTelegramBindCode_`, `telegramBindCodes`).
3. `server/api/clients.js` — справочники: `saveClient`, `deleteClient`,
   `purgeClient`, `saveItemType`, `deleteItemType`, `rememberClientItemType`,
   `getRefs`.
4. `server/api/laundries.js` — `listLaundries`, `createLaundry`,
   `updateLaundry`, `deactivateLaundry`, `getTvData`.
5. `server/api/washes.js` — ядро, последним: `getDayList`, `startWash`,
   `completeWash`, `editWashData`, `deferWash`, `holdPartialWash`,
   `addUnplannedWash`, `getShiftCloseState`, `closeShift`, `getDeliveryPlan`,
   `addToDelivery`, `cancelWash`, `deleteWash`, `confirmStorageCheck`,
   `markIssued`, `updateIssueDate`, `getWeekPlan`, обёртки
   `addWeekCard`/`moveWeekCard`/`removeWeekCard`, `getStorage`, `getDayReport`,
   `getSummaryReport`, `getFinanceSummary` + приватные хелперы
   (`ensureWashesFromDelivery_`, `notReadyForDelivery_`, `weekMaterialized_`,
   `copyPrevWeek_`, `materializeTodayAllLaundries_`,
   `notifyOwnerOnWorkerAction_`, `clientNameById_`).

- В `api.js` остаются: `withLock_`, `findTenantRow_`, `ensureShift_`,
  `getShiftByDate_`, объект `api`, `mountApi`, сборка экспортов из модулей.
- Общие хелперы новым модулям отдаём через существующий `module.exports`
  api.js; циклических require не вводим — при конфликте хелпер уходит
  в `core.js` отдельным коммитом.

## Шаг 2. Двойной экспорт

- `module.exports` собирается один раз из модулей — без ручного дублирования
  списка методов в `api` и `module.exports` (~60 строк × 2).
- Внешний контракт сохраняется: `require('./api').api`, `mountApi` и
  реэкспортируемые хелперы (`withLock_`, `round1_`, `timeStr_`, `err_`, `ok_`)
  доступны как раньше — их используют `deliveries.js`, `workhours.js`,
  `payroll.js`, `index.js`.

## Шаг 3. Таблица ролей вместо ручного `requireRole_` в каждом методе

- Рядом с объектом `api` — явная таблица `API_ROLES`: метод → массив ролей.
  Значения переносятся из текущих `requireRole_`-вызовов один в один;
  `login`, `logout`, `getTvData` — без проверки, как сейчас.
- Проверка роли — в `mountApi` до вызова функции; `requireRole_` из тел
  методов убирается, `session` передаётся первым параметром вместо `token`
  (внутренние сигнатуры меняются — единственное осознанное изменение;
  HTTP-контракт `{ args: [...] }` нет).
- Тесты шага 0 по правам проходят без изменений.

## Тесты

- Шаг 0 — новые; дальше только прогон: `npm test` зелёный после каждого
  коммита, тесты шага 0 не правятся.
- Снапшот-тест: `Object.keys(api).sort()` идентичен до/после делёжки.

## Критерии приёмки

- `api.js` < ~400 строк; состав `api` и поведение HTTP-API не изменились
  (те же методы, тексты ошибок, формат ответа).
- Двойного списка экспорта нет; роль метода видна в `API_ROLES`, а не в теле.
- `deliveries.js`, `workhours.js`, `payroll.js`, `index.js` не правились.

## Оценка

2–3 дня: шаг 0 — 1 д, шаг 1 — 0,5–1 д, шаги 2–3 — 0,5 д, прогон/разбор — 0,5 д.

## Зависимости и отложено

- Зависимостей нет; желательно выполнить до старта новых фич, трогающих
  `api.js` — иначе мерж-конфликты.
- Отложено (следующие тикеты, здесь не делать):
  - **R2. TypeScript**: снизу вверх (`schema.js` → `db.js` → `core.js` →
    доменные модули → фасад), `allowJs`, по одному файлу; типы `Wash`,
    `Visit`, `BillingItem`, `WashStatus` — первым делом в `core`;
  - выборки SQL с `WHERE laundry_id = ?` вместо «прочитать N строк и
    отфильтровать в JS» (требует изменения `db.js`);
  - транзакции better-sqlite3 вместо `withLock_`-заглушки.
