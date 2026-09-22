import type { WashStatus } from '@/types/api';

export type WashColumn = 'todo' | 'doing' | 'done' | 'hidden';

// Единственный источник раскладки статуса стирки по колонкам дня.
// Record<WashStatus, …> — exhaustive: новый статус без раскладки не скомпилируется.
export const WASH_COLUMN: Record<WashStatus, WashColumn> = {
  planned: 'todo',
  no_linen: 'done',
  in_progress: 'doing',
  done: 'done',
  stored: 'done',
  partial: 'done',
  ready_clean: 'done',
  issued: 'done',
  cancelled: 'hidden',
};

export function washColumn(w: { status: WashStatus }): WashColumn {
  return WASH_COLUMN[w.status];
}

// «Исправить данные» доступно только для реально постиранного (server/core.js
// canEditWashData_). Для ready_clean/no_linen/issued данных стирки нет — у
// ready_clean чистое лежит ручной складской записью, и правка стирки
// отклонялась бы сервером с нулями в форме.
export function canEditWashData(w: { status: WashStatus }): boolean {
  return w.status === 'done' || w.status === 'stored' || w.status === 'partial';
}
