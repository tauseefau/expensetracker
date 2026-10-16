import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the app hosts cleanly under a subpath (/expense/) behind a
  // reverse proxy that strips the prefix. Works at root or any subpath.
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8090",
    },
  },
});