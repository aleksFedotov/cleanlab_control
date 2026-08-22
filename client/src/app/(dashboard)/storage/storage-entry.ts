// Модель строки склада — порт логики renderStorage из server/public/index.html (1:1).
// Единый список белья: stored + cleanReady + partialClean + dirty, у каждой карточки
// состояние (грязное/чистое/внимание), а не принадлежность к списку.

import type { StorageRes, WashItem } from '@/types/api';
import { num } from '@/lib/format';

export type StorageKind = 'dirty' | 'partial' | 'clean';

export interface StorageEntry {
  kind: StorageKind;
  id: string;
  washId: string; // только для partial (id стирки)
  washStatus: string; // только для partial: статус стирки-источника (partial/planned/in_progress)
  hold: boolean; // partial: владелец решил «оставить на складе»
  client_id: string;
  client_name: string;
  kg: number;
  total: number;
  bags: number;
  items: WashItem[];
  issue_date: string;
  since: string; // дата приёмки (dirty) / постановки на склад (partial)
  attn: boolean;
  overdueDays: number;
  rank: number; // порядок: внимание(0) → к стирке(1) → выдача сегодня(2) → готово(3)
  statusKey: string; // ключ словаря lib/dicts для StatusBadge
  statusText: string; // строка статуса, как в legacy
}

// Сколько дней от dateStr до today (просрочка > 0) — порт daysDiff из legacy.
export function daysDiff(dateStr: string, today: string): number {
  if (!dateStr) return 0;
  const p = dateStr.split('-').map(Number);
  const t = today.split('-').map(Number);
  return Math.round((Date.UTC(t[0], t[1] - 1, t[2]) - Date.UTC(p[0], p[1] - 1, p[2])) / 86400000);
}

export function buildEntries(res: StorageRes, today: string): StorageEntry[] {
  const entries: StorageEntry[] = [];

  res.stored.forEach((w) => {
    entries.push({
      kind: 'clean', id: w.id, washId: '', washStatus: '', hold: false, client_id: w.client_id, client_name: w.client_name,
      kg: num(w.dirty_weight_kg), total: num(w.items_total), bags: num(w.bags),
      items: w.items || [], issue_date: w.issue_date, since: '',
      attn: false, overdueDays: 0, rank: 0, statusKey: '', statusText: '',
    });
  });
  (res.cleanReady || []).forEach((s) => {
    entries.push({
      kind: 'clean', id: s.wash_id, washId: '', washStatus: '', hold: false, client_id: s.client_id, client_name: s.client_name,
      kg: num(s.weight_kg), total: num(s.items_total), bags: num(s.bags),
      items: [], issue_date: s.issue_date || '', since: '',
      attn: false, overdueDays: 0, rank: 0, statusKey: '', statusText: '',
    });
  });
  (res.partialClean || []).forEach((s) => {
    entries.push({
      kind: 'partial', id: s.id, washId: s.wash_id, washStatus: s.wash_status, hold: s.wash_hold === 1, client_id: s.client_id, client_name: s.client_name,
      kg: num(s.weight_kg), total: num(s.items_total), bags: num(s.bags),
      items: [], issue_date: '', since: (s.created_at || '').slice(0, 10),
      attn: false, overdueDays: 0, rank: 0, statusKey: '', statusText: '',
    });
  });
  (res.dirty || []).forEach((s) => {
    entries.push({
      kind: 'dirty', id: s.id, washId: '', washStatus: '', hold: false, client_id: s.client_id, client_name: s.client_name,
      kg: 0, total: 0, bags: 0,
      items: [], issue_date: '', since: (s.created_at || '').slice(0, 10),
      attn: false, overdueDays: 0, rank: 0, statusKey: '', statusText: '',
    });
  });

  // Статус и раскраска карточки
  entries.forEach((e) => {
    if (e.kind === 'dirty') {
      e.attn = false;
      e.statusKey = 'planned';
      e.statusText = 'Ожидает стирки';
      e.rank = 1;
    } else if (e.kind === 'partial') {
      e.statusKey = 'partial';
      if (e.hold) {
        // Решение «оставить на складе» принято — не требует внимания
        e.attn = false;
        e.statusText = 'Частичная · оставлено на складе';
        e.rank = 3;
      } else if (e.washStatus === 'planned' || e.washStatus === 'in_progress') {
        // Остаток уже в плане/в работе — решение принято, внимания не требует
        e.attn = false;
        e.statusText =
          e.washStatus === 'in_progress'
            ? 'Частичная · остаток в работе'
            : 'Частичная · остаток к стирке';
        e.rank = 1;
      } else {
        e.attn = true;
        e.statusText = 'Требует решения владельца';
        e.rank = 0;
      }
    } else {
      const d = daysDiff(e.issue_date, today);
      if (d > 0) {
        e.attn = true;
        e.overdueDays = d;
        e.statusKey = 'late';
        e.statusText = `Просрочено на ${d} дн.`;
        e.rank = 0;
      } else if (d === 0) {
        e.attn = false;
        e.statusKey = 'ready';
        e.statusText = 'Выдача сегодня';
        e.rank = 2;
      } else {
        e.attn = false;
        e.statusKey = 'ready';
        e.statusText = 'Готово к выдаче';
        e.rank = 3;
      }
    }
  });

  entries.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const ka = a.issue_date || a.since;
    const kb = b.issue_date || b.since;
    return ka < kb ? -1 : 1;
  });
  return entries;
}

// Строка деталей карточки — порт metaOf из legacy.
export function metaOf(e: StorageEntry): string {
  if (e.kind === 'dirty') return `принято ${e.since}`;
  const m = `${e.kg} кг · ${e.total} шт` + (e.bags > 0 ? ` · ${e.bags} меш.` : '');
  if (e.kind === 'partial') return `${m} · с ${e.since}`;
  return m + (e.issue_date ? ` · выдача ${e.issue_date}` : '');
}
