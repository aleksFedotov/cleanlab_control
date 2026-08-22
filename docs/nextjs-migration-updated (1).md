# План миграции фронтенда на Next.js (дашборд)

> Документ-обсуждение. Код не меняется, пока план не утверждён.

## 0. Что есть сейчас

- `server/public/index.html` — ~2500 строк, ~490 функций: 8 вкладок владельца (Стирка, Сегодня, План, Склад, Отчёт, Справочники, Сотрудники, Прачки) + мобильные экраны работника и водителя + вход по PIN/паролю.
- Рендер — конкатенация HTML-строк, ручная привязка событий, глобальный `state`, самодельный роутер `navigate(view)`.
- Бэкенд: Express + SQLite (`server/`), единый контракт `POST /api/<method>` с телом `{args: [...]}`.
- Сборки нет, тесты покрывают только сервер.

Почему пора: любая правка трогает 2500-строчный файл; состояние размазано; регрессии ловятся глазами; вкладок станет больше.

## 1. Почему Next.js (и честные оговорки)

Доводы «за» в нашем случае:

- Один фреймворк и один язык на всё: при желании Express API со временем переносится в Route Handlers — остаётся один Node-процесс на VPS.
- App Router даёт layouts «из коробки» — дашборд с боковой панелью ложится на вложенные layout'ы естественно.
- Экосистема: любые UI-библиотеки (shadcn/ui, TanStack Query, Recharts) подключаются без танцев.
- Задел на будущее: если появится публичная часть (лендинг, кабинет клиента) — SSR/SEO уже есть.

Оговорки (принимаем осознанно):

- SSR/SEO этому приложению не нужны — это внутренний инструмент за логином. Используем Next как SPA с клиентским рендерингом (`'use client'`), запуская `next start` рядом с Express.
- SQLite + better-sqlite3 в Route Handlers работает, но перенос API — отдельный этап, не обязательный.
- Цена: dev-сервер тяжелее, понятий больше (server/client components), чем у Vite SPA.

Решение: **Next.js (App Router) как клиентское SPA**, Express API на первом этапе **не трогаем вообще**.

## 2. Целевая архитектура

```text
┌─────────────────────────┐         ┌──────────────────────────┐
│  Next.js (client/)      │  fetch  │  Express (server/)       │
│  страницы-дашборд       │ ──────► │  POST /api/<method>      │
│  localhost:3000 (dev)   │  POST   │  SQLite                  │
└─────────────────────────┘         └──────────────────────────┘
```

- В dev — `next dev` на :3000, запросы `/api/*` проксируются на Express :3100 (rewrites в `next.config.js`).
- В проде — `next build && next start` на :3000, Express :3100 рядом, nginx (или Express сам) проксирует `/api` на Express, остальное — на Next.

## 3. TypeScript

### 3.1 Почему сразу

Проект — 2500 строк, 490 функций, 8 вкладок + мобильные роли. Это уже не «скриптик», а полноценное приложение. Переписывание с нуля — идеальный момент внедрить TS, не нужно типизировать существующий код.

- **Рефакторинг безопасный.** Переименование поля на бэкенде ловится на этапе компиляции, а не в проде.
- **API-контракт в коде.** Больше не нужно помнить, что возвращает `POST /api/getWashes` — типы фиксируют это.
- **Автодополнение.** IDE подсказывает поля объектов, экономит часы при работе с DataTable, Card, формами.
- «Быстрее без типов» — иллюзия. Первые 2 недели быстрее, потом 3 недели отладки того, что TS поймал бы за минуту.

### 3.2 Прагматичный strict-режим

Не `strict: true` со всеми проверками — начинаем мягко:

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": false,
    "noImplicitAny": false,
    "strictNullChecks": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "jsx": "preserve",
    "incremental": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src/**/*"]
}
```

**Правила:**
- Все новые файлы — `.ts` / `.tsx`.
- `strictNullChecks: true` — ловит 80% багов (undefined в полях, null в массивах).
- `any` разрешён, но с комментарием `// TODO: типизировать`.
- Через 2 месяца после стабилизации — включаем `strict: true` и чистим `any`.

