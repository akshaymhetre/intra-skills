import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Default: the dev registry from scripts/dev/up.sh.
  const target = env.VITE_API_TARGET || "http://127.0.0.1:7720";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: { "/api": { target, changeOrigin: false } },
    },
    build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
  };
});
