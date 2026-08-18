// Схема данных CleanLab Control — порт src/Schema.gs.
// Таблицы SQLite = листам Sheets, колонки = HEADERS. Все значения храним как TEXT
// (даты — строками формата схемы), как и в Sheets.
const SCHEMA_VERSION = 1;

const SHEETS = {
  SETTINGS: 'Settings',
  CLIENTS: 'Clients',
  ITEM_TYPES: 'ItemTypes',
  WASHES: 'Washes',
  WASH_ITEMS: 'WashItems',
  SHIFTS: 'Shifts',
  DELIVERIES: 'Deliveries',
  STORAGE: 'Storage',
  LOG: 'Log'
};

const HEADERS = {
  Settings: ['key', 'value'],
  Clients: ['id', 'name', 'contact', 'address', 'type', 'storage', 'active', 'comment', 'item_types', 'accounting'],
  ItemTypes: ['id', 'name', 'sort', 'active'],
  Washes: ['id', 'client_id', 'wash_date', 'issue_date', 'status',
    'dirty_weight_kg', 'items_total', 'comment', 'created_by', 'created_at',
    'started_at', 'done_at', 'issued_at', 'deferred_from', 'deferred_reason', 'bags'],
  WashItems: ['id', 'wash_id', 'item_type_id', 'qty'],
  Shifts: ['id', 'date', 'status', 'opened_at', 'closed_at',
    'total_kg', 'washes_done', 'washes_deferred', 'digest_sent'],
  Deliveries: ['id', 'date', 'client_id', 'ord', 'status',
    'delivered_at', 'pickup', 'driver_comment', 'created_by', 'created_at',
    'clean_taken_at', 'clean_bags', 'picked_at', 'dirty_handed_at'],
  Storage: ['id', 'client_id', 'kind', 'weight_kg', 'items_total',
    'wash_id', 'created_at', 'consumed_at'],
  Log: ['ts', 'actor', 'action', 'entity', 'details']
};

// Стартовое наполнение ItemTypes (spec §3.4).
const START_ITEM_TYPES = [
  'пододеяльник', 'простыня', 'наволочка',
  'полотенце банное', 'полотенце для рук', 'полотенце для ног',
  'халат', 'скатерть', 'салфетка', 'покрывало', 'прочее'
];

module.exports = { SCHEMA_VERSION, SHEETS, HEADERS, START_ITEM_TYPES };
