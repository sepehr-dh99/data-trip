// SQL statement splitter: splits on `;` while respecting quotes, comments and dollar-quoted bodies.

export interface Statement {
  /** Trimmed statement text (without the terminating `;`). */
  text: string;
  /** Offset of the first character of `text` in the source. */
  start: number;
  /** Offset just past the last character of `text`. */
  end: number;
  /** Offset just past the terminating `;` (equals `end` when there is none). */
  endWithTerminator: number;
}

export interface SplitOptions {
  /** Treat [..] as a quoted identifier (SQL Server, SQLite). Default true. */
  brackets?: boolean;
  /** Recognise PostgreSQL $tag$ ... $tag$ bodies. Default true. */
  dollarQuotes?: boolean;
  /** Treat backslash as an escape inside '...' strings (MySQL). Default false. */
  backslashEscapes?: boolean;
}

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);

export function splitStatements(sql: string, opts: SplitOptions = {}): Statement[] {
  const brackets = opts.brackets !== false;
  const dollar = opts.dollarQuotes !== false;
  const backslash = opts.backslashEscapes === true;
  const out: Statement[] = [];
  const n = sql.length;
  let i = 0;
  let start = -1; // first non-whitespace char of the current statement
  let hasContent = false; // true once a non-comment token has been seen

  const push = (endExclusive: number, endWithTerm: number): void => {
    if (start >= 0 && hasContent) {
      let e = endExclusive;
      while (e > start && /\s/.test(sql[e - 1])) e--;
      out.push({ text: sql.slice(start, e), start, end: e, endWithTerminator: endWithTerm });
    }
    start = -1;
    hasContent = false;
  };

  const mark = (pos: number, content: boolean): void => {
    if (start < 0) start = pos;
    if (content) hasContent = true;
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    if (ch === ";") {
      push(i, i + 1);
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // line comment
    if (ch === "-" && next === "-") {
      mark(i, false);
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // block comment (nesting allowed, as in PostgreSQL)
    if (ch === "/" && next === "*") {
      mark(i, false);
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    mark(i, true);
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      // MySQL: backslash escapes in '...' and "..."; PostgreSQL: only in E'...' strings.
      const prev = i > 0 ? sql[i - 1] : "";
      const esc =
        (backslash && q !== "`") ||
        (dollar && q === "'" && (prev === "E" || prev === "e") && (i < 2 || !isIdentChar(sql[i - 2])));
      i++;
      while (i < n) {
        const c = sql[i];
        if (esc && c === "\\") {
          i += 2;
          continue;
        }
        if (c === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "[" && brackets) {
      i++;
      while (i < n) {
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "$" && dollar && (i === 0 || !isIdentChar(sql[i - 1]))) {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }
    i++;
  }
  push(n, n);
  return out;
}

/**
 * Statement under the cursor: the one containing `pos` (terminator included); in a gap, the
 * closest preceding statement, else the following one.
 */
export function statementAt(sql: string, pos: number, opts: SplitOptions = {}): Statement | null {
  const all = splitStatements(sql, opts);
  if (all.length === 0) return null;
  let prev: Statement | null = null;
  for (const s of all) {
    if (pos >= s.start && pos <= s.endWithTerminator) return s;
    if (s.endWithTerminator < pos) prev = s;
    else return prev ?? s;
  }
  return prev;
}
