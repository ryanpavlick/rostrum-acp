/**
 * A tiny syntax highlighter for fenced code blocks.
 *
 * Deliberately not a real parser and deliberately not a dependency: the
 * webview runs under a CSP that forbids external resources, and a full
 * highlighting library would dwarf the rest of the bundle for a transcript
 * pane. This lexes far enough to colour strings, comments, numbers and
 * keywords, which is what makes a code block readable at a glance.
 *
 * It returns tokens rather than markup. The renderer turns each into a span
 * with `textContent`, so highlighting can never introduce markup into
 * untrusted agent output.
 */

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "type";

export interface Token {
  kind: TokenKind;
  text: string;
}

interface Grammar {
  /** Line-comment openers, e.g. `//` or `#`. */
  lineComment: string[];
  /** Block-comment delimiter pairs. */
  blockComment: [string, string][];
  /** Quote characters that begin a string. */
  quotes: string[];
  keywords: Set<string>;
  types: Set<string>;
}

const C_LIKE_KEYWORDS = [
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default",
  "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "of", "private",
  "protected", "public", "readonly", "return", "static", "super", "switch", "this", "throw",
  "try", "type", "typeof", "var", "void", "while", "yield",
];

const C_LIKE_TYPES = [
  "any", "bigint", "boolean", "false", "never", "null", "number", "object", "string", "symbol",
  "true", "undefined", "unknown",
];

const PYTHON_KEYWORDS = [
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
];

const SHELL_KEYWORDS = [
  "case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "local",
  "return", "select", "then", "until", "while",
];

const RUST_KEYWORDS = [
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
  "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref",
  "return", "self", "static", "struct", "super", "trait", "type", "unsafe", "use", "where", "while",
];

const GO_KEYWORDS = [
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for",
  "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select",
  "struct", "switch", "type", "var",
];

function grammar(
  lineComment: string[],
  blockComment: [string, string][],
  quotes: string[],
  keywords: string[],
  types: string[] = [],
): Grammar {
  return {
    lineComment,
    blockComment,
    quotes,
    keywords: new Set(keywords),
    types: new Set(types),
  };
}

const C_LIKE = grammar(["//"], [["/*", "*/"]], ['"', "'", "`"], C_LIKE_KEYWORDS, C_LIKE_TYPES);

const GRAMMARS: Record<string, Grammar> = {
  javascript: C_LIKE,
  js: C_LIKE,
  jsx: C_LIKE,
  typescript: C_LIKE,
  ts: C_LIKE,
  tsx: C_LIKE,
  java: C_LIKE,
  c: C_LIKE,
  cpp: C_LIKE,
  csharp: C_LIKE,
  kotlin: C_LIKE,
  swift: C_LIKE,
  go: grammar(["//"], [["/*", "*/"]], ['"', "'", "`"], GO_KEYWORDS, ["bool", "byte", "error", "false", "float64", "int", "nil", "rune", "string", "true"]),
  rust: grammar(["//"], [["/*", "*/"]], ['"', "'"], RUST_KEYWORDS, ["bool", "char", "f64", "false", "i32", "i64", "str", "true", "u32", "u64", "usize"]),
  python: grammar(["#"], [], ['"', "'"], PYTHON_KEYWORDS, ["False", "None", "True", "bool", "dict", "float", "int", "list", "self", "str", "tuple"]),
  py: grammar(["#"], [], ['"', "'"], PYTHON_KEYWORDS, ["False", "None", "True", "bool", "dict", "float", "int", "list", "self", "str", "tuple"]),
  ruby: grammar(["#"], [], ['"', "'"], ["begin", "class", "def", "do", "else", "elsif", "end", "if", "module", "require", "return", "unless", "until", "while", "yield"], ["false", "nil", "true"]),
  bash: grammar(["#"], [], ['"', "'"], SHELL_KEYWORDS),
  sh: grammar(["#"], [], ['"', "'"], SHELL_KEYWORDS),
  shell: grammar(["#"], [], ['"', "'"], SHELL_KEYWORDS),
  zsh: grammar(["#"], [], ['"', "'"], SHELL_KEYWORDS),
  yaml: grammar(["#"], [], ['"', "'"], [], ["false", "null", "true"]),
  yml: grammar(["#"], [], ['"', "'"], [], ["false", "null", "true"]),
  toml: grammar(["#"], [], ['"', "'"], [], ["false", "true"]),
  sql: grammar(["--"], [["/*", "*/"]], ["'", '"'], ["and", "as", "by", "create", "delete", "drop", "from", "group", "having", "insert", "into", "join", "limit", "not", "on", "or", "order", "select", "set", "table", "update", "values", "where"], ["null"]),
  json: grammar([], [], ['"'], [], ["false", "null", "true"]),
  css: grammar([], [["/*", "*/"]], ['"', "'"], [], []),
  html: grammar([], [["<!--", "-->"]], ['"', "'"], [], []),
  xml: grammar([], [["<!--", "-->"]], ['"', "'"], [], []),
};

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER = /0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?/y;

