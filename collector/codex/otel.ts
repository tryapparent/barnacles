import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { CodexOtelConflict, codexOtelPolicy, saveCodexOtel, type CodexOtelFact, type CodexOtelPolicy } from "../../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { array, row, str, token } from "../wire.ts";

const bodyLimit = 8 * 1024 * 1024;

function arrayField(value: unknown) {
  return value === undefined ? [] : array(value, 4096);
}

function decodeAttributes(value: unknown) {
  const attributes = new Map<string, string>();
  for (const entry of arrayField(value)) {
    const { key, value } = row(entry);
    attributes.set(str(key), str(row(value).stringValue));
  }
  return (key: string) => attributes.get(key) ?? "";
}

function statusCode(value: unknown) {
  const code = value === undefined ? undefined : row(value).code;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 0xffffffff ? code : 0;
}

function decodeSpans(value: unknown, policy: CodexOtelPolicy) {
  const facts: CodexOtelFact[] = [];
  for (const resource of arrayField(row(value).resourceSpans)) {
    for (const scope of arrayField(row(resource).scopeSpans)) {
      for (const input of arrayField(row(scope).spans)) {
        const span = row(input);
        const attribute = decodeAttributes(span.attributes);
        const result = policy.observe_span(str(span.traceId), str(span.spanId), str(span.parentSpanId), str(span.name),
          str(span.startTimeUnixNano), str(span.endTimeUnixNano), attribute("conversation.id"), attribute("turn.id"),
          attribute("call_id"), statusCode(span.status));
        if (result.$ === "InvalidSpan") throw Error("Invalid trace span");
        if (result.$ !== "ObservedSpan") continue;
        const events: CodexOtelFact["events"] = [];
        for (const input of arrayField(span.events)) {
          const event = row(input);
          const attribute = decodeAttributes(event.attributes);
          const outcome = policy.observe_event(str(event.name), str(event.timeUnixNano), attribute("conversation.id"),
            attribute("turn.id"), attribute("call_id"), attribute("duration_ms"), attribute("success"));
          if (outcome.$ === "InvalidEvent") throw Error("Invalid trace event");
          if (outcome.$ === "ObservedEvent") events.push(outcome.fact);
        }
        facts.push({ span: result.fact, events });
      }
    }
  }
  return facts;
}

async function readBody(request: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= bodyLimit) chunks.push(chunk);
  }
  return bytes <= bodyLimit ? Buffer.concat(chunks, bytes) : null;
}

function verifyBearer(received: string | undefined, expected: Buffer) {
  const header = Buffer.from(received ?? "");
  return header.length === expected.length && timingSafeEqual(header, expected);
}

async function serve() {
  const [job, instance, ...extra] = process.argv.slice(2);
  const port = Number(process.env.PLOW_OTLP_EVIDENCE_PORT ?? "4320");
  const secret = process.env.PLOW_OTLP_EVIDENCE_TOKEN ?? "";
  if (!job || !instance || extra.length || !Number.isInteger(port) || port < 0 || port > 65535 || secret.length < 32) {
    throw Error("Usage: PLOW_OTLP_EVIDENCE_TOKEN=<private secret of at least 32 characters> node collector/codex/otel.ts JOB_DIRECTORY INSTANCE");
  }
  const scope = token(instance);
  const directory = resolve(job);
  const database = join(directory, "evidence.sqlite");
  const scratch = mkdtempSync(join(directory, "codex-otel-"));
  let policy: CodexOtelPolicy;
  try {
    policy = await loadPolicy(await buildPolicy(scratch, codexOtelPolicy, "codex-otel.mjs"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const bearer = Buffer.from(`Bearer ${secret}`);
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/traces") return response.writeHead(404).end();
    if (!verifyBearer(request.headers.authorization, bearer)) return response.writeHead(401).end();
    if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"]) {
      return response.writeHead(415).end();
    }
    if (Number(request.headers["content-length"]) > bodyLimit) return response.writeHead(413).end();
    let facts: CodexOtelFact[];
    try {
      const body = await readBody(request);
      if (!body) return response.writeHead(413).end();
      facts = decodeSpans(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)), policy);
    } catch {
      return response.writeHead(400).end();
    }
    try {
      if (facts.length) saveCodexOtel(database, scope, facts, policy);
    } catch (error) {
      if (error instanceof CodexOtelConflict) return response.writeHead(409).end();
      console.error("Codex OTLP evidence write failed");
      return response.writeHead(503).end();
    }
    return response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") console.log(`Codex OTLP evidence ready on 127.0.0.1:${address.port}`);
  });
}

if (import.meta.main) await serve();
