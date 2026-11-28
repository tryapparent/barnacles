import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { parseFragment } from "parse5";
import { Language, Parser } from "web-tree-sitter";
import { Language as SqlLanguage, Parser as SqlParser } from "@willbooster/web-tree-sitter";
import { Parser as YamlParser, parseAllDocuments } from "yaml";
import { withHookPolicy } from "../tooling/bend.ts";

type Span = { start: number; end: number };
type BendList<T> = { $: "Nil" } | { $: "Con"; head: T; tail: BendList<T> };
type LexResult = { $: "Lexed"; spans: BendList<Span> } | { $: "MalformedLiteral" | "InvalidEscape" };

type SyntaxPolicy = {
  file_format(name: string, extension: string): string;
  valid_text(text: string): boolean;
  has_text(text: string): boolean;
  interpreter(firstLine: string): string;
  is_comment_node(kind: string): boolean;
  executable_shebang(text: string, start: number): boolean;
  comment_line_ending(ending: string): number;
  git_pattern_comment(text: string, relaxed: boolean): boolean;
  markdown_html(kind: string): boolean;
  embedded_element(tag: string, scriptType: string): string;
  embedded_attr(name: string): string;
  bend_comments(text: string): LexResult;
};

type ParseComments = (file: string, bytes: Buffer) => Promise<string[]>;

const markdown = new MarkdownIt({ html: true });
const wasm = (path: string) => fileURLToPath(new URL("../node_modules/" + path, import.meta.url));
const languages = new Map<string, Language>();
let initialized: Promise<void> | undefined;
let sqlLanguage: Promise<SqlLanguage> | undefined;

function bendComments(policy: SyntaxPolicy, text: string): string[] {
  const result = policy.bend_comments(text);
  if (result.$ === "InvalidEscape") throw Error("Invalid Bend literal escape");
  if (result.$ !== "Lexed") throw Error("Malformed Bend literal");
  const comments: string[] = [];
  for (let node = result.spans; node.$ === "Con"; node = node.tail) {
    comments.push(text.slice(node.head.start, node.head.end));
  }
  return comments;
}

type SyntaxNode = { type: string; text: string; startIndex: number; children: readonly SyntaxNode[] };

function syntaxComments(policy: SyntaxPolicy, root: SyntaxNode): string[] {
  const comments: string[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (policy.is_comment_node(node.type)) {
      const { text, startIndex } = node;
      if (!policy.executable_shebang(text, startIndex)) {
        comments.push(text.slice(0, text.length - policy.comment_line_ending(text.slice(-2))));
      }
    } else {
      for (const child of node.children) pending.push(child);
    }
  }
  return comments;
}

async function parsedComments(policy: SyntaxPolicy, language: string, text: string): Promise<string[]> {
  if (language === "sqlite") {
    sqlLanguage ??= SqlParser.init().then(() =>
      SqlLanguage.load(wasm("@willbooster/tree-sitter-sql/tree-sitter-sqlite.wasm")));
    const language = await sqlLanguage;
    const parser = new SqlParser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(text);
      try {
        if (!tree || tree.rootNode.hasError) throw Error("Cannot parse SQLite source to check comments");
        return syntaxComments(policy, tree.rootNode);
      } finally { tree?.delete(); }
    } finally { parser.delete(); }
  }
  initialized ??= Parser.init();
  await initialized;
  if (!languages.has(language)) {
    const path = language === "bash" ? "tree-sitter-bash/tree-sitter-bash.wasm"
      : `${["json", "toml"].includes(language) ? "tree-sitter-wasms" : "@repomix/tree-sitter-wasms"}/out/tree-sitter-${language}.wasm`;
    languages.set(language, await Language.load(wasm(path)));
  }
  const parser = new Parser();
  try {
    parser.setLanguage(languages.get(language)!);
    const tree = parser.parse(text);
    try {
      if (!tree || tree.rootNode.hasError) throw Error(`Cannot parse ${language} source to check comments`);
      return syntaxComments(policy, tree.rootNode);
    } finally { tree?.delete(); }
  } finally { parser.delete(); }
}

