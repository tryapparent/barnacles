import Base

def media(extension: String) -> Bool:
  List.contains(~String, ~String.eq,
    ["png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2", "ttf", "mp4", "wav", "pdf"], extension)

def has_line_break(+text: String) -> Bool:
  Bool.or(Bool.or(String.contains(text, "\n"), String.contains(text, "\r")),
    Bool.or(String.contains(text, "\u{2028}"), String.contains(text, "\u{2029}")))

def license(+name: String) -> Bool:
  Bool.or(Bool.or(String.eq(name, "LICENSE"), String.eq(name, "NOTICE")),
    Bool.and(Bool.not(has_line_break(name)),
      Bool.or(String.ends_with(name, "-LICENSE"), String.ends_with(name, "-NOTICE"))))

def extension_format(extension: String) -> String:
  match extension:
    case "ts": "typescript"
    case "cts": "typescript"
    case "mts": "typescript"
    case "tsx": "tsx"
    case "js": "javascript"
    case "cjs": "javascript"
    case "mjs": "javascript"
    case "jsx": "javascript"
    case "css": "css"
    case "sh": "bash"
    case "bash": "bash"
    case "py": "python"
    case "rs": "rust"
    case "c": "c"
    case "h": "c"
    case "cpp": "cpp"
    case "hpp": "cpp"
    case "go": "go"
    case "jsonc": "jsonc"
    case "toml": "toml"
    case "txt": "plain"
    case "bend": "bend"
    case "sql": "sqlite"
    case "yaml": "yaml"
    case "yml": "yaml"
    case "json": "json"
    case "jsonl": "jsonl"
    case "html": "html"
    case "htm": "html"
    case "svg": "html"
    case "md": "markdown"
    case _: ""

def named_format(+name: String, extension: String) -> String:
  match name:
    case ".gitignore": "gitignore"
    case ".gitattributes": "gitattributes"
    case _:
      Bool.pick(String, license(name), "plain", extension_format(extension))

def file_format(name: String, extension: String) -> String:
  +normalized = String.to_lower(extension)
  Bool.pick(String, media(normalized), "media", named_format(name, normalized))

def valid_text(text: String) -> Bool:
  Bool.not(String.contains(text, "\u{0}"))

def whitespace(character: Char) -> Bool:
  match character:
    case ' ': True{}
    case '\u{A0}': True{}
    case '\u{1680}': True{}
    case '\u{2028}': True{}
    case '\u{2029}': True{}
    case '\u{202F}': True{}
    case '\u{205F}': True{}
    case '\u{3000}': True{}
    case '\u{FEFF}': True{}
    case _:
      +code = Char.to_u32(character)
      Bool.or(Bool.and(U32.is_ge(code, 9), U32.is_le(code, 13)),
        Bool.and(U32.is_ge(code, 8192), U32.is_le(code, 8202)))

def has_non_space(text: String, seen: Bool) -> Bool:
  match text seen:
    case _ True{}: True{}
    case SNil{} False{}: False{}
    case SCon{head, tail} False{}: has_non_space(tail, Bool.not(whitespace(head)))

def has_text(text: String) -> Bool:
  has_non_space(text, False{})

def trim_left(text: String, preceding: String, skipping: Bool) -> String:
  match text skipping:
    case _ False{}: preceding
    case SNil{} True{}: ""
    case SCon{+head, +tail} True{}:
      trim_left(tail, SCon{head, tail}, whitespace(head))

def trim_start(text: String) -> String:
  trim_left(text, "", True{})

def word_char(+character: Char) -> Bool:
  Bool.or(Char.is_alpha(character), Bool.or(Char.is_digit(character), Char.is_eq(character, '_')))

def interpreter_word(word: String) -> U32:
  match word:
    case "sh": 3
    case "bash": 3
    case "dash": 3
    case "zsh": 3
    case "node": 2
    case "python": 1
    case "python2": 1
    case "python3": 1
    case _: 0

def better_interpreter(+previous: U32, +word: String) -> U32:
  +rank = interpreter_word(word)
  Bool.pick(U32, U32.is_gt(rank, previous), rank, previous)

def line_break(character: Char) -> Bool:
  match character:
    case '\n': True{}
    case '\r': True{}
    case '\u{2028}': True{}
    case '\u{2029}': True{}
    case _: False{}

