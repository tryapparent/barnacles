import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { snapshotFormatVersion, writeSnapshot } from "../evidence/read.ts";
import { buildPolicies, loadPolicy } from "../tooling/bend.ts";
import { accessVerifier, feedPayload } from "./plow/worker.mjs";

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

const threadId = /^[a-f0-9]{24}$/;

function readAnalysis(file: string, thread?: string): string | undefined {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    const item = thread
      ? db.prepare("SELECT payload FROM analysis_threads WHERE id=?").get(thread)
      : db.prepare("SELECT payload FROM analysis_summary WHERE id=1").get();
    return item ? String(item.payload) : undefined;
  } finally {
    db.close();
  }
}

type Tool = { name: string; description: string; input: { $: "Bottlenecks" | "Thread" | "Timeline" | "Charts" } };
type ToolList = { $: "Con"; head: Tool; tail: ToolList } | { $: "Nil" };

type TimelineRow = {
  startUtcMs: number;
  end: number;
  work: [number, number, string][];
  wait: [number, number, string][];
  detail?: [number, number, string][];
};
type Charts = { charts(rows: unknown, end: number): object };
type BendList = { $: "Con"; head: unknown; tail: BendList } | { $: "Nil" };
const bendList = (items: unknown[]) =>
  items.reduceRight<BendList>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

function chartJson(_key: string, value: unknown) {
  const list = value as BendList | undefined;
  if (list?.$ !== "Con" && list?.$ !== "Nil") return value;
  const entries = [];
  for (let next = list; next.$ === "Con"; next = next.tail) entries.push(next.head);
  return entries;
}

function dashboardData(feedFile: string, type: "Timeline" | "Charts", policy: Charts) {
  const feed = JSON.parse(feedPayload(readFileSync(feedFile, "utf8")));
  if (feed.unavailable) return;
  const { observed, traces, overview } = feed;
  if (type === "Timeline") return JSON.stringify({ observed, traces });
  const millis = (seconds: number) => Math.round(seconds * 1000);
  const rows = (overview?.traces ?? traces).map((row: TimelineRow, index: number) => {
    const intervals = (clock: [number, number, string][], kind: number) =>
      clock.map(([a, b, name]) => ({ $: "Interval", a: millis(a), b: millis(b), name, kind }));
    return { $: "ChartRow", index: index + 1, start: row.startUtcMs, duration: millis(row.end),
      intervals: bendList([...intervals(row.work, 2), ...intervals(row.detail ?? [], 3), ...intervals(row.wait, 1)]) };
  });
  return JSON.stringify({ observed, ...policy.charts(bendList(rows), overview?.to ?? observed) }, chartJson);
}

