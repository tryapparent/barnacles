import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { List, ProcessReceipt, ShellCommand, SourcePolicy, ToolInvocation } from "../../evidence/index.ts";
import { bendList as list } from "../wire.ts";

const require = createRequire(import.meta.url);
const maxText = 64 * 1024;
const nil = { $: "Nil" } as const;

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

function decode<T>(parser: Parser, text: unknown, project: (root: Node) => T): T | undefined {
  if (typeof text !== "string" || !text || text.length > maxText) return;
  const tree = parser.parse(text);
  try {
    return tree && !tree.rootNode.hasError ? project(tree.rootNode) : undefined;
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
  return bare.length <= 128 && /^[a-zA-Z0-9_/.+:@-]+$/.test(bare) ? bare : "";
}

export function rolloutArguments(input: unknown): Record<string, unknown> {
  if (typeof input !== "string" || input.length > maxText) return {};
  try {
    const value = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export const sessionHandle = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";

function literalFields(object: Node | null | undefined): Map<string, Node> {
  const result = new Map<string, Node>();
  if (object?.type !== "object") return result;
  for (const part of object.namedChildren) {
    if (part.type === "comment") continue;
    const key = part.childForFieldName("key");
    const value = part.childForFieldName("value");
    const name = key?.type === "property_identifier" ? key.text : javascriptLiteral(key);
    if (part.type !== "pair" || !name || !value || name === "__proto__" || result.has(name)) return new Map();
    result.set(name, value);
  }
  return result;
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

type ShellSyntax = { $: "OtherShell" }
  | { $: "ShellLiteral"; command: ShellCommand; nested_kinds: List<string> }
  | { $: "ShellBinary"; operators: List<string>; left: ShellSyntax; right: ShellSyntax };
type PrintedOutput = {
  $: "PrintedOutput"; statement: string; call: string; printer: string; args: number; optional: boolean;
};
type BindingSyntax = { $: "BindingSyntax"; declaration: string; count: number; kind: string; name: string };
type PollLoop = {
  $: "PollLoop"; kind: string; initial_kind: string; initial: string; ceiling_kind: string; ceiling: string;
  condition: string; increment: string; body: string; statements: number; branch: string;
  alternative: boolean; stop: string; consequence: string; actions: number; exit: string; exit_args: number;
  output_kind: string; output_name: string;
};
type ExactShell = { $: "ExactShell"; kind: string; command: ShellCommand; nested: List<string>; redirects: List<string> };

export type SyntaxPolicy = {
  printed_process(statements: number, output: PrintedOutput, binding: BindingSyntax, kind: string, name: string): boolean;
  poll_loop(loop: PollLoop, index: BindingSyntax, result: BindingSyntax, output: PrintedOutput): boolean;
  awaited_process(awaited: string, call: string, callee: string, arity: number, optional: boolean, fields: List<string>, poll: boolean): boolean;
  exact_shell(separators: List<string>, statements: List<ExactShell>): List<ShellCommand>;
  sequential_shell(statements: number, syntax: ShellSyntax): List<ShellCommand>;
};

function shellSyntax(node: Node | undefined): ShellSyntax {
  if (node?.type === "command") {
    return { $: "ShellLiteral", command: shellCommand(node), nested_kinds: list(Array.from(nodes(node), (part) => part.type)) };
  }
  if (node?.type === "list" && node.namedChildCount === 2) {
    const [left, right] = node.namedChildren;
    return { $: "ShellBinary", operators: list(node.children.filter((part) => !part.isNamed).map((part) => part.type)),
      left: shellSyntax(left), right: shellSyntax(right) };
  }
  return { $: "OtherShell" };
}

const named = (node?: Node | null) => node?.namedChildren.filter((part) => part.type !== "comment") ?? [];
const field = (node: Node | null | undefined, name: string) => node?.childForFieldName(name);
const kind = (node?: Node | null) => node?.type ?? "";
const source = (node?: Node | null) => node?.text ?? "";
const compact = (node?: Node | null) => source(node).replace(/\s/g, "");
const optional = (node?: Node | null) => named(node).some((part) => part.type === "optional_chain");

function binding(node?: Node | null) {
  const bindings = named(node);
  const name = field(bindings[0], "name");
  return {
    facts: { $: "BindingSyntax", declaration: kind(node), count: bindings.length, kind: kind(name), name: source(name) } as const,
    value: field(bindings[0], "value"),
  };
}

function printedOutput(statement?: Node) {
  const call = statement?.namedChild(0);
  const args = named(field(call, "arguments"));
  return {
    facts: { $: "PrintedOutput", statement: kind(statement), call: kind(call), printer: source(field(call, "function")),
      args: args.length, optional: optional(call) } as const,
    value: args[0],
  };
}

function unwrapParentheses(node: Node | null | undefined) {
  while (node?.type === "parenthesized_expression" && named(node).length === 1) node = named(node)[0];
  return node;
}

function commandCall(value: Node | null | undefined, policy: SyntaxPolicy, poll = false): Node | null {
  const awaited = unwrapParentheses(value);
  const call = named(awaited)[0];
  const args = named(field(call, "arguments"));
  const fields = literalFields(args[0]);
  const literals = Array.from(fields.values(), (node) =>
    named(node).some((child) => child.type === "template_substitution") ? "template_substitution" : node.type);
  return policy.awaited_process(kind(awaited), kind(call), source(field(call, "function")), args.length,
    optional(call), list(literals), poll) ? call : null;
}

function loopPoll(loop: Node, policy: SyntaxPolicy): Node | null {
  const index = binding(field(loop, "initializer"));
  const condition = field(loop, "condition");
  const ceiling = field(condition, "right");
  const body = field(loop, "body");
  const statements = named(body);
  const [declaration, branch] = statements;
  const result = binding(declaration);
  const consequence = field(branch, "consequence");
  const actions = named(consequence);
  const output = printedOutput(actions[0]);
  const facts: PollLoop = {
    $: "PollLoop", kind: kind(loop), initial_kind: kind(index.value), initial: source(index.value),
    ceiling_kind: kind(ceiling), ceiling: source(ceiling), condition: compact(condition), increment: compact(field(loop, "increment")),
    body: kind(body), statements: statements.length, branch: kind(branch), alternative: Boolean(field(branch, "alternative")),
    stop: compact(field(branch, "condition")), consequence: kind(consequence), actions: actions.length,
    exit: kind(actions[1]), exit_args: named(actions[1]).length, output_kind: kind(output.value), output_name: source(output.value),
  };
  return policy.poll_loop(facts, index.facts, result.facts, output.facts) ? commandCall(result.value, policy, true) : null;
}

function printedCall(root: Node, policy: SyntaxPolicy): Node | null {
  const statements = named(root);
  const bound = binding(statements[0]);
  const output = printedOutput(statements.at(-1));
  if (policy.printed_process(statements.length, output.facts, bound.facts, kind(output.value), source(output.value))) {
    return commandCall(statements.length === 2 ? bound.value : output.value, policy);
  }
  return statements.length === 1 && statements[0].type === "for_statement" ? loopPoll(statements[0], policy) : null;
}

function exactStatement(statement: Node): ExactShell {
  const command = statement.type === "redirected_statement" ? field(statement, "body") : statement;
  return {
    $: "ExactShell", kind: kind(command), command: command ? shellCommand(command) : { $: "Command", name: "", args: nil },
    nested: list(Array.from(nodes(statement), (node) => node.type)),
    redirects: list(named(statement).filter((part) => part.type === "file_redirect").map(source)),
  };
}

async function loadParsers() {
  await Parser.init();
  return Promise.all([
    parser("@repomix/tree-sitter-wasms/out/tree-sitter-javascript.wasm"),
    parser("tree-sitter-bash/tree-sitter-bash.wasm"),
  ] as const);
}

export async function rolloutSyntax(policy: SyntaxPolicy) {
  const [js, bash] = await (parsers ??= loadParsers());
  const shell = (input: unknown) => decode(bash, input, (root) =>
    list(Array.from(nodes(root)).flatMap((node) => node.type === "command" ? [shellCommand(node)] : []))) ?? nil;

  const exact = (input: unknown) => decode(bash, input, (root) => policy.exact_shell(
    list(root.children.filter((node) => !node.isNamed).map(kind)), list(named(root).map(exactStatement)),
  )) ?? nil;
  return {
    direct: shell,
    exact,
    sequential: (input: unknown): List<ShellCommand> => {
      const command = decode(js, input, (root) => {
        const call = printedCall(root, policy);
        return source(field(call, "function")) === "tools.exec_command" ? propertyCmd(named(field(call, "arguments"))[0]) : "";
      });
      return decode(bash, command, (root) => {
        const statements = named(root);
        return policy.sequential_shell(statements.length, shellSyntax(statements[0]));
      }) ?? nil;
    },
    wrapped: (input: unknown): List<ToolInvocation> => decode(js, input, (root) => {
      const invocations: ToolInvocation[] = [];
      const printed = printedCall(root, policy);
      for (const node of nodes(root)) {
        if (node.type !== "call_expression") continue;
        const callee = node.childForFieldName("function");
        const receiver = callee?.childForFieldName("object");
        if (receiver?.type !== "identifier") continue;
        const member = callee?.childForFieldName("property");
        const method = member?.type === "property_identifier" ? member.text
          : javascriptLiteral(callee?.childForFieldName("index"));
        const object = node.childForFieldName("arguments")?.namedChild(0);
        const cmd = propertyCmd(object);
        const fields = method === "write_stdin" ? literalFields(object) : new Map<string, Node>();
        const handle = fields.get("session_id");
        const chars = fields.get("chars");
        invocations.push({ $: "Invocation", receiver: receiver.text, method, commands: shell(cmd),
          printed: printed?.id === node.id, exact: method === "exec_command" ? exact(cmd) : nil,
          handle: handle?.type === "number" && /^[1-9]\d*$/.test(handle.text) ? sessionHandle(Number(handle.text)) : "",
          read_only: !chars || ((chars.text === '""' || chars.text === "''") && chars.type === "string") });
      }
      return list(invocations);
    }) ?? nil,
  };
}

const completedHeader = /^Script completed\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/;
const maxReceipt = 256 * 1024;
const missing = { $: "MissingReceipt" } as const;
const invalid = { $: "InvalidReceipt" } as const;

export function processReceipt(output: unknown, direct: boolean, policy: SourcePolicy): ProcessReceipt {
  const blocks = Array.isArray(output) ? output : [];
  const wrapped = blocks[0]?.type === "input_text" && completedHeader.test(blocks[0].text);
  const encoded = wrapped && blocks.length === 2 && blocks[1]?.type === "input_text" ? blocks[1].text
    : direct && blocks.length === 1 && blocks[0]?.type === "input_text" ? blocks[0].text
    : direct && typeof output === "string" ? output : null;
  if (typeof encoded !== "string" || !encoded.startsWith("{")) return wrapped ? invalid : missing;
  if (encoded.length > maxReceipt) return invalid;
  try {
    const result = JSON.parse(encoded);
    if (typeof result.chunk_id !== "string" || !result.chunk_id || result.chunk_id.length > 128 ||
        typeof result.output !== "string" || !Number.isSafeInteger(result.original_token_count) ||
        result.original_token_count < 0 || !Number.isFinite(result.wall_time_seconds)) return invalid;
    const code = Number.isInteger(result.exit_code) && result.exit_code >= 0 && result.exit_code <= 255
      ? result.exit_code : 256;
    return policy.process_receipt(sessionHandle(result.session_id), Object.hasOwn(result, "session_id"), code,
      Object.hasOwn(result, "exit_code"), result.wall_time_seconds);
  } catch {
    return invalid;
  }
}