type InterpreterWord is Data:
  Word{backwards: String, rank: U32, ended: Bool}

def append_word_character(word: InterpreterWord, c: Char, extending: Bool) -> InterpreterWord:
  match word extending:
    case Word{backwards, rank, ended} True{}: Word{SCon{c, backwards}, rank, False{}}
    case Word{backwards, rank, ended} False{}:
      Word{"", better_interpreter(rank, String.reverse(backwards)), line_break(c)}

def interpreter_rank(text: String, word: InterpreterWord) -> U32:
  match text word:
    case _ Word{backwards, rank, True{}}: rank
    case SNil{} Word{backwards, rank, False{}}: better_interpreter(rank, String.reverse(backwards))
    case SCon{+head, tail} Word{backwards, rank, False{}}:
      interpreter_rank(tail, append_word_character(Word{backwards, rank, False{}}, head, word_char(head)))

def interpreter_name(rank: U32) -> String:
  match rank:
    case 3: "bash"
    case 2: "javascript"
    case 1: "python"
    case _: ""

def interpreter(first_line: String) -> String:
  match first_line:
    case SCon{'#', SCon{'!', rest}}: interpreter_name(interpreter_rank(rest, Word{"", 0, False{}}))
    case _: ""

def shell_directive(text: String) -> Bool:
  match text:
    case SCon{'/', _}: True{}
    case "env": True{}
    case SCon{'e', SCon{'n', SCon{'v', SCon{next, _}}}}: Bool.not(word_char(next))
    case _: False{}

def executable_shebang(text: String, start: U32) -> Bool:
  match text start:
    case SCon{'#', SCon{'!', rest}} 0: shell_directive(trim_start(rest))
    case _ _: False{}

def is_comment_node(kind: String) -> Bool:
  match kind:
    case "comment": True{}
    case _: String.ends_with(kind, "_comment")

def comment_line_ending(ending: String) -> U32:
  match ending:
    case "\r\n": 2
    case _: Bool.to_u32(String.ends_with(ending, "\n"))

def starts_hash(text: String) -> Bool:
  match text:
    case SCon{'#', _}: True{}
    case _: False{}

def git_pattern_comment(+text: String, relaxed: Bool) -> Bool:
  match relaxed:
    case True{}: starts_hash(trim_start(text))
    case False{}: starts_hash(text)

def markdown_html(+kind: String) -> Bool:
  Bool.or(String.eq(kind, "html_inline"), String.eq(kind, "html_block"))

def script_format(kind: String) -> String:
  match kind:
    case "application/json": "json"
    case "application/ld+json": "json"
    case "importmap": "json"
    case "": "javascript"
    case "module": "javascript"
    case "text/javascript": "javascript"
    case "application/javascript": "javascript"
    case _: ""

def embedded_element(tag: String, script_type: String) -> String:
  match tag:
    case "style": "css"
    case "script":
      +trimmed = String.reverse(trim_start(String.reverse(trim_start(script_type))))
      +format = script_format(String.to_lower(trimmed))
      Bool.pick(String, String.is_empty(format), "unsupported", format)
    case _: ""

def embedded_attr(name: String) -> String:
  match name:
    case "style": "css"
    case "srcdoc": "html"
    case _:
      Bool.pick(String, String.starts_with(name, "on"), "javascript", "")

type Span is Data:
  Span{start: U32, end: U32}

type LexResult is Data:
  Lexed{spans: List<&2, Span>}
  MalformedLiteral{}
  InvalidEscape{}

type Lexer is Data:
  Code{}
  Comment{start: U32, carriage: Bool}
  Quoted{quote: Char, units: U32}
  Escape{quote: Char, units: U32}
  UnicodeBrace{quote: Char, units: U32}
  UnicodeDigits{quote: Char, units: U32, digits: U32}
  BadLiteral{}
  BadEscape{}

def code_character(c: Char, offset: U32) -> Lexer:
  match c:
    case '#': Comment{offset, False{}}
    case '"': Quoted{'"', 0}
    case '\'': Quoted{'\'', 0}
    case _: Code{}

