// Схема данных CleanLab Control — порт src/Schema.gs.
// Таблицы SQLite = листам Sheets, колонки = HEADERS. Все значения храним как TEXT
// (даты — строками формата схемы), как и в Sheets.
const SCHEMA_VERSION = 6;

const SHEETS = {
  SETTINGS: 'Settings',
  CLIENTS: 'Clients',
  ITEM_TYPES: 'ItemTypes',
  WASHES: 'Washes',
  WASH_ITEMS: 'WashItems',
  SHIFTS: 'Shifts',
  DELIVERIES: 'Deliveries',
  STORAGE: 'Storage',
  LOG: 'Log',
  LAUNDRIES: 'Laundries',
  USERS: 'Users',
  SESSIONS: 'Sessions',
  WORK_HOURS: 'WorkHours',
  BILLING_ITEMS: 'BillingItems',
  CLIENT_TARIFFS: 'ClientTariffs',
  CLIENT_ITEM_BILLING: 'ClientItemBilling',
  PAY_RATES: 'PayRates',
  PAY_ADJUSTMENTS: 'PayAdjustments'
};

// Мультитенантность: laundry_id — во всех операционных таблицах.
// Пустой laundry_id в Settings = глобальная настройка (per-tenant строки её перекрывают).
// WashItems и ItemTypes без laundry_id: тенант через wash_id / справочник глобальный.
const HEADERS = {
  Settings: ['key', 'value', 'laundry_id'],
  Clients: ['id', 'name', 'contact', 'address', 'type', 'active', 'comment', 'item_types', 'accounting', 'inn', 'kpp', 'legal_address', 'laundry_id'],
  // billing_item_id — позиция прайса (BillingItems kind=wash_pcs), пусто = в счёт по весу.
  ItemTypes: ['id', 'name', 'sort', 'active', 'billing_item_id'],
  Washes: ['id', 'client_id', 'wash_date', 'issue_date', 'status',
    'dirty_weight_kg', 'items_total', 'comment', 'created_by', 'created_at',
    'started_at', 'done_at', 'issued_at', 'deferred_from', 'deferred_reason', 'bags', 'laundry_id'],
  WashItems: ['id', 'wash_id', 'item_type_id', 'qty'],
  Shifts: ['id', 'date', 'status', 'opened_at', 'closed_at',
    'total_kg', 'washes_done', 'washes_deferred', 'digest_sent', 'laundry_id'],
  // lift_floor — этаж, на который поднимался водитель (пусто/1/2 = без доплаты).
  Deliveries: ['id', 'date', 'client_id', 'ord', 'status',
    'delivered_at', 'pickup', 'driver_comment', 'created_by', 'created_at',
    'clean_taken_at', 'clean_bags', 'picked_at', 'dirty_handed_at', 'pickup_only', 'lift_floor', 'laundry_id'],
  Storage: ['id', 'client_id', 'kind', 'weight_kg', 'items_total',
    'wash_id', 'created_at', 'consumed_at', 'laundry_id'],
  Log: ['ts', 'actor', 'action', 'entity', 'details', 'laundry_id'],
  Laundries: ['id', 'name', 'active'],
  // Персональные аккаунты. role: owner | worker | driver | client.
  // У owner laundry_id пуст — доступ ко всем прачкам (активная выбирается в сессии).
  // У client (задел) client_id ссылается на Clients.
  Users: ['id', 'laundry_id', 'name', 'role', 'pin', 'active', 'client_id', 'login', 'pass_hash'],
  // Персистентные сессии (замена in-memory Map): token → пользователь.
  // laundry_id — активная прачка сессии (для owner меняется через switchLaundry).
  // expires_at — unix-мс строкой; скользящее продление при каждом запросе.
  Sessions: ['token', 'user_id', 'laundry_id', 'expires_at'],
  // Учёт рабочих часов работников. Одна строка = работник × день (upsert по user_id+date).
  // hours — число строкой ('7.5'). hours=0/пусто → строка удаляется, нулями не засоряем.
  WorkHours: ['id', 'user_id', 'date', 'hours', 'updated_by', 'updated_at', 'laundry_id'],
  // Номенклатура счёта (прайс), per-tenant. unit: кг | шт | рейс | этаж;
  // kind: wash_weight | wash_pcs | trip | lift. oneway=да — позиция для визита с одной
  // ногой; max_kg — верхняя граница яруса веса ноги; per_floor=да (только lift) —
  // цена за каждый этаж выше 2-го, иначе за факт подъёма. ext_code — код НФ для 1С.
  // На прачку — ровно одна активная позиция wash_weight (весовая по умолчанию).
  BillingItems: ['id', 'laundry_id', 'name', 'unit', 'kind', 'oneway', 'max_kg', 'per_floor', 'ext_code', 'sort', 'active'],
  // Тарифы: client_id пусто → дефолт прачки; строка клиента перекрывает дефолт.
  // Upsert по (client_id, billing_item_id); price='' — снять переопределение.
  ClientTariffs: ['id', 'client_id', 'billing_item_id', 'price', 'laundry_id'],
  // Per-клиентская привязка типа белья к позиции счёта. billing_item_id пусто =
  // «у этого клиента тип идёт в вес», даже если глобально тип привязан к wash_pcs.
  // Нет строки → ItemTypes.billing_item_id → весовая позиция по умолчанию.
  ClientItemBilling: ['id', 'client_id', 'item_type_id', 'billing_item_id', 'laundry_id'],
  // Зарплаты (P3): индивидуальные переопределения ставок. Пустое поле = дефолт
  // прачки из Settings (PAY_*). Одна строка на сотрудника (upsert по user_id).
  PayRates: ['id', 'user_id', 'point_rate', 'lift_floor_rate', 'shift_base', 'shift_norm_hours', 'laundry_id'],
  // Ручные корректировки зарплаты: amount со знаком (+ премия / − штраф),
  // попадает в период по date. created_by — имя из сессии владельца.
  PayAdjustments: ['id', 'user_id', 'date', 'amount', 'comment', 'created_by', 'created_at', 'laundry_id']
};