### 3.3 Что типизировать

| Что | Где | Объём |
|-----|-----|-------|
| API-ответы | `src/types/api.ts` | ~80 строк (8 вкладок × ~10 полей) |
| Статусы/роли | `src/types/enums.ts` | ~20 строк |
| Пропсы компонентов | рядом с компонентом | 2-5 строк на компонент |
| Zustand store | `src/stores/ui.ts` | ~15 строк |
| TanStack Query keys | `src/lib/query-keys.ts` | ~20 строк |

Итого: **~150 строк типов** на весь проект. Плата — 30 минут на старте. Выгода — часы экономии на отладке.

### 3.4 Пример типизации

```tsx
// src/types/api.ts
export type WashStatus = 'pending' | 'washing' | 'ready' | 'delivered' | 'cancelled';

export interface Wash {
  id: number;
  status: WashStatus;
  clientName: string;
  weight: number;
  createdAt: string;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// src/components/ui/StatusBadge.tsx
import type { WashStatus } from '@/types/api';

interface StatusBadgeProps {
  status: WashStatus;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  // IDE подскажет все поля из dicts[status]
}
```

## 4. Управление состоянием и данными

### 4.1 Почему не Redux

Redux избыточен для внутреннего дашборда:
- Нет сложной кросс-табличной синхронизации между десятками экранов.
- Нет time-travel debugging и middleware-цепочек.
- Добавляет бойлерплейт и замедляет перенос.

### 4.2 Стек управления состоянием

| Слой | Инструмент | Назначение |
|------|-----------|------------|
| **Серверное состояние** | **TanStack Query (React Query)** | Кэширование, авто-рефетч, инвалидация, offline, оптимистичные обновления. Прямая замена самописному `useApi`, но с production-ready логикой. |
| **Глобальное клиентское состояние** | **Zustand** | Сайдбар (открыт/свёрнут), выбранная прачка, фильтры, toast-очередь. 5 строк кода, нет провайдеров-матрёшек. |
| **Локальное состояние** | `useState` / `useReducer` | Формы, модалки, переключатели вида (доска/список). |

### 4.3 Поток данных

```
Компонент
    │
    ├──► useQuery(['washes', date]) ──► TanStack Query кэш ──► POST /api/getWashes
    │                                    (stale-while-revalidate, авто-рефетч)
    │
    ├──► useMutation(updateStatus) ──► инвалидация ['washes'], ['today'], ['plan']
    │                                    (интерфейс обновляется без ручного state)
    │
    └──► Zustand store ──► sidebarOpen, selectedLaundry, activeFilters
```

**Правило:** серверное состояние (то, что пришло из API) — только через TanStack Query. Никакого ручного `setState` после `fetch`.

### 4.4 Формы и валидация

- **React Hook Form** — управление формами без лишних ререндеров (справочники, сотрудники, прачки, карточка стирки).
- **Zod** — схемы валидации в одном месте. Переиспользуем на сервере при переносе API в Route Handlers.

## 5. Макет дашборда

```text
┌────────────┬──────────────────────────────────────────────┐
│            │  Хедер: заголовок страницы · ‹ 21 августа ›   │
│  САЙДБАР   │         Сегодня · прачка ▾ · Иван (владелец)  │
│            ├──────────────────────────────────────────────┤
│  Лого      │                                              │
│            │              Контент страницы                │
│  ● Сегодня │            (max-width ~1100px)               │
│  Стирка    │                                              │
│  План      │                                              │
│  Склад     │                                              │
│  Отчёт     │                                              │
│  ────────  │                                              │
│  Справочн. │                                              │
│  Сотрудники│                                              │
│  Прачки    │                                              │
│            │                                              │
│  Выход     │                                              │
└────────────┴──────────────────────────────────────────────┘
```

