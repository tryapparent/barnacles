import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const namespace = process.env.PLOW_SESSION_NAMESPACE_ID;

if (process.argv[2] === "--publish-feed") {
  const [path, ...extra] = process.argv.slice(3);
  const credential = process.env.PLOW_KV_TOKEN_FILE;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !namespace ||
      !/^[a-f0-9]{32}$/.test(namespace) || !credential || !path || extra.length) {
    throw Error("Set the Plow account, KV namespace and token file, then pass a projected feed file.");
  }
  const payload = await readFile(path);
  if (!payload.length || payload.length > 128 * 1024) throw Error("Invalid Plow session feed size.");
  const token = (await readFile(credential, "utf8")).trim();
  if (!token) throw Error("The Plow KV credential file is empty.");
  const key = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/session-timeline-v1`;
  const authorization = { Authorization: `Bearer ${token}` };
  const current = await fetch(key, { headers: authorization, signal: AbortSignal.timeout(30_000) });
  if (current.ok) {
    if (payload.equals(Buffer.from(await current.arrayBuffer()))) {
      console.log("The Plow session feed is current.");
      process.exit(0);
    }
  } else if (current.status !== 404) {
    throw Error(`Reading the Plow session feed failed with HTTP ${current.status}.`);
  }
  const response = await fetch(key, {
    method: "PUT", body: payload, headers: { ...authorization, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as { success: boolean };
  if (!response.ok || !result.success) throw Error(`Publishing the Plow session feed failed with HTTP ${response.status}.`);
  console.log("Published the Plow session feed.");
  process.exit(0);
}

const token = process.env.PLOW_WORKER_TOKEN;
const audience = process.env.PLOW_ACCESS_AUDIENCE;
const sha = process.env.GITHUB_SHA;
const workerPath = process.argv[2];
if (!account || !/^[a-f0-9]{32}$/.test(account) || !token || !audience ||
    !/^[a-f0-9]{64}$/.test(audience) || !namespace || !/^[a-f0-9]{32}$/.test(namespace) || !sha || !/^[a-f0-9]{40}$/.test(sha) || !workerPath) {
  throw new Error("Missing Plow deployment configuration.");
}

const worker = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/plow-private-preview`;
const deployedUrl = "https://plow.tryapparent.com/app";

async function cloudflare<T>(endpoint: string, body?: FormData | object): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body && !(body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(worker + endpoint, {
    method: body ? "POST" : "GET",
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40_000),
  });
  const payload = await response.json() as { success: boolean; result: T; errors?: { code: number }[] };
  if (!response.ok || !payload.success) {
    throw new Error(`Cloudflare ${endpoint} failed with HTTP ${response.status} (codes ${payload.errors?.map(error => error.code).join(",") ?? "none"}).`);
  }
  return payload.result;
}

function latestMain(): boolean {
  const head = execFileSync("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], {
    encoding: "utf8", timeout: 30_000,
  }).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Could not resolve the current main commit.");
  if (sha === head) return true;
  console.log(`Skipping ${sha} because main is now ${head}.`);
  return false;
}

async function verifyIngress() {
  const subdomain = await cloudflare<{ enabled: boolean; previews_enabled: boolean }>("/subdomain");
  if (subdomain.enabled !== false || subdomain.previews_enabled !== false) {
    throw new Error("Expected both Cloudflare Worker alternate URLs to be disabled.");
  }
  for (const path of ["", "/"]) {
    const response = await fetch(deployedUrl + path, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const redirect = new URL(response.headers.get("Location") ?? deployedUrl);
    if (response.status !== 302 || redirect.origin !== "https://tryapparent.cloudflareaccess.com" ||
        redirect.pathname !== "/cdn-cgi/access/login/plow.tryapparent.com") {
      throw new Error(`Expected signed-out Plow route /app${path} to redirect to Cloudflare Access.`);
    }
  }
}

type Deployment = { id: string; versions: { version_id: string; percentage: number }[] };

async function activeVersion(): Promise<Deployment> {
  const { deployments } = await cloudflare<{ deployments: Deployment[] }>("/deployments");
  const current = deployments[0];
  if (current?.versions.length !== 1 || current.versions[0].percentage !== 100) {
    throw new Error("Expected a single active Plow Worker version.");
  }
  return current;
}

function activate(id: string) {
  return cloudflare<Deployment>("/deployments", {
    strategy: "percentage",
    versions: [{ version_id: id, percentage: 100 }],
  });
}

if (!latestMain()) process.exit(0);
await verifyIngress();
const prior = await activeVersion();
const bundle = new FormData();
bundle.set("metadata", new Blob([JSON.stringify({
  main_module: "worker.mjs",
  compatibility_date: "2026-11-27",
  bindings: [
    { type: "plain_text", name: "PLOW_ACCESS_AUDIENCE", text: audience },
    { type: "kv_namespace", name: "PLOW_SESSION_FEED", namespace_id: namespace },
  ],
  annotations: { "workers/tag": sha, "workers/message": `Barnacles main ${sha}` },
})], { type: "application/json" }));
bundle.set("worker.mjs", new Blob([await readFile(workerPath)], {
  type: "application/javascript+module",
}), "worker.mjs");
const { id: version } = await cloudflare<{ id: string }>("/versions", bundle);
if (!latestMain()) process.exit(0);

const deployment = await activate(version);
try {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if ((await activeVersion()).versions[0].version_id !== version) throw new Error("Version not active yet.");
      await verifyIngress();
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await setTimeout(3000);
    }
  }
} catch (error) {
  if ((await activeVersion()).versions[0].version_id === version) {
    await activate(prior.versions[0].version_id);
    console.error(`Restored prior Worker version ${prior.versions[0].version_id}.`);
  }
  throw error;
}

const result = `Plow deployed ${sha} as Cloudflare Worker version ${version} (deployment ${deployment.id}).`;
console.log(result);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, result + "\n");
