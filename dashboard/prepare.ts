import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { snapshotFormatVersion, writeSnapshot } from "../evidence/read.ts";
import { dashboards } from "./panels.ts";

function validateSnapshot(directory: string) {
  const path = join(directory, "snapshot.json");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw Error("Missing snapshot manifest. Prepare a new dashboard snapshot.");
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.formatVersion !== snapshotFormatVersion) {
    throw Error(`Unsupported snapshot format. Prepare a version ${snapshotFormatVersion} snapshot.`);
  }
  for (const file of ["dashboard.sqlite", "tempo.ndjson", "dashboards/shipping.json"]) {
    if (!statSync(join(directory, file), { throwIfNoEntry: false })?.isFile()) {
      throw Error(`Incomplete snapshot: missing ${file}.`);
    }
  }
}

async function prepare(args: string[]) {
  const [input, output, requestedRepository, asOf, ...extra] = args;
  if (input === "--validate" && output && !requestedRepository) {
    validateSnapshot(output);
    return;
  }
  if (!input || !output || !requestedRepository || extra.length) {
    throw Error("Usage: node dashboard/prepare.ts EVIDENCE_SQLITE NEW_OUTPUT_DIRECTORY OWNER/REPO [AS_OF_UTC]");
  }
  const timingCutoff = asOf === undefined ? Math.floor(Date.now() / 1000) * 1000 : Date.parse(asOf);
  if (!Number.isFinite(timingCutoff) || timingCutoff < 86400000 || (asOf !== undefined &&
      new Date(timingCutoff).toISOString() !== asOf.replace(/(T\d{2}:\d{2}:\d{2})Z$/, "$1.000Z"))) {
    throw Error("Expected AS_OF_UTC in UTC seconds or milliseconds at least one day after the Unix epoch");
  }
  const cutoff = Math.floor(timingCutoff / 1000);
  const directory = resolve(output);
  if (!statSync(input, { throwIfNoEntry: false })?.isFile()) throw Error("Expected an existing evidence SQLite file");
  if (existsSync(directory)) throw Error("Output directory already exists. Choose a new directory.");
  const staging = mkdtempSync(join(dirname(directory), ".plow-snapshot-"));
  try {
    const scratch = mkdtempSync(join(staging, "build-"));
    const payloads = openSync(join(staging, "tempo.ndjson"), "wx", 0o600);
    try {
      const range = await writeSnapshot(resolve(input), join(staging, "dashboard.sqlite"), scratch, requestedRepository,
        cutoff, (_key, _trace, encode) => {
          const { trace_id, payload_bytes } = encode();
          writeSync(payloads, payload_bytes + "\n", null, "latin1");
          return trace_id;
        }, undefined, timingCutoff);
      const provision = join(staging, "dashboards");
      mkdirSync(provision);
      for (const [name, config] of Object.entries(dashboards(range, range.repository))) {
        writeFileSync(join(provision, name + ".json"), JSON.stringify(config), { flag: "wx" });
      }
      writeFileSync(join(staging, "snapshot.json"), JSON.stringify(range.manifest) + "\n", { flag: "wx" });
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

prepare(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