- **Сайдбар** 240px, сворачивается до 64px (только иконки), состояние — в Zustand + localStorage. Группы: операционные разделы / настроечные (разделитель). Активный пункт — `usePathname()`.
- **Хедер**: заголовок раздела; на страницах с датой — единый DateNav `‹ 21 августа 2026 ›` + «Сегодня»; справа переключатель прачки (если >1) и пользователь.
- **Мобильно** (<1024px): сайдбар уходит в выдвижную панель (гамбургер).
- **Роли worker/driver** — отдельный мобильный layout без сайдбара (одна колонка, крупные кнопки): они с телефонов.
- **ТВ-табло** (`tv.html`) не трогаем.

### Единый стиль

Палитра и токены текущей дизайн-системы (`--bluing #2563eb`, статусы, радиусы 8/12/16, Inter + JetBrains Mono) переносятся 1:1 в `globals.css`. Единообразие обеспечивается фиксированным набором общих компонентов (раздел 6), а не дисциплиной:

- `PageHeader`, `StatCard/StatRow`, `StatusBadge` (карта статус→цвет/текст в одном словаре), `DataTable`, `Card`, `FilterPills`, `DateNav`, `Modal/ConfirmDialog`, `Toast`, `Empty`, `Button` (primary/ghost/danger + busy).

По страницам логика не меняется, меняется только оформление в эти компоненты:
- **Сегодня**: StatRow (готовы/не готовы/всего) + карточки визитов + фильтр.
- **Стирка**: доска/список (переключатель вида сохраняется в Zustand) в единых Card.
- **План**: недельная сетка в Card/StatusBadge.
- **Склад**: StatRow + FilterPills + список/таблица.
- **Отчёт**: DateNav + StatRow + FilterPills + DataTable с раскрытием строки.
- **Справочники/Сотрудники/Прачки**: DataTable + «Добавить» в PageHeader.

## 6. Структура фронтенда

```text
client/
├── package.json
├── next.config.ts              # rewrites /api → :3100 (dev)
├── tsconfig.json               # алиас "@/*" → "src/*", мягкий strict
├── public/                     # иконки, манифест
└── src/
    ├── app/                    # App Router (только для маршрутизации и layout'ов)
    │   ├── layout.tsx          # корневой: шрифты, globals.css, QueryClientProvider
    │   ├── page.tsx            # "/" → редирект по роли
    │   ├── login/page.tsx      # PIN/пароль
    │   ├── (dashboard)/        # layout с сайдбаром (owner)
    │   │   ├── layout.tsx      # DashboardLayout: Sidebar + Header + children
    │   │   ├── today/page.tsx      # развоз на день
    │   │   ├── wash/page.tsx       # стирка (доска + карточка стирки wash/[id]/page.tsx)
    │   │   ├── plan/page.tsx       # неделя
    │   │   ├── storage/page.tsx
    │   │   ├── report/page.tsx
    │   │   ├── refs/page.tsx       # справочники
    │   │   ├── users/page.tsx
    │   │   └── laundries/page.tsx
    │   ├── driver/page.tsx     # мобильный layout
    │   └── worker/page.tsx     # мобильный layout
    ├── components/
    │   ├── layout/  Sidebar.tsx, Header.tsx, DashboardLayout.tsx, MobileLayout.tsx
    │   └── ui/      PageHeader, StatCard, StatRow, StatusBadge, DataTable, Card,
    │                FilterPills, DateNav, Modal, ConfirmDialog, Toast, Empty, Button
    ├── lib/
    │   ├── api.ts              # api(method, ...args) → POST /api/<method>, ошибки, offline
    │   ├── query-client.ts     # QueryClient с дефолтными настройками (staleTime, retry)
    │   ├── query-keys.ts       # Типизированные ключи TanStack Query
    │   ├── session.ts          # токен (sessionStorage), login/logout, контекст сессии
    │   ├── dates.ts            # formatDateRu, shiftDate, weekdayOf (порт из index.html)
    │   ├── format.ts           # кг/шт/мешки
    │   └── dicts.ts            # statuses.ts + roleLabels — все подписи в одном месте
    ├── stores/
    │   └── ui.ts               # Zustand: sidebar, toasts, selectedLaundry, viewMode
    ├── types/
    │   ├── api.ts              # Интерфейсы API-ответов
    │   └── enums.ts            # WashStatus, UserRole и т.д.
    └── hooks/
        ├── use-api.ts          # TanStack Query обёртки (useWashes, useToday, useUpdateStatus)
        └── use-session.ts
```

