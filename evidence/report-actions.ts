import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { repository } from "./index.ts";
import { collectTiming, seconds, type TimingPolicy } from "./timing.ts";

async function main() {
  const [file, name, ...extra] = process.argv.slice(2);
  if (!file || !name || extra.length) throw Error("Usage: node evidence/report-actions.ts EVIDENCE_SQLITE OWNER/REPO");
  const repo = repository(name);
  const db = new DatabaseSync(file, { readOnly: true });
  const scratch = mkdtempSync("/tmp/apparent-dev-barnacles-actions-report-");
  try {
    const file = await buildPolicy(scratch, new URL("./metrics.bend", import.meta.url), "metrics.mjs");
    const metrics: TimingPolicy = await loadPolicy(file);
    db.exec("BEGIN");
    const rows = collectTiming(db, repo, metrics).operations().map(({ clock, operation, workflow, stats }) => ({
      workflow_id: workflow, clock, operation, count: stats.count, mean_seconds: seconds(metrics.mean(stats)),
      total_seconds: seconds(metrics.measured_total(stats)), unmeasured_count: stats.missing,
    }));
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
