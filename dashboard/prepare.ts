import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { openShippingReview, readPollMinutes, savePollMinutes, snapshotFormatVersion, writeSnapshot } from "../evidence/read.ts";
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
  const staging = mkdtempSync(join(dirname(directory), ".barnacles-snapshot-"));
  try {
    const scratch = mkdtempSync(join(staging, "build-"));
    const payloads = openSync(join(staging, "tempo.ndjson"), "wx", 0o600);
    try {
      const range = await writeSnapshot(resolve(input), join(staging, "dashboard.sqlite"), scratch, requestedRepository,
        cutoff, (_key, _trace, encode) => {
          const { trace_id, payload_bytes } = encode();
          writeSync(payloads, payload_bytes + "\n", null, "latin1");
          return trace_id;
        }, undefined, timingCutoff, join(staging, "review-policy.mjs"));
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

class InvalidRequest extends Error {}

const errors = {
  invalid_window: "Use an ordered UTC range of at most 366 days. Its start must be at or before the effective cutoff.",
  invalid_clock: "Choose Tool envelopes, Async cells, CI queue, CI execution, or CI steps.",
  invalid_page: "Use a limit from 1 to 100 and an offset from 0 to 1000000.",
  pull_request_not_observed: "No milestone for this pull request was observed by the requested cutoff.",
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function error(response: ServerResponse, status: number, code: string, message: string) {
  json(response, status, { error: { code, message } });
}

function queryParams(search: URLSearchParams, names: string[]) {
  const parameters = new Map<string, string>();
  for (const [name, value] of search) {
    if (!names.includes(name) || parameters.has(name) || !value.trim() || value.length > 250) {
      throw new InvalidRequest("Use each documented query parameter at most once with a non-empty value.");
    }
    parameters.set(name, value);
  }
  return parameters;
}

function utcTime(value?: string) {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z)?$/.exec(value);
  if (!match) throw new InvalidRequest("Use YYYY-MM-DD or a UTC timestamp ending in Z.");
  const expected = `${match[1]}T${match[2] ?? "00:00:00"}.${(match[3] ?? "").padEnd(3, "0")}Z`;
  const time = Date.parse(expected);
  if (!Number.isFinite(time) || time < 0 || new Date(time).toISOString() !== expected) {
    throw new InvalidRequest("Use a valid UTC date on or after 1970-01-01.");
  }
  return time;
}

function natural(value: string, label: string) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) throw new InvalidRequest(`${label} must be a non-negative integer.`);
  return number;
}

const webTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

function pollingSettings(file: string, url: URL, method: string | undefined,
  origin: string | undefined, expectedOrigin: string, response: ServerResponse) {
  try {
    if (method === "GET") {
      queryParams(url.searchParams, []);
      return json(response, 200, { minutes: readPollMinutes(file) });
    }
    if (method === "PUT") {
      if (origin !== expectedOrigin) return error(response, 403, "invalid_origin", "Save from Harbor Settings.");
      const value = queryParams(url.searchParams, ["minutes"]).get("minutes") ?? "";
      const minutes = savePollMinutes(file, value);
      if (minutes === null) throw new InvalidRequest("Enter a whole number from 1 to 1440.");
      return json(response, 200, { minutes });
    }
    response.setHeader("Allow", "GET, PUT");
    return error(response, 405, "method_not_allowed", "Use GET or PUT for polling settings.");
  } catch (failure) {
    if (failure instanceof InvalidRequest) throw failure;
    return error(response, 503, "settings_unavailable", "Polling settings could not be accessed. Check the settings file and try again.");
  }
}

