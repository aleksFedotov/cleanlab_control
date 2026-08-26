// Типы контракта API (POST /api/<method>, {args:[...]}). Снято с server/api.js, server/deliveries.js,
// server/storage.js, server/auth.js. БД хранит всё как TEXT — «числовые» поля могут приходить
// строкой или '' (помечены number | ''); вычисляемые сервером поля — всегда числа.

export type UserRole = 'owner' | 'worker' | 'driver' | 'client';

export type WashStatus =
  | 'planned' | 'no_linen' | 'in_progress' | 'done' | 'stored'
  | 'partial' | 'ready_clean' | 'issued' | 'cancelled';

export type VisitStatus = 'planned' | 'delivered' | 'picked' | 'both' | 'empty' | 'cancelled';

// --- Базовые сущности ---

export interface Wash {
  id: string;
  client_id: string;
  wash_date: string;
  issue_date: string;
  status: WashStatus;
  dirty_weight_kg: number | '';
  items_total: number | '';
  comment: string;
  created_by: string;
  created_at: string;
  started_at: string;
  done_at: string;
  issued_at: string;
  deferred_from: string;
  deferred_reason: string;
  bags: number | '';
  laundry_id: string;
}

export interface DayWash extends Wash {
  client_name: string;
  has_dirty: boolean;
  has_clean: boolean;
  client_item_types: string[];
  client_accounting: 'weight' | 'count' | 'both';
  // Остаток частичной стирки: часть уже постирана в предыдущем заходе
  partial_rest?: boolean;
  prev_items?: { item_type_id: string; qty: number; item_name?: string }[];
  prev_kg?: number | '';
  prev_bags?: number | '';
  // Состав постиранного у завершённых (done/stored/partial/ready_clean) — для правки
  items?: { item_type_id: string; qty: number; item_name?: string }[];
}

export interface Shift {
  id: string;
  date: string;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string;
  total_kg: number | '';
  washes_done: number | '';
  washes_deferred: number | '';
  digest_sent: string;
  laundry_id: string;
}

export interface Client {
  id: string;
  name: string;
  contact: string;
  address: string;
  type: string;
  active: string; // 'да' | 'нет'
  comment: string;
  item_types: string; // JSON-массив id строкой или ''
  accounting: string; // 'weight' | 'count' | 'both' | ''
  // Реквизиты (опционально): ИНН, КПП, юридический адрес
  inn: string;
  kpp: string;
  legal_address: string;
  laundry_id: string;
}

export interface ItemType {
  id: string;
  name: string;
  sort: number | string;
  active: string;
}

export interface Visit {
  id: string;
  date: string;
  client_id: string;
  ord: number | string;
  status: VisitStatus;
  delivered_at: string;
  pickup: string; // '' | 'да'
  driver_comment: string;
  created_by: string;
  created_at: string;
  clean_taken_at: string;
  clean_bags: number | '';
  picked_at: string;
  dirty_handed_at: string;
  pickup_only: string; // '' | 'да'
  laundry_id: string;
}

export interface DecoratedVisit extends Visit {
  client_name: string;
  has_clean: boolean;
  has_dirty: boolean;
  clean_kg: number;
  clean_items: number;
  clean_stock_bags: number;
}

export interface NotReady {
  client_id: string;
  client_name: string;
  reason: 'washing_incomplete' | 'partial' | 'no_clean';
  visit_id: string;
}

export interface WashItem {
  id: string;
  wash_id: string;
  item_type_id: string;
  qty: number | string;
}

export interface StorageRow {
  id: string;
  client_id: string;
  kind: 'dirty' | 'clean';
  weight_kg: number | '';
  items_total: number | '';
  wash_id: string;
  created_at: string;
  consumed_at: string;
  laundry_id: string;
  client_name: string;
  wash_status: string;
  wash_hold?: number; // 1 — владелец решил «оставить на складе» (partial + hold)
  issue_date: string;
  bags: number;
}

export interface DayReport {
  date: string;
  totalKg: number;
  washesDone: number;
  deferred: number;
  cancelled: number;
  stored: number;
  issued: number;
}

export interface UserRow {
  id: string;
  laundry_id: string;
  name: string;
  role: UserRole;
  login: string;
  active: string; // 'да' | 'нет'
  client_id: string;
}

export interface LaundryRow {
  id: string;
  name: string;
  tvKey: string;
}

// --- Ответы чтений ---

export interface LoginRes {
  ok: true;
  token: string;
  role: UserRole;
  name: string;
  laundryId: string;
  laundries?: Array<{ id: string; name: string }>;
}

export interface DayListRes {
  ok: true;
  date: string;
  laundryName: string;
  washes: DayWash[];
  shift: Shift | null;
  clients: Client[];
  itemTypes: ItemType[];
}

export interface DeliveryVisitsRes {
  ok: true;
  date: string;
  visits: DecoratedVisit[];
  notReady: NotReady[];
  clients: Client[];
}

export interface WeekPlanRes {
  ok: true;
  monday: string;
  days: Array<{ date: string; cards: DecoratedVisit[] }>;
  clients: Client[];
}

export interface StorageRes {
  ok: true;
  stored: Array<Wash & { client_name: string; items: WashItem[] }>;
  dirty: StorageRow[];
  clean: StorageRow[];
  cleanReady: StorageRow[];
  partialClean: StorageRow[];
  itemTypes: ItemType[];
}

export interface DayReportRes {
  ok: true;
  report: DayReport;
  washes: Array<Wash & { client_name: string; items: Array<WashItem & { item_name: string }> }>;
  shift: Shift | null;
}

export interface SummaryReportItem {
  item_type_id: string;
  item_name: string;
  qty: number;
}

export interface SummaryReportClient {
  client_id: string;
  client_name: string;
  washes: number;
  bags: number;
  weight_kg: number;
  items_total: number;
  items: SummaryReportItem[];
}

export interface SummaryReportRes {
  ok: true;
  from: string;
  to: string;
  clients: SummaryReportClient[];
}

export interface RefsRes {
  ok: true;
  clients: Client[];
  itemTypes: ItemType[];
}

export interface UsersRes {
  ok: true;
  users: UserRow[];
}

export interface LaundriesRes {
  ok: true;
  laundries: LaundryRow[];
}

export interface DriverRouteRes {
  ok: true;
  date: string;
  laundryName: string;
  cargo: { clean_bags: number; clean_points: number; dirty_points: number };
  visits: Array<DecoratedVisit & { address: string }>;
}

export interface ShiftCloseStateRes {
  ok: true;
  date: string;
  blockers: Array<Wash & { client_name: string }>;
  notReady: NotReady[];
  report: DayReport;
  shift: Shift | null;
}

// --- Табель: часы работников и статистика развозов (server/workhours.js) ---

export interface WorkHoursEntry {
  id: string;
  user_id: string;
  date: string; // yyyy-MM-dd
  hours: string; // число строкой, напр. '7.5' (TEXT в БД)
  updated_by: string;
  updated_at: string;
}

export interface WorkHoursRes {
  ok: true;
  entries: WorkHoursEntry[];
  workers?: Array<{ id: string; name: string }>; // только владельцу
}

export interface DeliveryPointStatsDay {
  date: string;
  total: number;
  only_delivery: number;
  only_pickup: number;
  both: number;
}

export interface DeliveryPointStatsRes {
  ok: true;
  from: string;
  to: string;
  days: DeliveryPointStatsDay[];
}
