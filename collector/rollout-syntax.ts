import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { List, ShellCommand, ToolInvocation } from "../evidence/index.ts";

const require = createRequire(import.meta.url);
const maxText = 64 * 1024;
const nil = { $: "Nil" } as const;
const list = <T>(items: T[]): List<T> =>
  items.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), nil);

async function parser(module: string) {
  const language = await Language.load(require.resolve(module));
  const instance = new Parser();
  instance.setLanguage(language);
  return instance;
}

let parsers: Promise<[Parser, Parser]> | undefined;

function* nodes(root: Node): Generator<Node> {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    yield node;
    for (const child of node.namedChildren.reverse()) pending.push(child);
  }
}

function decode<T>(parser: Parser, text: unknown, project: (root: Node) => T[]): List<T> {
  if (typeof text !== "string" || !text || text.length > maxText) return nil;
  const tree = parser.parse(text);
  try {
    return tree && !tree.rootNode.hasError ? list(project(tree.rootNode)) : nil;
  } finally { tree?.delete(); }
}

function javascriptLiteral(node: Node | null | undefined): string {
  if (!node || !["string", "template_string"].includes(node.type) ||
      node.namedChildren.some((child) => child.type === "template_substitution")) return "";
  const raw = node.text;
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch {}
  }
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v",
    "\\": "\\", "'": "'", '"': '"', "`": "`", $: "$", "\n": "", "\r\n": "", "\r": "" };
  let supported = true;
  const value = raw.slice(1, -1).replace(/\\(\r\n|[\s\S])/g, (_, token: string) => {
    if (Object.hasOwn(escapes, token)) return escapes[token];
    supported = false;
    return "";
  });
  return supported ? value : "";
}

function shellWord(node: Node | null): string {
  if (!node) return "";
  const text = node.text;
  const assignment = /^[A-Za-z_][A-Za-z_0-9]*=/.exec(text);
  if (assignment) return assignment[0];
  const bare = node.type === "raw_string" || node.type === "string" ? text.slice(1, -1) : text;
  return /^[a-zA-Z0-9_/.+:@-]+$/.test(bare) ? bare : "";
}

function argumentCmd(input: unknown): unknown {
  if (typeof input !== "string" || input.length > maxText) return null;
  try { return JSON.parse(input)?.cmd; } catch { return null; }
}

function propertyCmd(object: Node | null | undefined): string {
  if (object?.type !== "object") return "";
  const properties = object.namedChildren;
  if (properties.some((part) => part.type === "spread_element" ||
      part.childForFieldName("key")?.type === "computed_property_name")) return "";
  const matches = properties.filter((part) => part.type === "pair" &&
    /^(?:cmd|"cmd"|'cmd')$/.test(part.childForFieldName("key")?.text ?? ""));
  return matches.length === 1 ? javascriptLiteral(matches[0].childForFieldName("value")) : "";
}

function shellCommand(node: Node): ShellCommand {
  return { $: "Command",
    name: shellWord(node.childForFieldName("name")?.namedChild(0) ?? null),
    args: list(node.childrenForFieldName("argument").map(shellWord)) };
}

function andSeries(node: Node): Node[] {
  if (node.type === "command") {
    return Array.from(nodes(node)).some((part) => ["command_substitution", "process_substitution"].includes(part.type))
      ? [] : [node];
  }
  if (node.type !== "list" || node.children.some((part) => !part.isNamed && part.type !== "&&")) return [];
  const parts = node.namedChildren.map(andSeries);
  return parts.length === 2 && parts.every((part) => part.length) ? parts.flat() : [];
}

function printedCommand(root: Node): string {
  const statements = root.namedChildren.filter((node) => node.type !== "comment");
  const print = statements.at(-1)?.namedChild(0);
  const printArgs = print?.childForFieldName("arguments");
  if (statements.at(-1)?.type !== "expression_statement" ||
      print?.childForFieldName("function")?.text !== "text" || printArgs?.namedChildCount !== 1) return "";
  const arg = printArgs.namedChild(0);
  let awaited = arg;
  if (statements.length === 2) {
    const declaration = statements[0];
    const binding = declaration.namedChild(0);
    const name = binding?.childForFieldName("name");
    if (declaration.type !== "lexical_declaration" || declaration.namedChildCount !== 1 ||
        name?.type !== "identifier" || arg?.type !== "identifier" || name.text !== arg.text) return "";
    awaited = binding?.childForFieldName("value") ?? null;
  } else if (statements.length !== 1) return "";
  const call = awaited?.namedChild(0);
  const args = call?.childForFieldName("arguments");
  if (awaited?.type !== "await_expression" || call?.childForFieldName("function")?.text !== "tools.exec_command") return "";
  return args?.namedChildCount === 1 ? propertyCmd(args.namedChild(0)) : "";
}

async function loadParsers() {
  await Parser.init();
  return Promise.all([
    parser("@repomix/tree-sitter-wasms/out/tree-sitter-javascript.wasm"),
    parser("tree-sitter-bash/tree-sitter-bash.wasm"),
  ] as const);
}

export async function rolloutSyntax() {
  const [js, bash] = await (parsers ??= loadParsers());
  const shell = (input: unknown) => decode<ShellCommand>(bash, input, (root) =>
    Array.from(nodes(root)).flatMap((node) => node.type === "command" ? [shellCommand(node)] : []));

  return {
    direct: (input: unknown) => shell(argumentCmd(input)),
    sequential: (input: unknown): List<ShellCommand> => {
      const decoded = decode<string>(js, input, (root) => [printedCommand(root)]);
      return decode<ShellCommand>(bash, decoded.$ === "Con" ? decoded.head : "", (root) => {
        const statements = root.namedChildren.filter((node) => node.type !== "comment");
        return statements.length === 1 ? andSeries(statements[0]).map(shellCommand) : [];
      });
    },
    wrapped: (input: unknown) => decode<ToolInvocation>(js, input, (root) => {
      const invocations: ToolInvocation[] = [];
      for (const node of nodes(root)) {
        if (node.type !== "call_expression") continue;
        const callee = node.childForFieldName("function");
        const receiver = callee?.childForFieldName("object");
        if (receiver?.type !== "identifier") continue;
        const member = callee?.childForFieldName("property");
        const method = member?.type === "property_identifier" ? member.text
          : javascriptLiteral(callee?.childForFieldName("index"));
        invocations.push({ $: "Invocation", receiver: receiver.text, method,
          commands: shell(propertyCmd(node.childForFieldName("arguments")?.namedChild(0))) });
      }
      return invocations;
    }),
  };
}
