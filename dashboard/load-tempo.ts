import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

function localUrl(address: string, path: string, service: string) {
  if (address !== service && !/^127\.0\.0\.1:[0-9]{1,5}$/.test(address)) throw Error("Expected a local Tempo endpoint");
  return new URL(path, `http://${address}`);
}

async function main() {
  const [file, query, ingest, ...extra] = process.argv.slice(2);
  if (!file || !query || !ingest || extra.length) throw Error("Usage: load-tempo.ts OTLP_NDJSON QUERY_ADDRESS INGEST_ADDRESS");
  const ready = localUrl(query, "/ready", "tempo:3200");
  const endpoint = localUrl(ingest, "/v1/traces", "tempo:4318");
  const deadline = Date.now() + 45_000;
  for (;;) {
    const response = await fetch(ready, { signal: AbortSignal.timeout(2000), redirect: "error" }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) break;
    if (Date.now() >= deadline) throw Error("Local Tempo did not become ready within 45 seconds");
    await setTimeout(500);
  }
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const body of input) {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body, signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error(`Local Tempo rejected trace ${count + 1} (HTTP ${response.status})`);
      }
      const receipt = await response.json();
      if (Number(receipt.partialSuccess?.rejectedSpans ?? 0)) throw Error(`Local Tempo partially rejected trace ${count + 1}`);
      count++;
    }
  } finally { input.close(); }
  console.log(`Loaded ${count} traces into local Tempo`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
