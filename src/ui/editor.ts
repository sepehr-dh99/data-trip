// ALL CodeMirror usage lives here, behind the small SqlEditor interface.
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import type { CompletionContext } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { MSSQL, MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import { splitStatements, statementAt } from "../sqlsplit";
import type { SplitOptions } from "../sqlsplit";
import type { Driver } from "../types";
import { filterCompletions } from "./sqlutil";
import { REDIS_COMMANDS, redisLinesAt, splitRedisLines } from "./redis";
import { CONSUME_FLAGS, KAFKA_COMMANDS, PRODUCE_FIELDS } from "./kafka";

export interface EditorOptions {
  doc?: string;
  driver: Driver;
  /** Kafka consoles: topic / group names for completion (read lazily on every keystroke). */
  kafkaNames?: () => { topics: string[]; groups: string[] };
  onRun: () => void;
  onRunAll: () => void;
  onChange?: () => void;
}

export interface Runnable {
  text: string;
  from: number;
  to: number;
}

const DIALECTS = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite, mssql: MSSQL } as const;

// ---- Redis: plain-text mode with a tinted command word and command-name completion.

interface RedisStreamState {
  first: boolean;
}
interface StreamLike {
  sol(): boolean;
  eatSpace(): boolean;
  match(re: RegExp): RegExpMatchArray | boolean | null;
  next(): string | void;
}

