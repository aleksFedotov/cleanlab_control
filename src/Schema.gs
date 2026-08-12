// Схема данных CleanLab Control (spec §3). Константы листов и колонок.
var SCHEMA_VERSION = 1;

var SHEETS = {
  SETTINGS: 'Settings',
  CLIENTS: 'Clients',
  ITEM_TYPES: 'ItemTypes',
  WASHES: 'Washes',
  WASH_ITEMS: 'WashItems',
  SHIFTS: 'Shifts',
  LOG: 'Log'
};

var HEADERS = {
  Settings: ['key', 'value'],
  Clients: ['id', 'name', 'contact', 'address', 'type', 'storage', 'active', 'comment'],
  ItemTypes: ['id', 'name', 'sort', 'active'],
  Washes: ['id', 'client_id', 'wash_date', 'issue_date', 'status',
    'dirty_weight_kg', 'items_total', 'comment', 'created_by', 'created_at',
    'started_at', 'done_at', 'issued_at', 'deferred_from', 'deferred_reason'],
  WashItems: ['id', 'wash_id', 'item_type_id', 'qty'],
  Shifts: ['id', 'date', 'status', 'opened_at', 'closed_at',
    'total_kg', 'washes_done', 'washes_deferred', 'digest_sent'],
  Log: ['ts', 'actor', 'action', 'entity', 'details']
};

// Стартовое наполнение ItemTypes (spec §3.4).
var START_ITEM_TYPES = [
  'пододеяльник', 'простыня', 'наволочка',
  'полотенце банное', 'полотенце для рук', 'полотенце для ног',
  'халат', 'скатерть', 'салфетка', 'покрывало', 'прочее'
];