/**
 * Lex `source` into coloured tokens.
 *
 * An unknown language yields a single plain token, so an unrecognised fence
 * still renders — just without colour.
 */
export function highlight(source: string, lang: string): Token[] {
  const rules = GRAMMARS[lang.toLowerCase()];
  if (!rules || !source) return [{ kind: "plain", text: source }];

  const tokens: Token[] = [];
  let plain = "";
  let index = 0;

  const flush = () => {
    if (plain) tokens.push({ kind: "plain", text: plain });
    plain = "";
  };
  const emit = (kind: TokenKind, text: string) => {
    flush();
    tokens.push({ kind, text });
  };

  while (index < source.length) {
    const rest = source.slice(index);

    const line = rules.lineComment.find((marker) => rest.startsWith(marker));
    if (line) {
      const end = rest.indexOf("\n");
      const text = end < 0 ? rest : rest.slice(0, end);
      emit("comment", text);
      index += text.length;
      continue;
    }

    const block = rules.blockComment.find(([open]) => rest.startsWith(open));
    if (block) {
      const close = rest.indexOf(block[1], block[0].length);
      // An unterminated block comment runs to the end, as a compiler would see it.
      const text = close < 0 ? rest : rest.slice(0, close + block[1].length);
      emit("comment", text);
      index += text.length;
      continue;
    }

    const quote = rules.quotes.find((character) => rest.startsWith(character));
    if (quote) {
      let cursor = quote.length;
      while (cursor < rest.length) {
        if (rest[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (rest.startsWith(quote, cursor)) {
          cursor += quote.length;
          break;
        }
        // A single-quoted string does not span lines in most of these
        // languages; stopping at the newline keeps one stray quote from
        // colouring the rest of the block.
        if (rest[cursor] === "\n" && quote !== "`") break;
        cursor += 1;
      }
      const text = rest.slice(0, cursor);
      emit("string", text);
      index += text.length;
      continue;
    }

    if (/[0-9]/.test(rest[0])) {
      NUMBER.lastIndex = 0;
      const match = NUMBER.exec(rest);
      if (match) {
        emit("number", match[0]);
        index += match[0].length;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(rest[0])) {
      IDENTIFIER.lastIndex = 0;
      const match = IDENTIFIER.exec(rest);
      if (match) {
        const word = match[0];
        if (rules.keywords.has(word)) emit("keyword", word);
        else if (rules.types.has(word)) emit("type", word);
        else plain += word;
        index += word.length;
        continue;
      }
    }

    plain += rest[0];
    index += 1;
  }

  flush();
  return tokens;
}

/** Languages that will actually be coloured, for tests and diagnostics. */
export function supportedLanguages(): string[] {
  return Object.keys(GRAMMARS).sort();
}
