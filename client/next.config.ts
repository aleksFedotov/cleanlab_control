import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API живёт на Express — в dev проксируем /api/* туда.
  // В проде /api разводит Caddy, rewrite не задействуется.
  // API_ORIGIN нужен E2E (Playwright поднимает Express на отдельном порту).
  rewrites() {
    const origin = process.env.API_ORIGIN || "http://localhost:3100";
    return [
      {
        source: "/api/:path*",
        destination: `${origin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
