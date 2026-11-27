import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { snapshotFormatVersion, writeSnapshot } from "../evidence/read.ts";

function validateSnapshot(directory: string) {
  const path = join(directory, "snapshot.json");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw Error("Missing snapshot manifest. Prepare a new dashboard snapshot.");
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.formatVersion !== snapshotFormatVersion) {
    throw Error(`Unsupported snapshot format. Prepare a version ${snapshotFormatVersion} snapshot.`);
  }
  for (const file of ["dashboard.sqlite", "tempo.ndjson"]) {
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
      writeFileSync(join(staging, "snapshot.json"), JSON.stringify(range.manifest) + "\n", { flag: "wx" });
    } finally {
      closeSync(payloads);
      rmSync(scratch, { recursive: true, force: true });
    }
    renameSync(staging, directory);
    console.log("Prepared local Plow snapshot");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function serveAnalysis(file: string, port: string) {
  const user = process.env.PLOW_ANALYSIS_USER;
  if (!file || !user || !/^[0-9]{1,5}$/.test(port)) throw Error("Expected an analysis database, port and private API identity");
  const origin = "https://plow.tryapparent.com";
  createServer((request, response) => {
    const start = (status: number) => response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Private-Network": "true",
      Vary: "Origin",
    });
    if (request.headers.origin !== undefined && request.headers.origin !== origin) return start(403).end();
    const path = request.url?.split("?", 1)[0];
    const summary = path === "/api/v1/bottlenecks";
    const thread = /^\/api\/v1\/bottlenecks\/threads\/([a-f0-9]{24})$/.exec(path ?? "")?.[1];
    if (!summary && !thread) return start(404).end();
    if (request.headers["tailscale-user-login"] !== user) return start(403).end();
    if (request.method === "OPTIONS") return start(204).end();
    if (request.method !== "GET") return start(405).end();
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout=3000");
        const item = thread
          ? db.prepare("SELECT payload FROM analysis_threads WHERE id=?").get(thread)
          : db.prepare("SELECT payload FROM analysis_summary WHERE id=1").get();
        start(item ? 200 : thread ? 404 : 503).end(item ? String(item.payload) : undefined);
      } finally {
        db.close();
      }
    } catch {
      start(503).end();
    }
  }).listen(Number(port), process.env.PLOW_ANALYSIS_BIND_HOST ?? "127.0.0.1");
}

if (process.argv[2] === "--analysis-api") {
  serveAnalysis(process.argv[3], process.argv[4]);
} else {
  prepare(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
