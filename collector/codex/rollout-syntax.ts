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
type PrintedScript = {
  $: "PrintedScript"; statements: number; last_kind: string; printer: string; print_args: number;
  declaration_kind: string; bindings: number; binding_kind: string; argument_kind: string;
  binding_name: string; argument_name: string; awaited_kind: string; callee: string; call_args: number;
};
export type SyntaxPolicy = {
  printed_execution(script: PrintedScript): boolean;
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

function printedCommand(root: Node, policy: SyntaxPolicy): string {
  const statements = root.namedChildren.filter((node) => node.type !== "comment");
  const last = statements.at(-1);
  const print = last?.namedChild(0);
  const printArgs = print?.childForFieldName("arguments");
  const arg = printArgs?.namedChild(0);
  const declaration = statements[0];
  const binding = declaration?.namedChild(0);
  const name = binding?.childForFieldName("name");
  const awaited = statements.length === 2 ? binding?.childForFieldName("value") : arg;
  const call = awaited?.namedChild(0);
  const args = call?.childForFieldName("arguments");
  const facts: PrintedScript = {
    $: "PrintedScript", statements: statements.length, last_kind: last?.type ?? "",
    printer: print?.childForFieldName("function")?.text ?? "", print_args: printArgs?.namedChildCount ?? 0,
    declaration_kind: declaration?.type ?? "", bindings: declaration?.namedChildCount ?? 0,
    binding_kind: name?.type ?? "", argument_kind: arg?.type ?? "",
    binding_name: name?.text ?? "", argument_name: arg?.type === "identifier" ? arg.text : "",
    awaited_kind: awaited?.type ?? "", callee: call?.childForFieldName("function")?.text ?? "",
    call_args: args?.namedChildCount ?? 0,
  };
  return policy.printed_execution(facts) ? propertyCmd(args?.namedChild(0)) : "";
}

const named = (node?: Node | null) => node?.namedChildren.filter((part) => part.type !== "comment") ?? [];
const field = (node: Node | null | undefined, name: string) => node?.childForFieldName(name);
const expression = (node?: Node | null) => node?.type === "expression_statement" ? node.namedChild(0) : null;

function binding(node?: Node | null): { name: string; value: Node } | undefined {
  if (node?.type !== "lexical_declaration" || named(node).length !== 1) return;
  const declaration = named(node)[0];
  const name = field(declaration, "name");
  const value = field(declaration, "value");
  if (name?.type === "identifier" && value) return { name: name.text, value };
}

function printedArgument(statement?: Node) {
  const call = expression(statement);
  const args = field(call, "arguments");
  if (call?.type === "call_expression" && field(call, "function")?.text === "text" &&
      !named(call).some((node) => node.type === "optional_chain") && named(args).length === 1) return named(args)[0];
}

function commandCall(awaited: Node | null | undefined): Node | null {
  while (awaited?.type === "parenthesized_expression" && named(awaited).length === 1) awaited = named(awaited)[0];
  const call = named(awaited)[0];
  const args = field(call, "arguments");
  if (awaited?.type !== "await_expression" || call?.type !== "call_expression" ||
      !["tools.exec_command", "tools.write_stdin"].includes(field(call, "function")?.text ?? "")) return null;
  const fields = literalFields(named(args)[0]);
  const literalTypes = ["string", "template_string", "number", "true", "false", "null"];
  if (named(args).length !== 1 || !fields.size || named(call).some((node) => node.type === "optional_chain") ||
      Array.from(fields.values()).some((value) => !literalTypes.includes(value.type) ||
        named(value).some((child) => child.type === "template_substitution"))) return null;
  return call;
}

function loopPoll(loop: Node): Node | null {
  if (loop.type !== "for_statement") return null;
  const index = binding(field(loop, "initializer"));
  const ceiling = field(field(loop, "condition"), "right");
  if (!index || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(index.name) || !safeLoopCount(index.value) || !safeLoopCount(ceiling) ||
      field(loop, "condition")?.text.replace(/\s/g, "") !== `${index.name}<${ceiling!.text}` ||
      field(loop, "increment")?.text.replace(/\s/g, "") !== `${index.name}++`) return null;
  const body = field(loop, "body");
  const [declaration, branch, ...extra] = named(body);
  const result = binding(declaration);
  if (body?.type !== "statement_block" || extra.length || !result || result.name === index.name ||
      branch?.type !== "if_statement" || field(branch, "alternative")) return null;
  const condition = field(branch, "condition")?.text.replace(/\s/g, "");
  const exhausted = Number(ceiling!.text) - 1;
  const closed = `!${result.name}.session_id`;
  if (condition !== `(${closed})` && condition !== `(${closed}||${index.name}===${exhausted})`) return null;
  const consequence = field(branch, "consequence");
  const output = printedArgument(named(consequence)[0]);
  if (consequence?.type !== "statement_block" || named(consequence).length !== 2 ||
      named(consequence)[1].type !== "break_statement" || named(named(consequence)[1]).length !== 0 ||
      output?.type !== "identifier" || output.text !== result.name) return null;
  const call = commandCall(result.value);
  return field(call, "function")?.text === "tools.write_stdin" ? call : null;
}

function safeLoopCount(node?: Node | null) {
  return node?.type === "number" && /^(?:0|[1-9]\d{0,2})$/.test(node.text);
}

function printedCall(root: Node): Node | null {
  const statements = named(root);
  if (statements.length === 1) return commandCall(printedArgument(statements[0])) ?? loopPoll(statements[0]);
  if (statements.length !== 2) return null;
  const result = binding(statements[0]);
  const output = printedArgument(statements[1]);
  return result && output?.type === "identifier" && output.text === result.name ? commandCall(result.value) : null;
}

function exactCommand(statement: Node): ShellCommand | null {
  const command = statement.type === "redirected_statement" ? field(statement, "body") : statement;
  if (command?.type !== "command" ||
      named(statement).some((part) => part.type === "file_redirect" &&
        !/^(?:[12]?>{1,2}|[12]>&[12])/.test(part.text)) ||
      Array.from(nodes(statement)).some((part) => ["command_substitution", "process_substitution",
        "variable_assignment", "heredoc_redirect", "herestring_redirect"].includes(part.type))) return null;
  return shellCommand(command);
}

function exactShell(root: Node): ShellCommand[] {
  if (root.children.some((node) => !node.isNamed && node.type !== ";")) return [];
  const statements = named(root);
  if (statements.length > 3) return [];
  const commands = statements.map(exactCommand);
  return commands.every((command) => command !== null) ? commands : [];
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
  const shell = (input: unknown) => decode<ShellCommand>(bash, input, (root) =>
    Array.from(nodes(root)).flatMap((node) => node.type === "command" ? [shellCommand(node)] : []));

  const exact = (input: unknown) => decode<ShellCommand>(bash, input, exactShell);
  return {
    direct: (input: unknown) => shell(input),
    exact,
    sequential: (input: unknown): List<ShellCommand> => {
      const decoded = decode<string>(js, input, (root) => [printedCommand(root, policy)]);
      const command = decoded.$ === "Con" ? decoded.head : "";
      if (!command || command.length > maxText) return nil;
      const tree = bash.parse(command);
      try {
        if (!tree || tree.rootNode.hasError) return nil;
        const statements = tree.rootNode.namedChildren.filter((node) => node.type !== "comment");
        return policy.sequential_shell(statements.length, shellSyntax(statements[0]));
      } finally { tree?.delete(); }
    },
    wrapped: (input: unknown) => decode<ToolInvocation>(js, input, (root) => {
      const invocations: ToolInvocation[] = [];
      const printed = printedCall(root);
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
      return invocations;
    }),
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
