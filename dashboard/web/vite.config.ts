import react from "@vitejs/plugin-react";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import { buildPolicy } from "../../tooling/bend.ts";

export default defineConfig({
  plugins: [react(), {
    name: "harbor-bend",
    async load(id) {
      if (!["/duration.bend", "/changed-code.bend", "/session-history.bend", "/session-timeline.bend"].some((suffix) => id.endsWith(suffix))) return;
      this.addWatchFile(id);
      const directory = await mkdtemp(join(process.env.BARNACLES_TEST_DIRECTORY ?? "/tmp", "apparent-dev-harbor-bend-"));
      try {
        const module = await buildPolicy(directory, pathToFileURL(id), "duration.mjs");
        return await readFile(module, "utf8");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  }],
});
