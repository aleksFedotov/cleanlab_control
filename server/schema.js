// Схема данных CleanLab Control — порт src/Schema.gs.
// Таблицы SQLite = листам Sheets, колонки = HEADERS. Все значения храним как TEXT
// (даты — строками формата схемы), как и в Sheets.
const SCHEMA_VERSION = 3;

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
  SESSIONS: 'Sessions'
};

// Мультитенантность: laundry_id — во всех операционных таблицах.
// Пустой laundry_id в Settings = глобальная настройка (per-tenant строки её перекрывают).
// WashItems и ItemTypes без laundry_id: тенант через wash_id / справочник глобальный.
const HEADERS = {
  Settings: ['key', 'value', 'laundry_id'],
  Clients: ['id', 'name', 'contact', 'address', 'type', 'active', 'comment', 'item_types', 'accounting', 'inn', 'kpp', 'legal_address', 'laundry_id'],
  ItemTypes: ['id', 'name', 'sort', 'active'],
  Washes: ['id', 'client_id', 'wash_date', 'issue_date', 'status',
    'dirty_weight_kg', 'items_total', 'comment', 'created_by', 'created_at',
    'started_at', 'done_at', 'issued_at', 'deferred_from', 'deferred_reason', 'bags', 'laundry_id'],
  WashItems: ['id', 'wash_id', 'item_type_id', 'qty'],
  Shifts: ['id', 'date', 'status', 'opened_at', 'closed_at',
    'total_kg', 'washes_done', 'washes_deferred', 'digest_sent', 'laundry_id'],
  Deliveries: ['id', 'date', 'client_id', 'ord', 'status',
    'delivered_at', 'pickup', 'driver_comment', 'created_by', 'created_at',
    'clean_taken_at', 'clean_bags', 'picked_at', 'dirty_handed_at', 'pickup_only', 'laundry_id'],
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
  Sessions: ['token', 'user_id', 'laundry_id', 'expires_at']
};

// Стартовое наполнение ItemTypes (spec §3.4).
const START_ITEM_TYPES = [
  'пододеяльник', 'простыня', 'наволочка',
  'полотенце банное', 'полотенце для рук', 'полотенце для ног',
  'халат', 'скатерть', 'салфетка', 'покрывало', 'прочее'
];

module.exports = { SCHEMA_VERSION, SHEETS, HEADERS, START_ITEM_TYPES };
