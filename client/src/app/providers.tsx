'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query-client';
import { ToastHost } from '@/components/ui/Toast';
import { OfflineBanner } from '@/components/ui/OfflineBanner';

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <OfflineBanner />
      {children}
      <ToastHost />
    </QueryClientProvider>
  );
}
