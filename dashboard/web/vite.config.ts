import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react()],
  build: {
    write: false,
    lib: {
      entry: fileURLToPath(new URL("./main.tsx", import.meta.url)),
      formats: ["iife"],
      name: "PlowUI",
    },
  },
});