async function analysisMcp(file: string) {
  const { PLOW_MCP_ACCESS_TEAM: team, PLOW_MCP_ACCESS_AUDIENCE: audience } = process.env;
  if (!team && !audience) return;
  if (!/^[a-z0-9-]+$/.test(team ?? "") || !/^[a-f0-9]{64}$/.test(audience ?? "")) {
    throw Error("Invalid Plow MCP Access issuer or audience.");
  }
  const issuer = `https://${team}.cloudflareaccess.com`;
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
  const verify = accessVerifier(jwtVerify, keys, issuer, audience);
  const scratch = mkdtempSync(join(tmpdir(), "apparent-dev-plow-mcp-"));
  let tools: ToolList;
  let charts: Charts;
  try {
    const [toolPolicy, chartPolicy] = await buildPolicies(scratch, [
      [new URL("../mcp/tools.bend", import.meta.url), "tools.mjs"],
      [new URL("../mcp/charts.bend", import.meta.url), "charts.mjs"],
    ]);
    tools = (await loadPolicy<{ tools(): ToolList }>(toolPolicy)).tools();
    charts = await loadPolicy<Charts>(chartPolicy);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const feedFile = process.env.PLOW_MCP_FEED_FILE ?? "/dashboard-feed/timeline.json";
  return async (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
    response.setHeader("Cache-Control", "private, no-store");
    if (request.headers.origin && request.headers.origin !== "https://plow.tryapparent.com") {
      return response.writeHead(403).end();
    }
    if (!await verify(request.headers["cf-access-jwt-assertion"])) return response.writeHead(401).end();
    const server = new McpServer({ name: "Plow", version: "1.0.0" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => void server.close());
    for (let list = tools; list.$ === "Con"; list = list.tail) {
      const { name, description, input } = list.head;
      const kind = input.$;
      server.registerTool(name, {
        description, inputSchema: kind === "Thread" ? { threadId: z.string().regex(threadId) } : {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, args => {
        const id = "threadId" in args ? args.threadId : undefined;
        try {
          const payload = kind === "Charts" || kind === "Timeline"
            ? dashboardData(feedFile, kind, charts)
            : readAnalysis(file, id);
          if (payload) {
            return { content: [{ type: "text", text: payload }], structuredContent: JSON.parse(payload) };
          }
          if (id) return { isError: true, content: [{ type: "text", text: "Thread is absent from the current analysis." }] };
        } catch {}
        const message = kind === "Charts" || kind === "Timeline" ? "Dashboard activity is unavailable." : "Plow analysis is unavailable.";
        return { isError: true, content: [{ type: "text", text: message }] };
      });
    }
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };
}

export async function serveAnalysis(file: string, port: string) {
  const user = process.env.PLOW_ANALYSIS_USER;
  if (!file || !user || !/^[0-9]{1,5}$/.test(port)) throw Error("Expected an analysis database, port and private API identity");
  const origin = "https://plow.tryapparent.com";
  const mcp = await analysisMcp(file);
  return createServer((request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (path === "/app/mcp" && mcp) {
      void mcp(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      return;
    }
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
    const summary = path === "/api/v1/bottlenecks";
    const id = path?.startsWith("/api/v1/bottlenecks/threads/") ? path.slice("/api/v1/bottlenecks/threads/".length) : "";
    const thread = threadId.test(id) ? id : undefined;
    if (!summary && !thread) return start(404).end();
    if (request.headers["tailscale-user-login"] !== user) return start(403).end();
    if (request.method === "OPTIONS") return start(204).end();
    if (request.method !== "GET") return start(405).end();
    try {
      const payload = readAnalysis(file, thread);
      start(payload ? 200 : thread ? 404 : 503).end(payload);
    } catch {
      start(503).end();
    }
  }).listen(Number(port), process.env.PLOW_ANALYSIS_BIND_HOST ?? "127.0.0.1");
}

function deployT3History(release: string) {
  const etc = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const settings = process.env.PLOW_T3_DEPLOY_ENV ?? join(etc, "plow-t3-otel", "compose.env");
  if (!existsSync(settings)) return;
  const stack = join(resolve(release), "collector/t3-otel/compose.yaml");
  const docker = (...args: string[]) => execFileSync("docker", ["--context", "rootless", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  }).trim();
  const project = process.env.PLOW_T3_COMPOSE_PROJECT || "plow-t3-otel";
  const compose = (file: string, ...args: string[]) =>
    docker("compose", "--project-name", project, "--env-file", settings, "-f", file, ...args);
  const config = JSON.parse(compose(stack, "config", "--format", "json"));
  const service = config.services?.history;
  if (!service) return;
  if (service.ports?.length || service.network_mode === "host" || !service.healthcheck) throw Error("Invalid T3 history deployment config");
  const id = compose(stack, "ps", "-a", "-q", "history");
  if (!id) throw Error("Expected the installed T3 history service");
  const previous = JSON.parse(docker("inspect", id))[0];
  const original = previous.Config.Labels["com.docker.compose.project.config_files"];
  if (original === stack && previous.State.Health?.Status === "healthy") return;
  if (!original || !existsSync(original)) throw Error("Missing the installed T3 history release");
  const tag = previous.Config.Image;
  const backup = `${project}-history-rollback:latest`;
  docker("image", "tag", previous.Image, backup);
  let switching = false;
  try {
    compose(stack, "build", "history");
    switching = true;
    compose(stack, "up", "--detach", "--no-deps", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "75", "history");
    console.log("Promoted T3 history from the verified collector release");
  } catch {
    docker("image", "tag", backup, tag);
    if (switching) compose(original, "up", "--detach", "--no-deps", "--no-build", "history");
    throw Error("T3 history promotion failed");
  }
}

if (import.meta.main && process.argv[2] === "--analysis-api") {
  await serveAnalysis(process.argv[3], process.argv[4]);
} else if (import.meta.main && process.argv[2] === "--deploy-t3-history") {
  try {
    deployT3History(process.argv[3]);
  } catch {
    console.error("Could not promote the T3 history service");
    process.exitCode = 1;
  }
} else if (import.meta.main) {
  prepare(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
