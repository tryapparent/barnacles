import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const revision = "9c586f094f4fc88bef440dc8b4d77a2f92c257cc";
const sources = {
  "main.ts": "a9caec19d6d42a3c6314766170db05fd47bbbc5fcc71207c9aadbbaad51d83ec",
  "bend.ts": "24e424ae6a540bd8930a26b8e87a270d2be7c16835a3dbf85adc43348b0ce6e6",
  "comp.ts": "d5e46919252986ff1469c2c8e462bb1c8bb6daa339f0d76e38b9d7efa105ed00",
  "safe.ts": "8f5d72dd6fe5adb612e5276d15d7648a98d113d8df343b675721399d23a2b36c",
  "base.bend": "9a457145eacff52a36340cf86400b64b94b6eccc124c8ef3cf48bba4eab29af0",
};

const packages = {
  "0x419ec39802735c4664960ab4b9d962e5/json.bend": "27d3cb8d4c6c2350ae8670a3fc262af20272319fd7f24f247a1f61631768a1ab",
  "0xec25e4adfb02e59e4b817801115988ee/bytes.bend": "ce62e5f2003c66bec5ae54419db2b21a54acf494dd2bc7cc2e34ab56bab83061",
  "0x5eb40ff91b54d04ca8d44189421891b9/f64.bend": "837cf882098ade1738112fb67ffff58b2e47ed0afc2b7e0178773195e5d29d41",
  "0x5eb40ff91b54d04ca8d44189421891b9/powers.bend": "8ba0e5d43f827fa75bc5404ab30c94624c7b43a18c7d14e12e54b3bf26fd5150",
  "0x4eed9d7ac6ece61523d747a9d804e4f0/int.bend": "5588aa776b7883a661b30489bccc7f2bf54ee0e333d363eaa33804cb1b130fcf",
  "0x419ec39802735c4664960ab4b9d962e5/LICENSE": "038e579fddcfc27fd7781bc7e9a951dff18e484b19e5f971906f83bcf2d9cbf1",
  "0xec25e4adfb02e59e4b817801115988ee/LICENSE": "038e579fddcfc27fd7781bc7e9a951dff18e484b19e5f971906f83bcf2d9cbf1",
  "0x5eb40ff91b54d04ca8d44189421891b9/LICENSE": "038e579fddcfc27fd7781bc7e9a951dff18e484b19e5f971906f83bcf2d9cbf1",
  "0x29d6f1ff259add9ea6c8f213fda12377/sha256.bend": "1d51d0190deb48387a2d8db4b194b168d2dd6ad00010f7ee7cecdc9e822ecbe3",
  "0x29d6f1ff259add9ea6c8f213fda12377/LICENSE": "bc0963cd8a60774899a442414e13820735505e44fa571df529356d5e27e17f8d",
};
const packageNames = {
  "bend-kit-bytes@0.3.3.1": "0xec25e4adfb02e59e4b817801115988ee",
  "bend-kit-f64@0.1.4.0": "0x5eb40ff91b54d04ca8d44189421891b9",
};
const inputs = [
  ...Object.entries(sources).map(([file, digest]) => ({
    file, digest, url: `https://raw.githubusercontent.com/bendlang/bend/${revision}/bend2/${file}`,
  })),
  ...Object.entries(packages).map(([entry, digest]) => ({
    file: `bend-lib/${entry}`, digest, url: `https://hub.bend-lang.org/${entry}`,
  })),
];
const bundleKey = createHash("sha256").update(JSON.stringify({ inputs, packageNames })).digest("hex");

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function installedCompiler() {
  return join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "barnacles-bend", bundleKey);
}

function verifiedSource(file: string, digest: string, bytes: Buffer) {
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw Error(`Bend2 integrity check failed for ${file}`);
  }
  return { file, bytes };
}

function readCompiler(directory: string) {
  return inputs.map(({ file, digest }) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(directory, file));
    } catch (error) {
      throw Error(`Cannot read pinned Bend2 compiler file ${file}. Run npm run hooks:install to provision the compiler.`, { cause: error });
    }
    return verifiedSource(file, digest, bytes);
  });
}

