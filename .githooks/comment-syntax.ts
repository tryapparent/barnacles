import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { parseFragment } from "parse5";
import { Language, Parser } from "web-tree-sitter";
import { Language as SqlLanguage, Parser as SqlParser } from "@willbooster/web-tree-sitter";
import { Parser as YamlParser, parseAllDocuments } from "yaml";

const grammar: Record<string, string> = {
  ts: "typescript", cts: "typescript", mts: "typescript", tsx: "tsx",
  js: "javascript", cjs: "javascript", mjs: "javascript", jsx: "javascript",
  css: "css", sh: "bash", bash: "bash", py: "python", rs: "rust",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", go: "go", jsonc: "json", toml: "toml",
};
const media = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2", "ttf", "mp4", "wav", "pdf"]);
const markdown = new MarkdownIt({ html: true });
const wasm = (path: string) => fileURLToPath(new URL("../node_modules/" + path, import.meta.url));
const languages = new Map<string, Language>();
let initialized: Promise<void> | undefined;
let sqlLanguage: Promise<SqlLanguage> | undefined;

function bendComments(text: string) {
  const comments: string[] = [];
  for (let i = 0; i < text.length;) {
    const start = i;
    const token = text[i++];
    if (token === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      comments.push(text.slice(start, i).replace(/\r$/, ""));
    } else if (token === '"' || token === "'") {
      let units = 0;
      while (i < text.length && text[i] !== token) {
        if (text[i] === "\\") {
          i++;
          const unicode = /^u\{[0-9a-f]+\}/i.exec(text.slice(i, i + 11));
          if (unicode) i += unicode[0].length;
          else if (i < text.length && "ntr0\\'\"".includes(text[i])) i++;
          else throw Error("Invalid Bend literal escape");
        } else {
          i += text.codePointAt(i)! > 0xffff ? 2 : 1;
        }
        units++;
      }
      if (text[i] !== token || (token === "'" && units !== 1)) throw Error("Malformed Bend literal");
      i++;
    }
  }
  return comments;
}

type SyntaxNode = { type: string; text: string; startIndex: number; children: readonly SyntaxNode[] };

function syntaxComments(root: SyntaxNode): string[] {
  const comments: string[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (/(?:^|_)comment$/.test(node.type)) {
      if (!(node.startIndex === 0 && /^#!\s*(?:\/|env\b)/.test(node.text))) {
        comments.push(node.text.replace(/\r?\n$/, ""));
      }
    } else {
      for (const child of node.children) pending.push(child);
    }
  }
  return comments;
}

async function parsedComments(language: string, text: string): Promise<string[]> {
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
        return syntaxComments(tree.rootNode);
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
      return syntaxComments(tree.rootNode);
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

async function htmlComments(text: string) {
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
    const content = node.childNodes.map((child) => "value" in child ? child.value : "").join("");
    if (node.tagName === "style" && content.trim()) result.push(...await parsedComments("css", content));
    if (node.tagName === "script" && content.trim()) {
      const kind = node.attrs.find((attr) => attr.name === "type")?.value.trim().toLowerCase() ?? "";
      if (["application/json", "application/ld+json", "importmap"].includes(kind)) JSON.parse(content);
      else if (["", "module", "text/javascript", "application/javascript"].includes(kind)) {
        result.push(...await parsedComments("javascript", content));
      } else throw Error("Unsupported embedded HTML script syntax");
    }
    for (const { name, value } of node.attrs) {
      if (name === "style") result.push(...await parsedComments("css", `x {${value}}`));
      if (name.startsWith("on")) result.push(...await parsedComments("javascript", `function handler() {${value}\n}`));
      if (name === "srcdoc") result.push(...await htmlComments(value));
    }
  }
  return result;
}

export async function comments(file: string, bytes: Buffer): Promise<string[]> {
  const ext = extname(file).slice(1).toLowerCase();
  const name = basename(file);
  if (media.has(ext)) return [];
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw Error("Unexpected NUL in text source");
  if (/^(?:.*-)?(?:LICENSE|NOTICE)$/.test(name) || ext === "txt") return [];
  if (name === ".gitignore" || name === ".gitattributes") {
    const commentStart = name === ".gitignore" ? /^#/ : /^\s*#/;
    return text.split(/\r?\n/).filter((line) => commentStart.test(line));
  }
  if (ext === "bend") return bendComments(text);
  if (ext === "sql") return parsedComments("sqlite", text);
  if (ext === "yaml" || ext === "yml") return yamlComments(text);
  if (ext === "json" || ext === "jsonl") {
    for (const value of ext === "json" ? [text] : text.split(/\r?\n/).filter((line) => line.trim())) JSON.parse(value);
    return [];
  }
  if (["html", "htm", "svg"].includes(ext)) return htmlComments(text);
  if (ext === "md") {
    const tokens = markdown.parse(text, {}).flatMap((token) => token.children ?? [token]);
    const result: string[] = [];
    for (const { type, content } of tokens) {
      if (type === "html_block" || type === "html_inline") result.push(...await htmlComments(content));
    }
    return result;
  }
  const first = text.split("\n", 1)[0];
  const interpreter = /^#!.*\b(?:ba|da|z)?sh\b/.test(first) ? "bash"
    : /^#!.*\bnode\b/.test(first) ? "javascript"
    : /^#!.*\bpython[23]?(?:\.\d+)?\b/.test(first) ? "python" : undefined;
  const language = Object.hasOwn(grammar, ext) ? grammar[ext] : interpreter;
  if (!language) throw Error("Unsupported comment syntax. Add a parser for this file type.");
  return parsedComments(language, text);
}