function serveWeb(root: string, path: string, response: ServerResponse) {
  if (path !== "/" && !/^\/assets\/[a-zA-Z0-9_-]+[.][a-z0-9]+$/.test(path)) return false;
  const file = path === "/" ? "index.html" : path.slice(1);
  const type = webTypes[extname(file)];
  const target = join(root, file);
  if (!type || !statSync(target, { throwIfNoEntry: false })?.isFile()) return false;
  const body = readFileSync(target);
  response.writeHead(200, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": path === "/" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  response.end(body);
  return true;
}

async function serve(args: string[]) {
  const [directory, requestedPort = "3031", webDirectory, ...extra] = args;
  if (!directory || extra.length) throw Error("Usage: node dashboard/prepare.ts --serve SNAPSHOT_DIRECTORY [PORT] [WEB_BUILD_DIRECTORY]");
  const port = natural(requestedPort, "Port");
  if (port > 65535) throw Error("Port must be at most 65535");
  const proxyHost = process.env.BARNACLES_PROXY_HOST;
  const proxyUser = process.env.BARNACLES_PROXY_USER;
  const pollSettings = process.env.BARNACLES_POLL_SETTINGS;
  if (Boolean(proxyHost) !== Boolean(proxyUser)) throw Error("Set both BARNACLES_PROXY_HOST and BARNACLES_PROXY_USER for Tailscale Serve.");
  if (!existsSync(join(directory, "review-policy.mjs"))) throw Error("Run dashboard/prepare.ts to build a review API snapshot first.");
  const webRoot = webDirectory ? resolve(webDirectory) : undefined;
  if (webRoot && !statSync(join(webRoot, "index.html"), { throwIfNoEntry: false })?.isFile()) {
    throw Error("Build the harbor frontend and pass its output directory.");
  }
  const review = await openShippingReview(resolve(directory));
  const server = createServer((request, response) => {
    const address = server.address();
    const localPort = typeof address === "object" && address ? address.port : port;
    const host = request.headers.host;
    if (host !== `127.0.0.1:${localPort}` && host !== `localhost:${localPort}` && !(proxyHost && host === proxyHost)) {
      return error(response, 403, "invalid_host", "Use the configured hostname for this API.");
    }
    if (proxyUser && request.headers["tailscale-user-login"] !== proxyUser) {
      return error(response, 403, "access_denied", "This dashboard requires an authorized Tailscale account.");
    }
    try {
      if (!request.url?.startsWith("/")) throw new InvalidRequest("Use a documented API path.");
      const url = new URL(`http://127.0.0.1${request.url}`);
      if (url.pathname === "/settings/polling" && pollSettings) {
        const origin = `${host === proxyHost ? "https" : "http"}://${host}`;
        return pollingSettings(pollSettings, url, request.method, request.headers.origin, origin, response);
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return error(response, 405, "method_not_allowed", "This API accepts GET requests.");
      }
      if (webRoot && serveWeb(webRoot, url.pathname, response)) return;
      if (url.pathname === "/api/v1") {
        queryParams(url.searchParams, []);
        return json(response, 200, {
          version: 1,
          pollingSettings: pollSettings ? "/settings/polling" : undefined,
          endpoints: {
            shipping: { path: "/api/v1/shipping", parameters: ["from", "to", "clock", "operation", "limit", "offset"] },
            pullRequest: { path: "/api/v1/pull-requests/{number}", parameters: ["asOf"] },
          },
          timeFormat: "UTC ISO 8601 (YYYY-MM-DD or timestamp ending in Z)",
        });
      }
      const pr = /^\/api\/v1\/pull-requests\/(\d+)$/.exec(url.pathname);
      let result;
      if (url.pathname === "/api/v1/shipping") {
        const params = queryParams(url.searchParams, ["from", "to", "clock", "operation", "limit", "offset"]);
        result = review.shipping({ from: utcTime(params.get("from")), to: utcTime(params.get("to")),
          clock: params.get("clock") ?? "Tool envelopes", operation: params.get("operation"),
          limit: natural(params.get("limit") ?? "25", "Limit"), offset: natural(params.get("offset") ?? "0", "Offset") });
      } else if (pr) {
        const params = queryParams(url.searchParams, ["asOf"]);
        result = review.pullRequest(natural(pr[1], "Pull request number"), utcTime(params.get("asOf")));
      } else {
        return error(response, 404, "not_found", "See /api/v1 for available endpoints.");
      }
      if (result.error) {
        return error(response, result.error === "pull_request_not_observed" ? 404 : 400, result.error, errors[result.error]);
      }
      return json(response, 200, result);
    } catch (failure) {
      if (failure instanceof InvalidRequest) return error(response, 400, "invalid_request", failure.message);
      return error(response, 503, "snapshot_unavailable", "The prepared evidence snapshot could not be read.");
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address && typeof address !== "string") {
    const origin = `http://127.0.0.1:${address.port}`;
    console.log(`Barnacles API ${origin}/api/v1`);
    if (webRoot) console.log(`Barnacles harbor ${origin}/`);
  }
}

const args = process.argv.slice(2);
const action = args[0] === "--serve" ? serve(args.slice(1)) : prepare(args);
action.catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
