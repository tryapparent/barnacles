import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

const root = fileURLToPath(new URL("../", import.meta.url));
const owners = ["collector", "evidence", "dashboard", "tooling"] as const;
const permissions: Record<string, ReadonlySet<string>> = {
  collector: new Set(["evidence/index.ts", "tooling/bend.ts"]),
  dashboard: new Set(["evidence/index.ts"]),
  evidence: new Set(["tooling/bend.ts"]),
  tooling: new Set(),
};

await Parser.init();
const parsers = new Map<string, Parser>();
let violations = 0;
try {
  for (const owner of owners) {
    for (const file of readdirSync(join(root, owner), { recursive: true })) {
      const extension = extname(file);
      const grammar = [".ts", ".mts", ".cts"].includes(extension) ? "typescript"
        : [".js", ".mjs", ".cjs", ".jsx"].includes(extension) ? "javascript"
        : extension === ".tsx" ? "tsx" : "";
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
          if (path === "tooling/bend.ts" && isLoad && callee === "import" && specifier?.text === "pathToFileURL(path).href") {
            continue;
          }
          const value = specifier?.type === "string" ? specifier.text.slice(1, -1) : "";
          const target = value.startsWith(".") ? posix.normalize(posix.join(dirname(path), value)) : "";
          if (value && !value.includes("\\") && !value.startsWith("/") && !value.startsWith("#") && !value.startsWith("file:") &&
              !/^barnacles(?:\/|$)/.test(value) &&
              (!target || target.split("/")[0] === owner || permissions[owner].has(target))) continue;
          console.error(`${path}:${node.startPosition.row + 1} cannot import ${specifier?.text ?? "an unknown module"}. Use the owner's public entry point.`);
          violations++;
        }
      } finally {
        tree.delete();
      }
    }
  }
} finally {
  for (const parser of parsers.values()) parser.delete();
}
process.exitCode = violations ? 1 : 0;