Правила, чтобы структура не расползлась:

- Все страницы — клиентские (`'use client'`), серверные компоненты не используем до появления публичной части. App Router нужен только для файловой маршрутизации и layout'ов.
- Компонент нужен ≥2 страницам → `components/ui`; нужен одной → рядом с ней.
- `fetch` только через `lib/api.ts`; подписи статусов/ролей — только из `lib/dicts.ts`.
- Все файлы — `.ts` / `.tsx`, никаких `.js` в новом коде.

## 7. Этапы

1. **Скаффолд**: `create-next-app --ts` (App Router, TypeScript), `next.config.ts` с rewrites на Express, `globals.css` с токенами, `lib/api.ts` + `lib/session.ts`, настройка TanStack Query + Zustand. Создать `src/types/api.ts` и `src/types/enums.ts`.
2. **Каркас дашборда**: DashboardLayout (Sidebar/Header, мобильный режим), guards по роли, страница login. Навигация ходит по пустым страницам-заглушкам.
3. **UI-кит**: Button, Card, StatusBadge, StatRow, FilterPills, DateNav, DataTable, Modal, Toast, Empty. + React Hook Form + Zod для форм. Все с TypeScript-пропсами.
4. **Playwright E2E**: 3-5 критических сценариев (логин → стирка → отчёт) как защита от регрессий при переносе страниц.
5. **Перенос страниц по одной** (каждая — отдельный коммит, сверка со старым фронтом): Отчёт → Склад → План → Сегодня → Справочники → Сотрудники → Прачки → Стирка (+ карточка стирки).
6. **Мобильные роли**: driver, worker.
7. **Деплой**: `next start` на :3000 рядом с Express :3100, nginx проксирует `/api` → Express, остальное → Next. Старый `index.html` доступен по `/legacy.html`, переключение `/` — через feature flag (cookie `frontend=next`).
8. **(Опционально, потом)** Перенос Express API в Route Handlers — отдельным планом, только если захотим один процесс.

## 8. Риски и как их гасим

| Риск | Митигация |
|------|-----------|
| **Регрессии в бизнес-логике** | Переносим страницы по одной, старый фронт живёт параллельно до конца; API-контракт неизменен, серверные тесты как были, так и остаются зелёными. Playwright ловит фронтовые регрессии. |
| **Раздутие объёма** | UI-кит и dicts делаем до страниц, чтобы страницы были тонкими. TanStack Query и Zustand — лёгкие библиотеки. |
| **Два работающих фронта одновременно** | Сознательно — откат = убрать cookie `frontend=next`. Старый `index.html` остаётся по `/legacy.html` на одну версию. |
| **Команда не знает TanStack Query / Zustand / TS** | Документируем 3-4 типовых паттерна в `docs/frontend-patterns.md`: useQuery для чтения, useMutation + инвалидация для записи, Zustand для UI-состояния, типизация API. |

## 9. Критерий готовности

- Все 8 вкладок + worker/driver/login работают на Next-фронте.
- `/` отдаёт новый фронт (при включённом feature flag).
- `npm test` (сервер) зелёный.
- Playwright-сценарии (логин, стирка, развоз, склад, отчёт) проходят без ошибок.
- `tsc --noEmit` проходит без ошибок (на мягких настройках).
- Ручной прогон сценариев без ошибок в консоли.
