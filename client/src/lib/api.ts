// Единая точка вызова API: api('getDayList', token, date) → POST /api/getDayList {args:[...]}.
// Поведение — как у legacy-адаптера (server/public/index.html):
// - один повтор при сетевом сбое через 1.5с;
// - res.ok === false → reject с текстом ошибки сервера;
// - 'Нет доступа' → сессия протухла: чистим и уходим на /login;
// - сетевой сбой → offline-полоса (stores/ui).
import { clearSession } from './session';
import { useUiStore } from '@/stores/ui';

export class ApiError extends Error {}

async function rawCall<T>(method: string, args: unknown[]): Promise<T> {
  const r = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError((body && body.error) || `HTTP ${r.status}`);
  return body as T;
}

export async function api<T = any>(method: string, ...args: unknown[]): Promise<T> {
  const ui = useUiStore.getState();
  let res: any;
  try {
    res = await rawCall(method, args);
    ui.setOffline(false);
  } catch {
    // Холодный старт/мигание сети — один повтор (как в legacy)
    try {
      await new Promise((r) => setTimeout(r, 1500));
      res = await rawCall(method, args);
      ui.setOffline(false);
    } catch (e2) {
      ui.setOffline(true);
      throw e2;
    }
  }
  if (res && res.ok === false) {
    if (res.error === 'Нет доступа') {
      clearSession();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        // Полная перезагрузка намеренно: сессия протухла, нужно сбросить весь клиентский стейт
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = '/login';
      }
    }
    throw new ApiError(res.error || 'Ошибка сервера');
  }
  return res as T;
}
