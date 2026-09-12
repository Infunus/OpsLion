import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  cacheDir: "node_modules/.vite-tests",
  plugins: [react()],
  server: {
    host: "127.0.0.1", port: 3107, strictPort: true,
    watch: { ignored: ["**/work/**", "**/outputs/**", "**/test-results/**", "**/playwright-report/**", "**/.local-*"] },
  },
});
