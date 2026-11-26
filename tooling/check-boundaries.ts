import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { buildPolicy, loadPolicy } from "./bend.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
type BendList = { $: "Nil" } | { $: "Con"; head: string; tail: BendList };
type Suites = { $: "Invalid" } | { $: "Selected"; directories: BendList };
type VerificationPolicy = {
  owner_directories(): BendList;
  owner_grammar(extension: string): string;
  allowed_import(owner: string, path: string, callee: string, expression: string, value: string,
    target: string, targetOwner: string): boolean;
  select_suites(scopes: BendList): Suites;
  is_test(path: string): boolean;
};

function fromBend(list: BendList): string[] {
  const values: string[] = [];
  for (let node = list; node.$ === "Con"; node = node.tail) values.push(node.head);
  return values;
}

export async function loadVerification(directory: string) {
  const output = await buildPolicy(directory, new URL("./verification.bend", import.meta.url), "verification.mjs");
  return loadPolicy<VerificationPolicy>(output);
}

export function suiteDirectories(policy: VerificationPolicy, scopes: string[]): string[] {
  const input = scopes.reduceRight<BendList>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
  const result = policy.select_suites(input);
  if (result.$ === "Invalid") {
    throw Error("Usage: npm run verify -- [hooks] [collector] [evidence] [dashboard]");
  }
  return fromBend(result.directories);
}

export async function checkBoundaries(policy: VerificationPolicy): Promise<boolean> {
  await Parser.init();
  const parsers = new Map<string, Parser>();
  let passed = true;
  try {
    for (const owner of fromBend(policy.owner_directories())) {
      for (const file of readdirSync(join(root, owner), { recursive: true })) {
        const extension = extname(file);
        const grammar = policy.owner_grammar(extension);
        if (!grammar) continue;
        const path = posix.join(owner, file);
        const source = readFileSync(join(root, path), "utf8");
        if (!parsers.has(grammar)) {
          const language = await Language.load(join(root, "node_modules", "@repomix", "tree-sitter-wasms",
            "out", `tree-sitter-${grammar}.wasm`));
          const parser = new Parser();
          parser.setLanguage(language);
          parsers.set(grammar, parser);
        }
        const tree = parsers.get(grammar)!.parse(source);
        if (!tree) throw Error(`Unable to parse ${path}`);
        try {
          if (tree.rootNode.hasError) throw Error(`Unable to parse ${path}`);
          const pending = [tree.rootNode];
          while (pending.length) {
            const node = pending.pop()!;
            pending.push(...node.namedChildren);
            const callee = node.childForFieldName("function")?.text;
            const isLoad = node.type === "call_expression" && (callee === "import" || callee === "require");
            const specifier = isLoad ? node.childForFieldName("arguments")?.namedChildren[0] : node.childForFieldName("source");
            if (!specifier && !isLoad) continue;
            const value = specifier?.type === "string" ? specifier.text.slice(1, -1) : "";
            const target = posix.join(dirname(path), value);
            if (policy.allowed_import(owner, path, isLoad ? callee : "", specifier?.text ?? "",
                value, target, target.split("/")[0])) continue;
            console.error(`${path}:${node.startPosition.row + 1} cannot import ${specifier?.text ?? "an unknown module"}. Use the owner's public entry point.`);
            passed = false;
          }
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    for (const parser of parsers.values()) parser.delete();
  }
  return passed;
}

if (import.meta.main) {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  const job = mkdtempSync(parent ? join(parent, "boundaries-") : "/tmp/apparent-dev-barnacles-boundaries-");
  try {
    if (!await checkBoundaries(await loadVerification(job))) process.exitCode = 1;
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}