def literal_close(quote: Char, units: U32) -> Lexer:
  +valid = Bool.or(Bool.not(Char.is_eq(quote, '\'')), U32.is_eq(units, 1))
  Bool.pick(Lexer, valid, Code{}, BadLiteral{})

def literal_character(+c: Char, +quote: Char, +units: U32) -> Lexer:
  match c:
    case '\\': Escape{quote, units}
    case _:
      Bool.pick(Lexer, Char.is_eq(c, quote), literal_close(quote, units), Quoted{quote, U32.inc(units)})

def escape_character(c: Char, +quote: Char, +units: U32) -> Lexer:
  match c:
    case 'u': UnicodeBrace{quote, units}
    case 'U': UnicodeBrace{quote, units}
    case _:
      +valid = String.contains("ntr0\\'\"", SCon{c, SNil{}})
      Bool.pick(Lexer, valid, Quoted{quote, U32.inc(units)}, BadEscape{})

def hex_digit(+c: Char) -> Bool:
  Bool.or(Char.is_digit(c), String.contains("abcdef", SCon{Char.to_lower(c), SNil{}}))

def unicode_character(+c: Char, +quote: Char, +units: U32, +digits: U32) -> Lexer:
  match c:
    case '}': Bool.pick(Lexer, U32.is_gt(digits, 0), Quoted{quote, U32.inc(units)}, BadEscape{})
    case _:
      +valid = Bool.and(U32.is_lt(digits, 8), hex_digit(c))
      Bool.pick(Lexer, valid, UnicodeDigits{quote, units, U32.inc(digits)}, BadEscape{})

def next_lexer(lexer: Lexer, +c: Char, offset: U32) -> Lexer:
  match lexer:
    case Code{}: code_character(c, offset)
    case Comment{start, carriage}:
      Bool.pick(Lexer, Char.is_eq(c, '\n'), Code{}, Comment{start, Char.is_eq(c, '\r')})
    case Quoted{quote, units}: literal_character(c, quote, units)
    case Escape{quote, units}: escape_character(c, quote, units)
    case UnicodeBrace{quote, units}:
      Bool.pick(Lexer, Char.is_eq(c, '{'), UnicodeDigits{quote, units, 0}, BadEscape{})
    case UnicodeDigits{quote, units, digits}: unicode_character(c, quote, units, digits)
    case BadLiteral{}: BadLiteral{}
    case BadEscape{}: BadEscape{}

def emit_span(spans: List<&2, Span>, start: U32, offset: U32, carriage: Bool) -> List<&2, Span>:
  Span{start, U32.sub(offset, Bool.to_u32(carriage))} <> spans

def next_spans(spans: List<&2, Span>, lexer: Lexer, c: Char, offset: U32) -> List<&2, Span>:
  match lexer c:
    case Comment{start, carriage} '\n': emit_span(spans, start, offset, carriage)
    case _ _: spans

def finish_lexer(lexer: Lexer, offset: U32, spans: List<&2, Span>) -> LexResult:
  match lexer:
    case Code{}: Lexed{List.reverse(&2, Span, spans)}
    case Comment{start, carriage}: Lexed{List.reverse(&2, Span, emit_span(spans, start, offset, carriage))}
    case Quoted{quote, units}: MalformedLiteral{}
    case BadLiteral{}: MalformedLiteral{}
    case Escape{quote, units}: InvalidEscape{}
    case UnicodeBrace{quote, units}: InvalidEscape{}
    case UnicodeDigits{quote, units, digits}: InvalidEscape{}
    case BadEscape{}: InvalidEscape{}

def utf16_width(c: Char) -> U32:
  U32.add(1, Bool.to_u32(U32.is_gt(Char.to_u32(c), 65535)))

def lex(text: String, +lexer: Lexer, +offset: U32, spans: List<&2, Span>) -> LexResult:
  match text lexer:
    case _ BadLiteral{}: MalformedLiteral{}
    case _ BadEscape{}: InvalidEscape{}
    case SNil{} _: finish_lexer(lexer, offset, spans)
    case SCon{+c, tail} _:
      lex(tail, next_lexer(lexer, c, offset), U32.add(offset, utf16_width(c)), next_spans(spans, lexer, c, offset))

def bend_comments(text: String) -> LexResult:
  lex(text, Code{}, 0, [])
