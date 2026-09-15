import vinext from "vinext";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url)).replaceAll("\\", "/");

export default defineConfig({
  // JSZip has circular CommonJS imports. Bundle it before Vinext's development
  // SSR runner loads client components, just as the production build does.
  environments: { ssr: { optimizeDeps: { include: ["jszip"] } } },
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    watch: { ignored: ["work/**", "outputs/**", "test-results/**", "playwright-report/**", ".local-*"].map((entry) => projectDirectory + entry) },
    proxy: {
      "/local-api": {
        target: "http://127.0.0.1:4319",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/local-api/, ""),
      },
    },
  },
  plugins: [vinext()],
});
