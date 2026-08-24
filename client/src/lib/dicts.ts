// Единственный источник правды для подписей и цветов статусов/ролей (спека §2, §8).
// Никаких локальных перекрасок вне этого файла.

export type StatusTone = 'ok' | 'wash' | 'warn' | 'late' | 'neutral';

export interface StatusInfo {
  label: string;
  tone: StatusTone;
}

// Статусы стирок и визитов. Подписи — как в legacy (STATUS_LABELS),
// тона — по карте статусов дизайн-спеки §2.
export const STATUSES: Record<string, StatusInfo> = {
  // Стирки
  planned: { label: 'К стирке', tone: 'neutral' },
  in_progress: { label: 'В работе', tone: 'wash' },
  done: { label: 'Готово', tone: 'ok' },
  stored: { label: 'На складе', tone: 'wash' },
  partial: { label: 'Частично', tone: 'warn' },
  no_linen: { label: 'Нет белья', tone: 'neutral' },
  ready_clean: { label: 'Чистое на складе', tone: 'ok' },
  issued: { label: 'Выдано', tone: 'neutral' },
  cancelled: { label: 'Отменено', tone: 'neutral' },
  deferred: { label: 'Перенесено', tone: 'warn' },
  // Визиты развоза
  new: { label: 'Очередь', tone: 'neutral' },
  wash: { label: 'В стирке', tone: 'wash' },
  ready: { label: 'Готово', tone: 'ok' },
  ready_ship: { label: 'К погрузке', tone: 'ok' },
  en_route: { label: 'В пути к клиенту', tone: 'wash' },
  late: { label: 'Просрочено', tone: 'late' },
  delivered: { label: 'Выдано', tone: 'ok' },
  picked: { label: 'Забрано', tone: 'neutral' },
  both: { label: 'Выдано + забрано', tone: 'ok' },
  empty: { label: 'Ничего нет', tone: 'neutral' },
};

export function statusInfo(status: string): StatusInfo {
  return STATUSES[status] || { label: status, tone: 'neutral' };
}

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  worker: 'Работник',
  driver: 'Водитель',
  client: 'Клиент',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] || role;
}
