// Производное состояние визита развоза: какой бейдж показать, в какую категорию
// фильтра попадает, просрочен ли. Приоритеты — 1:1 из legacy renderDelivery
// (server/public/index.html:1578-1595), плюс «просрочен» из дизайн-спеки §5
// (planned-визит на прошедшую дату).
import type { DecoratedVisit } from '@/types/api';
import { todayStr, timeOf } from '@/lib/dates';

export type VisitCategory = 'ready' | 'wash' | 'queue' | 'late';

export interface VisitState {
  // Ключ статуса из lib/dicts для StatusBadge; null — показываем текстовый чип noteText
  badgeKey: string | null;
  noteText: string | null;
  // null — визит показывается только во вкладке «Все»
  category: VisitCategory | null;
  overdue: boolean;
}

// Причины неготовности — как в legacy REASONS
export const NOT_READY_REASONS: Record<string, string> = {
  washing_incomplete: 'стирка не завершена',
  partial: 'стирка частичная',
  no_clean: 'нет чистого белья',
};

export function visitState(v: DecoratedVisit, reason: string | undefined, date: string): VisitState {
  // Завершённые/отменённые визиты — бейдж по статусу, вне фильтров
  if (v.status !== 'planned') {
    return { badgeKey: v.status, noteText: null, category: null, overdue: false };
  }
  // Просрочен: день прошёл, а визит так и не закрыт (спека §5 — красная кромка)
  if (date < todayStr()) {
    return { badgeKey: 'late', noteText: null, category: 'late', overdue: true };
  }
  if (v.pickup_only === 'да') {
    return { badgeKey: null, noteText: 'Только забрать грязное', category: null, overdue: false };
  }
  if (reason === 'washing_incomplete' || reason === 'partial') {
    return { badgeKey: 'wash', noteText: null, category: 'wash', overdue: false };
  }
  if (reason) {
    // no_clean: чистого нет и стирки нет — ждёт в очереди
    return { badgeKey: 'new', noteText: null, category: 'queue', overdue: false };
  }
  if (v.clean_taken_at) {
    // Чистое забрано со склада, но ещё не доставлено — водитель в пути
    return { badgeKey: 'en_route', noteText: null, category: 'ready', overdue: false };
  }
  if (v.has_clean) {
    return { badgeKey: 'ready_ship', noteText: null, category: 'ready', overdue: false };
  }
  return { badgeKey: 'new', noteText: null, category: 'queue', overdue: false };
}

// Строка деталей карточки — meta из legacy renderDelivery + причина неготовности
export function visitDetails(v: DecoratedVisit, address: string | undefined, reason: string | undefined): string[] {
  const meta: string[] = [];
  if (address) meta.push(address);
  if (v.status === 'planned' && !v.clean_taken_at && v.has_clean) {
    meta.push(`чистое: ${v.clean_kg} кг / ${v.clean_items} шт`);
  }
  if (v.has_dirty && v.status !== 'picked' && v.status !== 'both') meta.push('забрать грязное');
  if (v.picked_at) meta.push(`грязное забрано в ${timeOf(v.picked_at)}`);
  if (reason) meta.push(NOT_READY_REASONS[reason] || reason);
  return meta;
}