/** One line = one command: comment lines (# or //), the command word, quoted strings and numbers. */
const redisStream = {
  name: "redis",
  startState: (): RedisStreamState => ({ first: true }),
  token(stream: StreamLike, state: RedisStreamState): string | null {
    if (stream.sol()) state.first = true;
    if (stream.eatSpace()) return null;
    if (state.first && (stream.match(/^#.*/) || stream.match(/^\/\/.*/))) return "comment";
    if (state.first && stream.match(/^[A-Za-z_][\w.]*/)) {
      state.first = false;
      return "typeName";
    }
    state.first = false;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?=\s|$)/)) return "number";
    if (stream.match(/^[^\s"']+/)) return null;
    stream.next();
    return null;
  },
};

const REDIS_COMPLETIONS = REDIS_COMMANDS.map((c) => ({
  label: c.name,
  detail: c.group,
  type: "keyword",
  info: () => {
    const box = document.createElement("div");
    box.className = "rd-sig";
    const head = document.createElement("b");
    head.textContent = c.name;
    box.append(head, document.createTextNode(c.sig.slice(c.name.length)));
    return box;
  },
}));

interface CompletionCtxLike {
  state: { doc: { lineAt(pos: number): { from: number; text: string } } };
  pos: number;
  explicit: boolean;
}

/** Completes the command word at the start of a line (case-insensitive: CodeMirror's matcher ignores case). */
function redisCompletionSource(ctx: CompletionCtxLike): { from: number; options: typeof REDIS_COMPLETIONS; validFor: RegExp } | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /^\s*([A-Za-z][\w.]*)?$/.exec(before);
  if (!m) return null;
  const word = m[1] ?? "";
  if (!word && !ctx.explicit) return null;
  return { from: ctx.pos - word.length, options: REDIS_COMPLETIONS, validFor: /^[\w.]*$/ };
}


// ---- Kafka: line-based command language, plain text with a tinted command word / flags and completion
// for commands, sub-commands, flags and the topic / group names of the cached cluster overview.

const kafkaStream = {
  name: "kafka",
  startState: (): RedisStreamState => ({ first: true }),
  token(stream: StreamLike, state: RedisStreamState): string | null {
    if (stream.sol()) state.first = true;
    if (stream.eatSpace()) return null;
    if (state.first && (stream.match(/^#.*/) || stream.match(/^\/\/.*/))) return "comment";
    if (state.first && stream.match(/^[A-Za-z_][\w]*/)) {
      state.first = false;
      return "typeName";
    }
    state.first = false;
    if (stream.match(/^--[\w-]+/)) return "keyword";
    if (stream.match(/^(?:key|value|partition|partitions|replication|header\.[^\s=]+)(?==)/)) return "keyword";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?=\s|$)/)) return "number";
    if (stream.match(/^[^\s"']+/)) return null;
    stream.next();
    return null;
  },
};

interface KOption {
  label: string;
  detail: string;
  type: string;
  info: () => HTMLElement;
}

const kInfo = (text: string, head = ""): (() => HTMLElement) => () => {
  const box = document.createElement("div");
  box.className = "rd-sig";
  if (head) {
    const b = document.createElement("b");
    b.textContent = head;
    box.append(b, document.createTextNode(text.slice(head.length)));
  } else box.textContent = text;
  return box;
};

const KAFKA_CMD_OPTIONS: KOption[] = KAFKA_COMMANDS.map((c) => ({ label: c.name, detail: c.detail, type: "keyword", info: kInfo(c.sig, c.name) }));
const KAFKA_FLAG_OPTIONS: KOption[] = CONSUME_FLAGS.map((f) => ({ label: f.name, detail: f.detail, type: "property", info: kInfo(f.name + " — " + f.detail) }));
const KAFKA_FIELD_OPTIONS: KOption[] = PRODUCE_FIELDS.map((f) => ({ label: f.name, detail: f.detail, type: "property", info: kInfo(f.name + " — " + f.detail) }));
const KAFKA_CREATE_OPTIONS: KOption[] = [
  { label: "partitions=", detail: "partition count", type: "property", info: kInfo("partitions=<n>") },
  { label: "replication=", detail: "replication factor", type: "property", info: kInfo("replication=<n>") },
];
const kWord = (label: string, detail: string): KOption => ({ label, detail, type: "keyword", info: kInfo(`${label} — ${detail}`) });

function kafkaCompletionSource(names: () => { topics: string[]; groups: string[] }) {
  return (ctx: CompletionCtxLike): { from: number; options: KOption[]; validFor: RegExp } | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const word = /(\S*)$/.exec(before)?.[1] ?? "";
    const head = before.slice(0, before.length - word.length);
    const toks = head.trim() ? head.trim().split(/\s+/) : [];
    if (toks.length === 0 && !word && !ctx.explicit) return null;
    if (/^\s*(#|\/\/)/.test(before)) return null;
    const n = names();
    const topics = (): KOption[] => n.topics.map((t) => ({ label: t, detail: "topic", type: "variable", info: kInfo(t) }));
    const groups = (): KOption[] => n.groups.map((g) => ({ label: g, detail: "group", type: "variable", info: kInfo(g) }));
    let options: KOption[] = [];
    const cmd = (toks[0] ?? "").toLowerCase();
    if (toks.length === 0) options = KAFKA_CMD_OPTIONS;
    else if (cmd === "describe") {
      if (toks.length === 1) options = [kWord("topic", "describe a topic"), kWord("group", "describe a consumer group")];
      else if (toks.length === 2) options = toks[1].toLowerCase() === "group" ? groups() : toks[1].toLowerCase() === "topic" ? topics() : [];
    } else if (cmd === "create" || cmd === "delete") {
      if (toks.length === 1) options = [kWord("topic", cmd + " a topic")];
      else if (toks.length === 2 && cmd === "delete") options = topics();
      else if (toks.length >= 3 && cmd === "create") options = KAFKA_CREATE_OPTIONS;
    } else if (cmd === "consume") {
      const prev = toks[toks.length - 1].toLowerCase();
      if (toks.length === 1) options = topics();
      else if (/^--(partition|limit|offset|from-timestamp|key-contains|value-contains)$/.test(prev)) options = [];
      else options = KAFKA_FLAG_OPTIONS;
    } else if (cmd === "produce") {
      options = toks.length === 1 ? topics() : KAFKA_FIELD_OPTIONS;
    }
    if (!options.length) return null;
    return { from: ctx.pos - word.length, options, validFor: /^[\w.\-=:]*$/ };
  };
}

const KAFKA_PLACEHOLDER = "Write Kafka commands, one per line — e.g. consume orders.v2 --latest --limit 20. Ctrl/Cmd+Enter runs the line under the cursor.";

function splitOptsFor(driver: Driver): SplitOptions {
  switch (driver) {
    case "postgres":
      return { brackets: false, dollarQuotes: true };
    case "mysql":
      return { brackets: false, dollarQuotes: false, backslashEscapes: true };
    default:
      return { brackets: true, dollarQuotes: false };
  }
}

// Syntax colors from the spec (C3): keywords #ff7088, strings #8fd9a8, comments #6e6e76.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--syn-type)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)" },
  { tag: [t.punctuation, t.operator, t.paren, t.bracket], color: "var(--syn-punct)" },
  { tag: t.special(t.name), color: "var(--syn-number)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--text-code)", fontSize: "13.5px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "23px",
      overflow: "auto",
    },
    ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
    ".cm-line": { padding: "0 20px 0 12px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--text-gutter)",
      border: "none",
    },
    // 58px gutter, numbers right-aligned with 20px before the code (spec)
    ".cm-lineNumbers .cm-gutterElement": { boxSizing: "border-box", minWidth: "58px", padding: "0 20px 0 8px", textAlign: "right" },
    ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)", color: "var(--text-3)" },
    ".cm-selectionBackground": { backgroundColor: "var(--accent-sel-blur) !important" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
      backgroundColor: "var(--accent-sel) !important",
    },
    ".cm-selectionMatch": { backgroundColor: "rgba(255, 255, 255, 0.07)" },
    ".cm-matchingBracket": { backgroundColor: "rgba(255, 255, 255, 0.08)", outline: "1px solid rgba(255, 112, 136, 0.55)" },
    ".cm-placeholder": { color: "var(--text-4)" },
    ".cm-tooltip": {
      border: "none",
      borderRadius: "12px",
      background: "var(--menu-bg)",
      backdropFilter: "var(--float-blur)",
      boxShadow: "var(--float-shadow), 0 16px 40px rgba(0, 0, 0, 0.35)",
      overflow: "hidden",
      color: "var(--text)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono)",
      fontSize: "12.5px",
      maxHeight: "260px",
      padding: "4px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { borderRadius: "8px", padding: "3px 10px" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      background: "var(--raised)",
      color: "var(--text)",
    },
    ".cm-completionDetail": { color: "var(--text-3)", fontStyle: "normal", marginLeft: "10px" },
    ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent-text)" },
    ".cm-panels": { background: "var(--solid-pop)", color: "var(--text)", borderColor: "var(--hair)" },
    ".cm-panels input, .cm-panels button": { fontFamily: "var(--font-ui)" },
    ".cm-panels input": { background: "var(--fill)", border: "none", borderRadius: "999px", padding: "3px 10px", color: "var(--text)" },
    ".cm-panels button": { background: "var(--fill)", backgroundImage: "none", border: "none", borderRadius: "999px", padding: "3px 10px", color: "var(--text)" },
    ".cm-searchMatch": { backgroundColor: "rgba(255, 197, 107, 0.18)", outline: "1px solid rgba(255, 197, 107, 0.4)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(255, 26, 60, 0.3)" },
  },
  { dark: true },
);

export class SqlEditor {
  private view: EditorView;
  private lang = new Compartment();
  private driver: Driver;
  private schema: Record<string, string[]> = {};
  private kafkaNames: () => { topics: string[]; groups: string[] };

  constructor(parent: HTMLElement, opts: EditorOptions) {
    this.driver = opts.driver;
    this.kafkaNames = opts.kafkaNames ?? (() => ({ topics: [], groups: [] }));
    const onChange = opts.onChange;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlight),
      this.lang.of(this.langExtension()),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      theme,
      EditorView.updateListener.of((u: { docChanged: boolean }) => {
        if (u.docChanged && onChange) onChange();
      }),
    ];
    this.view = new EditorView({
      state: EditorState.create({ doc: opts.doc ?? "", extensions }),
      parent,
    });
    // Capture on the container so Mod-Enter wins over CodeMirror's own bindings.
    parent.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) opts.onRunAll();
          else opts.onRun();
        }
      },
      true,
    );
  }

  private langExtension(): Extension {
    if (this.driver === "kafka") {
      return [
        StreamLanguage.define(kafkaStream),
        autocompletion({ icons: false, override: [kafkaCompletionSource(() => this.kafkaNames())] }),
        placeholder(KAFKA_PLACEHOLDER),
      ];
    }
    if (this.driver === "redis") {
      return [
        StreamLanguage.define(redisStream),
        autocompletion({ icons: false, override: [redisCompletionSource] }),
        placeholder("Write Redis commands, one per line — Ctrl/Cmd+Enter runs the line under the cursor."),
      ];
    }
    return [
      sql({
        dialect: DIALECTS[this.driver],
        schema: this.schema,
        upperCaseKeywords: true,
      }),
      autocompletion({ icons: false }),
      placeholder("Write SQL here — Ctrl/Cmd+Enter runs the statement at the cursor."),
    ];
  }

  /** Redis and Kafka consoles are line-based: one command per line. */
  private lineBased(): boolean {
    return this.driver === "redis" || this.driver === "kafka";
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  /** Replace the selection (or insert at the cursor) with `text`. */
  insertText(text: string): void {
    const sel = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
  }

  getSelectionOrStatementAtCursor(): Runnable | null {
    const st = this.view.state;
    const sel = st.selection.main;
    if (!sel.empty) {
      const raw = st.sliceDoc(sel.from, sel.to);
      const text = raw.trim();
      if (!text) return null;
      if (this.lineBased()) return { text, from: sel.from, to: sel.to };
      return { text: text.replace(/;\s*$/, ""), from: sel.from, to: sel.to };
    }
    if (this.lineBased()) {
      const l = redisLinesAt(st.doc.toString(), sel.head, sel.head)[0];
      return l ?? null;
    }
    const s = statementAt(st.doc.toString(), sel.head, splitOptsFor(this.driver));
    return s ? { text: s.text, from: s.start, to: s.end } : null;
  }

  /**
   * Replaces the statement whose trimmed text is `oldText` with `newText` (a trailing `;` stays).
   * With several identical statements the one under the cursor wins, else the first. Returns
   * false (and leaves the document alone) when no statement matches any more.
   */
  replaceStatementText(oldText: string, newText: string): boolean {
    if (this.lineBased()) return false;
    const norm = (x: string): string => x.replace(/\s+/g, " ").trim();
    const want = norm(oldText);
    const all = this.getAllStatements().filter((s) => norm(s.text) === want);
    if (all.length === 0) return false;
    const head = this.view.state.selection.main.head;
    const hit = all.find((s) => head >= s.from && head <= s.to) ?? all[0];
    this.view.dispatch({ changes: { from: hit.from, to: hit.to, insert: newText } });
    return true;
  }

  /** Splits arbitrary text (e.g. a selection) into statements using this editor's dialect. */
  splitText(text: string): string[] {
    if (this.lineBased()) return splitRedisLines(text).map((l) => l.text);
    return splitStatements(text, splitOptsFor(this.driver)).map((s) => s.text);
  }

  getAllStatements(): Runnable[] {
    if (this.lineBased()) return splitRedisLines(this.getText());
    return splitStatements(this.getText(), splitOptsFor(this.driver)).map((s) => ({
      text: s.text,
      from: s.start,
      to: s.end,
    }));
  }

  setSchema(schema: Record<string, string[]>, driver: Driver): void {
    this.schema = schema;
    this.driver = driver;
    this.view.dispatch({ effects: this.lang.reconfigure(this.langExtension()) });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}

// ---- A small plain / JSON text editor (Kafka produce dialog).

const jsonStream = {
  name: "json",
  startState: (): Record<string, never> => ({}),
  token(stream: StreamLike): string | null {
    if (stream.eatSpace()) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"(?=\s*:)/)) return "typeName";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:true|false|null)\b/)) return "keyword";
    stream.next();
    return null;
  },
};

export interface TextEditorOptions {
  doc?: string;
  placeholder?: string;
  onChange?: () => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
}

export class TextEditor {
  private view: EditorView;
  private lang = new Compartment();
  private json = false;

  constructor(parent: HTMLElement, private opts: TextEditorOptions) {
    const onChange = opts.onChange;
    this.view = new EditorView({
      state: EditorState.create({
        doc: opts.doc ?? "",
        extensions: [
          history(),
          drawSelection(),
          closeBrackets(),
          syntaxHighlighting(highlight),
          this.lang.of(this.langExtension()),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          theme,
          EditorView.updateListener.of((u: { docChanged: boolean }) => {
            if (u.docChanged && onChange) onChange();
          }),
        ],
      }),
      parent,
    });
    parent.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          opts.onSubmit?.();
        }
      },
      true,
    );
  }

  private langExtension(): Extension {
    return [...(this.json ? [StreamLanguage.define(jsonStream)] : []), ...(this.opts.placeholder ? [placeholder(this.opts.placeholder)] : [])];
  }

  /** JSON colors on / off (the dialog turns them on while the text parses as JSON). */
  setJson(on: boolean): void {
    if (on === this.json) return;
    this.json = on;
    this.view.dispatch({ effects: this.lang.reconfigure(this.langExtension()) });
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}

