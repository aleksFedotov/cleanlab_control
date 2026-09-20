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
