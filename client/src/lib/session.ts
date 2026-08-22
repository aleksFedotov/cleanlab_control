// Сессия: те же ключи localStorage, что у legacy-фронта (server/public/index.html),
// чтобы вход переживал переключение между старым и новым фронтом.
export interface Session {
  token: string;
  role: string; // 'owner' | 'worker' | 'driver'
  name: string;
  laundryId: string;
}

const KEYS = { token: 'cl_token', role: 'cl_role', name: 'cl_name', laundry: 'cl_laundry' };

function ls(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

// Подписка на изменение сессии (для useSyncExternalStore в use-session.ts)
const listeners = new Set<() => void>();
export const sessionEvents = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit() {
    listeners.forEach((fn) => fn());
  },
};

export function getSession(): Session | null {
  const s = ls();
  if (!s) return null;
  const token = s.getItem(KEYS.token);
  const role = s.getItem(KEYS.role);
  if (!token || !role) return null;
  return {
    token,
    role,
    name: s.getItem(KEYS.name) || '',
    laundryId: s.getItem(KEYS.laundry) || '',
  };
}

export function saveSession(res: { token: string; role: string; name?: string; laundryId?: string }) {
  const s = ls();
  if (!s) return;
  s.setItem(KEYS.token, res.token);
  s.setItem(KEYS.role, res.role);
  s.setItem(KEYS.name, res.name || '');
  s.setItem(KEYS.laundry, res.laundryId || '');
  sessionEvents.emit();
}

export function setLaundryId(laundryId: string) {
  ls()?.setItem(KEYS.laundry, laundryId);
  sessionEvents.emit();
}

export function clearSession() {
  const s = ls();
  if (!s) return;
  s.removeItem(KEYS.token);
  s.removeItem(KEYS.role);
  s.removeItem(KEYS.name);
  s.removeItem(KEYS.laundry);
  sessionEvents.emit();
}