// ---- Single-line SQL input for the result filter bar (WHERE / ORDER BY).

export interface FilterInputOptions {
  kind: "where" | "order";
  driver: Driver;
  doc?: string;
  placeholder: string;
  /** Enter or Ctrl/Cmd+Enter. */
  onSubmit: () => void;
  /** Escape (when no completion popup is open). */
  onCancel: () => void;
  onChange: () => void;
}

const filterTheme = EditorView.theme(
  {
    "&": { height: "auto", fontSize: "12.5px" },
    ".cm-scroller": { lineHeight: "24px", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none" },
    ".cm-content": { padding: "0" },
    ".cm-line": { padding: "0 4px 0 8px" },
  },
  { dark: true },
);

export class FilterInput {
  private view: EditorView;
  private lang = new Compartment();
  private driver: Driver;
  private columns: { name: string; type?: string }[] = [];
  private silent = false;

  constructor(parent: HTMLElement, private opts: FilterInputOptions) {
    this.driver = opts.driver;
    this.view = new EditorView({
      state: EditorState.create({
        doc: opts.doc ?? "",
        extensions: [
          history(),
          drawSelection(),
          closeBrackets(),
          syntaxHighlighting(highlight),
          this.lang.of(this.langExtension()),
          // Single line: pasted line breaks become spaces.
          EditorState.transactionFilter.of((tr: { docChanged: boolean; newDoc: { lines: number; toString(): string }; startState: { doc: { length: number } } }) => {
            if (!tr.docChanged || tr.newDoc.lines <= 1) return tr;
            const text = tr.newDoc.toString().replace(/\s*\n\s*/g, " ");
            return [{ changes: { from: 0, to: tr.startState.doc.length, insert: text }, selection: { anchor: text.length } }];
          }),
          // The completion popup's own Enter / Escape bindings run first (highest precedence).
          keymap.of([
            ...closeBracketsKeymap,
            ...historyKeymap,
            { key: "Enter", run: () => (opts.onSubmit(), true) },
            { key: "Mod-Enter", run: () => (opts.onSubmit(), true) },
            { key: "Escape", run: () => (opts.onCancel(), true) },
            ...defaultKeymap,
          ]),
          theme,
          Prec.high(filterTheme),
          EditorView.updateListener.of((u: { docChanged: boolean }) => {
            if (u.docChanged && !this.silent) opts.onChange();
          }),
        ],
      }),
      parent,
    });
    parent.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          opts.onSubmit();
        }
      },
      true,
    );
  }

  private langExtension(): Extension {
    return [
      sql({ dialect: DIALECTS[this.driver as keyof typeof DIALECTS] ?? PostgreSQL, upperCaseKeywords: true }),
      autocompletion({ icons: false, override: [(ctx: CompletionContext) => this.complete(ctx)] }),
      placeholder(this.opts.placeholder),
    ];
  }

  private complete(ctx: CompletionContext): { from: number; options: unknown[]; validFor: RegExp } | null {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    // no completion inside a string literal
    if (((before.match(/'/g) ?? []).length & 1) === 1) return null;
    const m = /(?:"(?:[^"]|"")*|`(?:[^`]|``)*|\[[^\]]*|[\w$\u0080-\uffff]+)$/.exec(before);
    const word = m ? m[0] : "";
    if (word === "" && !ctx.explicit) return null;
    const quoted = /^["`\[]/.test(word);
    const options = filterCompletions(this.opts.kind, this.driver, this.columns, quoted)
      .filter((c) => !quoted || c.kind === "column")
      .map((c) => ({
        label: c.label,
        apply: c.apply,
        type: c.kind === "column" ? "property" : "keyword",
        detail: c.detail,
        boost: c.kind === "column" ? 5 : 0,
      }));
    return { from: ctx.pos - word.length, options, validFor: /^["`\[]?[\w$\u0080-\uffff]*$/ };
  }

  /** Columns offered for completion; also re-applies the dialect. */
  setColumns(columns: { name: string; type?: string }[], driver: Driver): void {
    this.columns = columns;
    if (driver !== this.driver) {
      this.driver = driver;
      this.view.dispatch({ effects: this.lang.reconfigure(this.langExtension()) });
    }
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  /** Replaces the text without reporting a change. */
  setText(text: string): void {
    if (text === this.getText()) return;
    this.silent = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    } finally {
      this.silent = false;
    }
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