async function downloadCompiler() {
  return Promise.all(inputs.map(async ({ file, digest, url }) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) throw Error(`Bend2 download failed for ${file} (HTTP ${response.status})`);
    return verifiedSource(file, digest, Buffer.from(await response.arrayBuffer()));
  }));
}

function writeCompiler(directory: string, bundle: ReturnType<typeof readCompiler>) {
  for (const { file, bytes } of bundle) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
}

function configuredCompiler() {
  if (process.env.BARNACLES_BEND_BUNDLE) return resolve(process.env.BARNACLES_BEND_BUNDLE);
  try {
    const directory = installedCompiler();
    if (existsSync(directory)) return directory;
  } catch {}
}

export function hookCompilerDirectory() {
  return process.env.BARNACLES_BEND_BUNDLE ? resolve(process.env.BARNACLES_BEND_BUNDLE) : installedCompiler();
}

export async function prepareCompiler(scratch: string): Promise<string> {
  const configured = configuredCompiler();
  if (configured) {
    readCompiler(configured);
    return configured;
  }
  const directory = join(scratch, "compiler");
  const bundle = await downloadCompiler();
  mkdirSync(directory, { mode: 0o700 });
  writeCompiler(directory, bundle);
  return directory;
}

async function installHooks() {
  const directory = installedCompiler();
  let installed = false;
  try {
    readCompiler(directory);
    installed = true;
  } catch {}
  if (!installed) {
    const bundle = process.env.BARNACLES_BEND_BUNDLE
      ? readCompiler(resolve(process.env.BARNACLES_BEND_BUNDLE)) : await downloadCompiler();
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(dirname(directory), "install-"));
    try {
      writeCompiler(staging, bundle);
      try {
        renameSync(staging, directory);
      } catch (error) {
        const { code } = error as { code?: string };
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        for (const { file } of bundle) {
          const path = join(directory, file);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          renameSync(join(staging, file), path);
        }
      }
      readCompiler(directory);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  git("config", "--local", "extensions.worktreeConfig", "true");
  git("config", "--worktree", "core.hooksPath", ".githooks");
}

export async function buildPolicy(directory: string, source: URL, filename: string): Promise<string> {
  const [output] = await buildPolicies(directory, [[source, filename]]);
  return output;
}

export async function buildPolicies(directory: string, policies: ReadonlyArray<readonly [URL, string]>,
  bundle = configuredCompiler()) {
  const scratch = mkdtempSync(join(directory, "bend-"));
  try {
    writeCompiler(scratch, bundle ? readCompiler(bundle) : await downloadCompiler());
    const names = join(scratch, "bend-lib", "names");
    mkdirSync(names, { recursive: true, mode: 0o700 });
    for (const [name, hash] of Object.entries(packageNames)) writeFileSync(join(names, name), hash, { flag: "wx", mode: 0o600 });
    const compile = `
      import { load } from "./main.ts";
      import { pathToFileURL } from "node:url";
      import { writeFileSync } from "node:fs";
      const [input, output] = process.argv.slice(1);
      const { source } = await load(pathToFileURL(input).href, null, () => {
        throw new Error("Expected local Bend source");
      });
      writeFileSync(output, source);
    `;
    return policies.map(([source, filename]) => {
      const output = resolve(directory, filename);
      execFileSync(process.execPath, [
        "--stack-size=4096", "--experimental-transform-types", "--input-type=module", "-e", compile, fileURLToPath(source), output,
      ], {
        cwd: scratch,
        timeout: 60_000,
        stdio: "inherit",
        env: {
          ...process.env,
          TMPDIR: scratch,
          BEND_NO_TELEMETRY: "1",
          BEND_LIB: join(scratch, "bend-lib"),
          BEND_HUB: "http://127.0.0.1:1",
          BENDTT: "",
        },
      });
      return output;
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function loadPolicy<T>(path: string): Promise<T> {
  return (await import(pathToFileURL(path).href)).default;
}

export async function withHookPolicy<T>(source: URL, action: (policy: T) => void | Promise<void>) {
  const scratch = mkdtempSync("/tmp/apparent-dev-barnacles-hook-");
  try {
    const [output] = await buildPolicies(scratch, [[source, "hook.mjs"]], hookCompilerDirectory());
    await action(await loadPolicy<T>(output));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== "--install-hooks") throw Error("Expected --install-hooks");
  await installHooks();
}
