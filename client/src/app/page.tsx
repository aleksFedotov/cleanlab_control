'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';

// "/" → редирект по роли
export default function Home() {
  const router = useRouter();
  const session = useSession();
  useEffect(() => {
    if (session === undefined) return;
    if (!session) return router.replace('/login');
    router.replace(session.role === 'driver' ? '/driver' : session.role === 'worker' ? '/worker' : '/today');
  }, [session, router]);
  return null;
}
