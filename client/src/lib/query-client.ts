import { QueryClient } from '@tanstack/react-query';

let client: QueryClient | null = null;

// Singleton: в App Router layout ререндерится, поэтому клиент создаём лениво один раз.
// retry: 0 — сетевой ретрай уже есть в lib/api.ts.
export function getQueryClient(): QueryClient {
  if (!client) {
    client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 0,
          staleTime: 15_000,
          refetchOnWindowFocus: true,
        },
        mutations: { retry: 0 },
      },
    });
  }
  return client;
}