// Стартовое наполнение ItemTypes (spec §3.4).
const START_ITEM_TYPES = [
  'пододеяльник', 'простыня', 'наволочка',
  'полотенце банное', 'полотенце для рук', 'полотенце для ног',
  'халат', 'скатерть', 'салфетка', 'покрывало', 'прочее'
];

// Стартовый прайс прачки (P2, тикет в docs/tickets.md): сидится миграцией v4
// на каждую существующую прачку. name — как в счёте. Порядок = sort.
// P2.2: логистические позиции фиксированы (создание trip/lift закрыто), позиция
// «Доставка» (рейс без яруса) удалена миграцией v6 — доставка от N кг бесплатна.
// Пороговая позиция — единственная trip с max_kg и oneway ≠ да.
const START_BILLING_ITEMS = [
  { name: 'Услуги прачечной (постельное бельё)', unit: 'кг', kind: 'wash_weight' },
  { name: 'Услуги прачечной (Халат)', unit: 'шт', kind: 'wash_pcs' },
  { name: 'Услуги прачечной (Подушка, Одеяло, Наматрасник)', unit: 'шт', kind: 'wash_pcs' },
  { name: 'Услуги прачечной (Штора)', unit: 'шт', kind: 'wash_pcs' },
  { name: 'Доставка менее 30 кг', unit: 'рейс', kind: 'trip', max_kg: '30' },
  { name: 'Доставка в одну сторону/Забор', unit: 'рейс', kind: 'trip', oneway: 'да' },
  { name: 'Подъём на этаж', unit: 'этаж', kind: 'lift', per_floor: 'да' }
];

module.exports = { SCHEMA_VERSION, SHEETS, HEADERS, START_ITEM_TYPES, START_BILLING_ITEMS };
