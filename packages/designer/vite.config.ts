import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API lives on the port printed by the runtime: LCPF_API=http://127.0.0.1:PORT npm run dev -w @lcpf/designer
const api = process.env.LCPF_API ?? "http://127.0.0.1:7878";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", proxy: { "/api": { target: api, changeOrigin: false, headers: { host: new URL(api).host } } } },
  build: { outDir: "dist", emptyOutDir: true }
});
