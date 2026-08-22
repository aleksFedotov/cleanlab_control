'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { getSession, clearSession, sessionEvents, type Session } from '@/lib/session';
import { api } from '@/lib/api';

// Кэш снимка: getSession() каждый раз возвращает новый объект — useSyncExternalStore зациклится.
let snapshot: Session | null | undefined; // undefined — ещё не прочитали (SSR)
function readSnapshot(): Session | null | undefined {
  if (typeof window === 'undefined') return undefined;
  if (snapshot === undefined) snapshot = getSession();
  return snapshot;
}
sessionEvents.subscribe(() => {
  snapshot = undefined; // инвалидируем кэш при login/logout/switchLaundry
});

// Сессия из localStorage. null — не залогинен; undefined — ещё не прочитали (SSR/первый рендер).
export function useSession(): Session | null | undefined {
  return useSyncExternalStore(sessionEvents.subscribe, readSnapshot, () => undefined);
}

// Guard: ждёт чтения сессии; если роль не подходит — редирект на /login (или по роли).
// Возвращает сессию, только когда она валидна для этой страницы, иначе null.
export function useRequireRole(roles: string[]): Session | null {
  const router = useRouter();
  const session = useSession();
  useEffect(() => {
    if (session === undefined) return;
    if (session === null || !roles.includes(session.role)) {
      router.replace('/login');
    }
  }, [session, roles, router]);
  if (!session || !roles.includes(session.role)) return null;
  return session;
}

export function useLogout() {
  const router = useRouter();
  return () => {
    const s = getSession();
    const p = s ? api('logout', s.token) : Promise.resolve();
    Promise.resolve(p).finally(() => {
      clearSession();
      router.replace('/login');
    });
  };
}
