import type { MetadataRoute } from "next";

// PWA-манифест: «Добавить на главный экран» на планшетах цеха/водителя.
// Next сам отдаёт его по /manifest.webmanifest и подставляет link в <head>.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CleanLab Pro",
    short_name: "CleanLab",
    description: "Внутренняя панель управления прачечной",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#f8fafc",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