function yamlComments(text: string) {
  if (parseAllDocuments(text).some((document) => document.errors.length)) throw Error("Invalid YAML syntax");
  const result: string[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if ("type" in value && value.type === "comment" && "source" in value && typeof value.source === "string") {
      result.push(value.source);
    } else {
      for (const child of Object.values(value)) visit(child);
    }
  }
  for (const token of new YamlParser().parse(text)) visit(token);
  return result;
}

async function htmlComments(policy: SyntaxPolicy, text: string) {
  const result: string[] = [];
  const pending = [...parseFragment(text, { sourceCodeLocationInfo: true }).childNodes];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.nodeName === "#comment" && node.sourceCodeLocation) {
      result.push(text.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset));
    }
    if (!("tagName" in node)) continue;
    pending.push(...node.childNodes);
    if ("content" in node) pending.push(...node.content.childNodes);
    const embedded = policy.embedded_element(node.tagName, node.attrs.find((attr) => attr.name === "type")?.value ?? "");
    if (embedded) {
      const content = node.childNodes.map((child) => "value" in child ? child.value : "").join("");
      if (policy.has_text(content)) {
        if (embedded === "unsupported") throw Error("Unsupported embedded HTML script syntax");
        if (embedded === "json") JSON.parse(content);
        else result.push(...await parsedComments(policy, embedded, content));
      }
    }
    for (const { name, value } of node.attrs) {
      switch (policy.embedded_attr(name)) {
        case "css": result.push(...await parsedComments(policy, "css", `x {${value}}`)); break;
        case "javascript": result.push(...await parsedComments(policy, "javascript", `function handler() {${value}\n}`)); break;
        case "html": result.push(...await htmlComments(policy, value)); break;
      }
    }
  }
  return result;
}

async function parseComments(policy: SyntaxPolicy, file: string, bytes: Buffer): Promise<string[]> {
  const format = policy.file_format(basename(file), extname(file).slice(1));
  if (format === "media") return [];
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!policy.valid_text(text)) throw Error("Unexpected NUL in text source");
  switch (format) {
    case "plain": return [];
    case "dockerfile": return text.split(/\r?\n/).filter((line) => line.trimStart().startsWith("#"));
    case "go-mod": return text.split(/\r?\n/).flatMap((line) => {
      const comment = line.indexOf("//");
      return comment < 0 ? [] : [line.slice(comment)];
    });
    case "gitignore":
    case "gitattributes":
      return text.split(/\r?\n/).filter((line) => policy.git_pattern_comment(line, format === "gitattributes"));
    case "bend": return bendComments(policy, text);
    case "yaml": return yamlComments(text);
    case "json": JSON.parse(text); return [];
    case "jsonl":
      for (const line of text.split(/\r?\n/)) {
        if (policy.has_text(line)) JSON.parse(line);
      }
      return [];
    case "html": return htmlComments(policy, text);
    case "markdown": {
      const tokens = markdown.parse(text, {}).flatMap((token) => token.children ?? [token]);
      const result: string[] = [];
      for (const { type, content } of tokens) {
        if (policy.markdown_html(type)) result.push(...await htmlComments(policy, content));
      }
      return result;
    }
    case "jsonc": return parsedComments(policy, "json", text);
    default: {
      const language = format || policy.interpreter(text.split("\n", 1)[0]);
      if (!language) throw Error("Unsupported comment syntax. Add a parser for this file type.");
      return parsedComments(policy, language, text);
    }
  }
}

export async function withCommentSyntax(action: (parse: ParseComments) => Promise<void> | void): Promise<void> {
  await withHookPolicy<SyntaxPolicy>(new URL("./policy/syntax.bend", import.meta.url), (policy) =>
    action((file, bytes) => parseComments(policy, file, bytes)));
}

export async function comments(file: string, bytes: Buffer): Promise<string[]> {
  let result: string[] = [];
  await withCommentSyntax(async (parse) => { result = await parse(file, bytes); });
  return result;
}
