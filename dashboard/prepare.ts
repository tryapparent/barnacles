import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repository, writeSnapshot } from "../evidence/read.ts";
import { dashboards } from "./panels.ts";
import { encodeTrace } from "./trace.ts";

async function main() {
  const [input, output, requestedRepository, ...extra] = process.argv.slice(2);
  if (!input || !output || !requestedRepository || extra.length) {
    throw Error("Usage: node dashboard/prepare.ts EVIDENCE_SQLITE NEW_OUTPUT_DIRECTORY OWNER/REPO");
  }
  const repo = repository(requestedRepository);
  const directory = resolve(output);
  if (!statSync(input, { throwIfNoEntry: false })?.isFile()) throw Error("Expected an existing evidence SQLite file");
  if (existsSync(directory)) throw Error("Output directory already exists. Choose a new directory.");
  const staging = mkdtempSync(join(dirname(directory), ".barnacles-snapshot-"));
  try {
    const scratch = mkdtempSync(join(staging, "build-"));
    const payloads = openSync(join(staging, "tempo.ndjson"), "wx", 0o600);
    try {
      const range = await writeSnapshot(resolve(input), join(staging, "dashboard.sqlite"), scratch, repo,
        Math.floor(Date.now() / 1000), (key, trace) => {
          const { traceId, payload } = encodeTrace(key, trace);
          writeSync(payloads, JSON.stringify(payload) + "\n");
          return traceId;
        });
      const provision = join(staging, "dashboards");
      mkdirSync(provision);
      for (const [name, config] of Object.entries(dashboards(range, repo))) {
        writeFileSync(join(provision, name + ".json"), JSON.stringify(config), { flag: "wx" });
      }
    } finally {
      closeSync(payloads);
      rmSync(scratch, { recursive: true, force: true });
    }
    renameSync(staging, directory);
    console.log("Prepared local Grafana snapshot");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
