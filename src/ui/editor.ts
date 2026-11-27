// ALL CodeMirror usage lives here, behind the small SqlEditor interface.
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import type { Extension, Transaction, TransactionSpec } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, toggleComment, undo } from "@codemirror/commands";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { MSSQL, MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import { splitStatements, statementAt } from "../sqlsplit";
import type { SplitOptions } from "../sqlsplit";
import type { Driver } from "../types";
import { filterCompletions, splitOptionsFor } from "./sqlutil";
import { codeMirrorKey, matchAction, shortcutLabel } from "./keymap";
import { onSettingsChange } from "./settings";
import { REDIS_COMMANDS, redisLinesAt, splitRedisLines } from "./redis";
import { CONSUME_FLAGS, KAFKA_COMMANDS, PRODUCE_FIELDS } from "./kafka";
import { aiEditorExtension } from "./aiEditor";
import { ViewPlugin, hoverTooltip } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";

export interface EditorOptions {
  doc?: string;
  driver: Driver;
  /** Kafka consoles: topic / group names for completion (read lazily on every keystroke). */
  kafkaNames?: () => { topics: string[]; groups: string[] };
  onRun: () => void;
  onRunAll: () => void;
  onChange?: () => void;
  /** The caret / selection moved (restore-on-launch keeps the cursor position). */
  onCursor?: () => void;
  /** Ask AI shortcut (⌘I) pressed in the editor (CodeMirror binds Mod-I itself otherwise). */
  onAskAi?: () => void;
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

const splitOptsFor = splitOptionsFor;

// Syntax colors from the spec (C3): keywords #ff7088, strings #8fd9a8, comments #6e6e76.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: [t.typeName, t.standard(t.name), t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-type)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)" },
  { tag: [t.punctuation, t.operator, t.paren, t.bracket], color: "var(--syn-punct)" },
  { tag: t.special(t.name), color: "var(--syn-number)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--syn-text, var(--text-code))", fontSize: "var(--editor-font-size, 13px)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--editor-font, var(--font-mono))",
      lineHeight: "var(--editor-line-height, 22px)",
      fontVariantLigatures: "var(--editor-ligatures, normal)",
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
    ".cm-lineNumbers .cm-gutterElement": { boxSizing: "border-box", minWidth: "46px", padding: "0 6px 0 8px", textAlign: "right" },
    ".cm-runGutter": { width: "26px" },
    ".cm-runGutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", padding: "0" },
    ".cm-run-active": { backgroundColor: "rgba(255, 255, 255, 0.045)" },
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

// ---- Run gutter: a ▶ on the first line of every statement (one per command line for Redis / Kafka). The
// statement under the caret gets a soft line highlight and an accent-colored ▶.

interface RunStmt {
  text: string;
  from: number;
  /** End of the statement text (terminator excluded). */
  to: number;
  /** End including the terminating `;` (the caret counts as inside up to here). */
  reach: number;
  /** Offset of the start of the statement's first line (the line that carries the ▶). */
  lineFrom: number;
}

interface RunState {
  driver: Driver;
  stmts: RunStmt[];
  byLine: Map<number, number>;
  /** Index into stmts of the statement holding the caret, or -1. */
  active: number;
}

const setRunDriver = StateEffect.define<Driver>();

function computeRunStmts(state: EditorState, driver: Driver): { stmts: RunStmt[]; byLine: Map<number, number> } {
  const doc = state.doc;
  const text = doc.toString();
  const stmts: RunStmt[] = [];
  const byLine = new Map<number, number>();
  const lineBased = driver === "redis" || driver === "kafka";
  const raw: { text: string; from: number; to: number; reach: number }[] = lineBased
    ? splitRedisLines(text).map((l) => ({ text: l.text, from: l.from, to: l.to, reach: l.to }))
    : splitStatements(text, splitOptsFor(driver)).map((x) => ({ text: x.text, from: x.start, to: x.end, reach: x.endWithTerminator }));
  for (const r of raw) {
    const lineFrom = doc.lineAt(r.from).from;
    byLine.set(lineFrom, stmts.length);
    stmts.push({ text: r.text, from: r.from, to: r.to, reach: r.reach, lineFrom });
  }
  return { stmts, byLine };
}

function activeStmt(state: EditorState, stmts: RunStmt[]): number {
  const head = state.selection.main.head;
  const lineEnd = state.doc.lineAt(head).to;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (head < s.from) break;
    if (head <= s.reach || (head <= lineEnd && lineEnd <= s.reach)) return i;
  }
  return -1;
}

function makeRunField(initial: Driver): StateField<RunState> {
  return StateField.define<RunState>({
    create(state: EditorState): RunState {
      const c = computeRunStmts(state, initial);
      return { driver: initial, stmts: c.stmts, byLine: c.byLine, active: activeStmt(state, c.stmts) };
    },
    update(v: RunState, tr: Transaction): RunState {
      let driver = v.driver;
      for (const e of tr.effects) if (e.is(setRunDriver)) driver = e.value;
      if (tr.docChanged || driver !== v.driver) {
        const c = computeRunStmts(tr.state, driver);
        return { driver, stmts: c.stmts, byLine: c.byLine, active: activeStmt(tr.state, c.stmts) };
      }
      if (tr.selection) return { ...v, active: activeStmt(tr.state, v.stmts) };
      return v;
    },
  });
}

class RunMarker extends GutterMarker {
  constructor(private readonly on: boolean) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof RunMarker && other.on === this.on;
  }
  toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-run-btn" + (this.on ? " on" : "");
    el.title = `Run statement ${shortcutLabel("runStatement")} · ${/Mac/.test(navigator.userAgent) ? "⌥" : "Alt+"}click: new result tab`;
    el.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.2v7.6L8.6 5z" fill="currentColor"/></svg>';
    return el;
  }
}
const RUN_OFF = new RunMarker(false);
const RUN_ON = new RunMarker(true);

interface RunHolder {
  cb: ((r: Runnable, opts: { newTab: boolean }) => void) | null;
}

function runGutterExtensions(initial: Driver, holder: RunHolder): Extension {
  const field = makeRunField(initial);
  return [
    field,
    gutter({
      class: "cm-runGutter",
      renderEmptyElements: false,
      lineMarker(view: EditorView, line: { from: number }): GutterMarker | null {
        const st = view.state.field(field);
        const i = st.byLine.get(line.from);
        if (i === undefined) return null;
        return i === st.active ? RUN_ON : RUN_OFF;
      },
      lineMarkerChange: (u: { docChanged: boolean; selectionSet: boolean; transactions: readonly Transaction[] }): boolean =>
        u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(setRunDriver))),
      initialSpacer: (): GutterMarker => RUN_OFF,
      domEventHandlers: {
        mousedown(view: EditorView, line: { from: number }, event: Event): boolean {
          const st = view.state.field(field);
          const i = st.byLine.get(line.from);
          if (i === undefined) return false;
          const s = st.stmts[i];
          event.preventDefault();
          view.dispatch({ selection: { anchor: s.from }, scrollIntoView: true });
          view.focus();
          if (holder.cb) holder.cb({ text: s.text, from: s.from, to: s.to }, { newTab: (event as MouseEvent).altKey });
          return true;
        },
      },
    }),
    EditorView.decorations.compute([field], (state: EditorState) => {
      const st = state.field(field);
      if (st.active < 0) return Decoration.none;
      const s = st.stmts[st.active];
      const deco = Decoration.line({ class: "cm-run-active" });
      const ranges: ReturnType<typeof deco.range>[] = [];
      const last = state.doc.lineAt(Math.min(s.to, state.doc.length)).number;
      for (let n = state.doc.lineAt(s.from).number; n <= last; n++) ranges.push(deco.range(state.doc.line(n).from));
      return Decoration.set(ranges);
    }),
  ];
}

// ---- Cross-source helpers: `alias.` / `alias.schema.` completion, unattached-alias marks with a quick fix.

/** A marked range (an alias-like prefix of a data source that isn't attached); `key` is the alias text. */
export interface FedMark {
  from: number;
  to: number;
  key: string;
}

export interface FedCompletion {
  label: string;
  /** Text inserted instead of the label (quoted names). */
  apply?: string;
  detail?: string;
  type?: string;
  boost?: number;
}

export interface FedHooks {
  /** `path` = the dotted parts before the word being typed (["alias"] or ["alias", "schema"]); null = not ours. */
  complete?(path: string[]): FedCompletion[] | null | Promise<FedCompletion[] | null>;
  /** Ranges to underline in the whole document. */
  marks?(doc: string): FedMark[];
  /** Hover card of a mark (quick actions). */
  tooltip?(m: FedMark): HTMLElement;
}

interface FedHolder {
  hooks: FedHooks | null;
  current: FedMark[];
}

const refreshFed = StateEffect.define<null>();
const FED_MARK = Decoration.mark({ class: "cm-fed-unattached" });

function fedExtensions(holder: FedHolder): Extension {
  const build = (view: EditorView): DecorationSet => {
    const hk = holder.hooks;
    holder.current = [];
    if (!hk?.marks || view.state.doc.length > 500_000) return Decoration.none;
    const ms = hk.marks(view.state.doc.toString()).filter((m) => m.from < m.to && m.to <= view.state.doc.length);
    holder.current = ms;
    return Decoration.set(
      ms.map((m) => FED_MARK.range(m.from, m.to)),
      true,
    );
  };
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.transactions.some((tr: Transaction) => tr.effects.some((e) => e.is(refreshFed)))) this.decorations = build(u.view);
      }
    },
    { decorations: (v: { decorations: DecorationSet }) => v.decorations },
  );
  const tip = hoverTooltip((_view: EditorView, pos: number) => {
    const m = holder.current.find((x) => pos >= x.from && pos <= x.to);
    const make = holder.hooks?.tooltip;
    if (!m || !make) return null;
    return { pos: m.from, end: m.to, above: true, create: () => ({ dom: make(m) }) };
  });
  const source = (ctx: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> => {
    const complete = holder.hooks?.complete;
    if (!complete) return null;
    const m = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*\.(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z0-9_]*$/);
    if (!m || (m.from > 0 && ctx.state.sliceDoc(m.from - 1, m.from) === ".")) return null;
    const parts = m.text.split(".");
    const word = parts[parts.length - 1];
    const finish = (opts: FedCompletion[] | null): CompletionResult | null =>
      opts && opts.length ? { from: ctx.pos - word.length, options: opts as Completion[], validFor: /^[A-Za-z0-9_]*$/ } : null;
    const res = complete(parts.slice(0, -1));
    return res instanceof Promise ? res.then(finish, () => null) : finish(res);
  };
  return [plugin, tip, EditorState.languageData.of(() => [{ autocomplete: source }])];
}

export class SqlEditor {
  private view: EditorView;
  private lang = new Compartment();
  private driver: Driver;
  private schema: Record<string, string[]> = {};
  private kafkaNames: () => { topics: string[]; groups: string[] };
  private runHolder: RunHolder = { cb: null };
  private keys = new Compartment();
  private offSettings: (() => void) | null = null;
  private fedHolder: FedHolder = { hooks: null, current: [] };

  constructor(parent: HTMLElement, opts: EditorOptions) {
    this.driver = opts.driver;
    this.kafkaNames = opts.kafkaNames ?? (() => ({ topics: [], groups: [] }));
    const onChange = opts.onChange;
    const onCursor = opts.onCursor;
    const extensions: Extension[] = [
      lineNumbers(),
      runGutterExtensions(opts.driver, this.runHolder),
      aiEditorExtension(),
      fedExtensions(this.fedHolder),
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
      this.keys.of(this.keymapExtension()),
      theme,
      EditorView.updateListener.of((u: { docChanged: boolean; selectionSet: boolean }) => {
        if (u.docChanged && onChange) onChange();
        if ((u.selectionSet || u.docChanged) && onCursor) onCursor();
      }),
    ];
    this.view = new EditorView({
      state: EditorState.create({ doc: opts.doc ?? "", extensions }),
      parent,
    });
    // Shortcuts follow the keymap settings (preset + overrides).
    this.offSettings = onSettingsChange(() => this.view.dispatch({ effects: this.keys.reconfigure(this.keymapExtension()) }));
    // Capture on the container so the run shortcuts win over CodeMirror's own bindings.
    parent.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Only keys typed in the editor itself (not in the AI prompt box floating over it).
        if (e.target instanceof Node && !this.view.dom.contains(e.target)) return;
        const a = matchAction(e);
        if (a === "runStatement" || a === "runAll") {
          e.preventDefault();
          e.stopPropagation();
          if (a === "runAll") opts.onRunAll();
          else opts.onRun();
        } else if (a === "askAi" && opts.onAskAi) {
          e.preventDefault();
          e.stopPropagation();
          opts.onAskAi();
        }
      },
      true,
    );
  }

  /** CodeMirror keymap: the editor-handled actions of the app keymap (comment, find, undo, redo) + the defaults. */
  private keymapExtension(): Extension {
    const bind = (id: "toggleComment" | "find" | "undo" | "redo", run: (v: EditorView) => boolean): { key: string; run: (v: EditorView) => boolean; preventDefault: boolean }[] => {
      const key = codeMirrorKey(id);
      return key ? [{ key, run, preventDefault: true }] : [];
    };
    return [
      Prec.high(
        keymap.of([
          ...bind("toggleComment", toggleComment),
          ...bind("find", openSearchPanel),
          ...bind("undo", undo),
          ...bind("redo", redo),
        ]),
      ),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    ];
  }

  /**
   * Clicking a gutter ▶ moves the caret into that statement and calls `cb` with it (`newTab`: Alt/Option-click,
   * run into a new result tab).
   */
  onRunStatement(cb: (r: Runnable, opts: { newTab: boolean }) => void): void {
    this.runHolder.cb = cb;
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

  /**
   * Inserts `text` as a statement of its own: replaces a selection, otherwise goes on a new line
   * at the cursor (`atEnd`: after the last line), terminating the previous statement and this one
   * with `;` in SQL consoles so the two never run together. The caret ends inside the new statement.
   */
  insertStatement(text: string, atEnd = false): void {
    const st = this.view.state;
    const sel = st.selection.main;
    const doc = st.doc.toString();
    const lineBased = this.lineBased();
    let body = text.trim();
    if (!body) return;
    if (!lineBased && !body.endsWith(";")) body += ";";
    const back = lineBased ? 0 : 1; // caret lands before the trailing ";"
    if (!atEnd && !sel.empty) {
      this.view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: body },
        selection: { anchor: sel.from + body.length - back },
        scrollIntoView: true,
        userEvent: "input",
      });
      return;
    }
    // Where to insert: the end of the document, the cursor when it sits on an empty line, or
    // else right after the statement (SQL) / line (Redis, Kafka) under the cursor.
    let pos = atEnd ? doc.length : sel.head;
    if (!atEnd && st.doc.lineAt(pos).text.trim() !== "") {
      pos = st.doc.lineAt(pos).to;
      if (!lineBased) {
        const cur = statementAt(doc, sel.head, splitOptsFor(this.driver));
        if (cur && sel.head >= cur.start && sel.head <= cur.endWithTerminator) {
          pos = Math.max(cur.endWithTerminator, st.doc.lineAt(cur.endWithTerminator).to);
        }
      }
    }
    const changes: { from: number; to: number; insert: string }[] = [];
    const tail = doc.slice(0, pos).trimEnd();
    let prefix = "";
    let shift = 0;
    if (tail) {
      // Close an unterminated previous statement (not when it ends in a line comment).
      const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
      if (!lineBased && !tail.endsWith(";") && !lastLine.includes("--")) {
        changes.push({ from: tail.length, to: tail.length, insert: ";" });
        shift = 1;
      }
      const lineSoFar = doc.slice(doc.lastIndexOf("\n", pos - 1) + 1, pos);
      if (lineSoFar.trim()) prefix = lineBased ? "\n" : "\n\n";
    }
    const rest = doc.slice(pos);
    const suffix = rest.length > 0 && !/^[ \t]*(\n|$)/.test(rest) ? "\n" : "";
    changes.push({ from: pos, to: pos, insert: prefix + body + suffix });
    this.view.dispatch({
      changes,
      selection: { anchor: pos + shift + prefix.length + body.length - back },
      scrollIntoView: true,
      userEvent: "input",
    });
  }

  undo(): boolean {
    return undo(this.view);
  }

  redo(): boolean {
    return redo(this.view);
  }

  /** Caret offset (head of the main selection). */
  get cursor(): number {
    return this.view.state.selection.main.head;
  }

  /** Puts the caret at `pos` (clamped to the document) and scrolls it into view. */
  setCursor(pos: number): void {
    const p = Math.max(0, Math.min(this.view.state.doc.length, Math.floor(pos) || 0));
    this.view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
  }

  /**
   * What Format SQL works on: the selection (surrounding whitespace excluded), else the statement at the
   * cursor (its terminating `;` excluded, so it stays). Null for Redis / Kafka consoles or nothing there.
   */
  formatTarget(): { from: number; to: number; text: string } | null {
    if (this.lineBased()) return null;
    const st = this.view.state;
    const sel = st.selection.main;
    if (!sel.empty) {
      const raw = st.sliceDoc(sel.from, sel.to);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (!text) return null;
      return { from: sel.from + lead, to: sel.from + lead + text.length, text };
    }
    const s = statementAt(st.doc.toString(), sel.head, splitOptsFor(this.driver));
    return s ? { from: s.start, to: s.end, text: s.text } : null;
  }

  /** Replaces [from, to) with `text` as one undoable step and selects the replacement's end. */
  replaceRange(from: number, to: number, text: string): void {
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
      userEvent: "input.format",
      annotations: isolateHistory.of("full"),
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

  /** The CodeMirror view, for the AI assistant (aiPanel.ts / aiEditor.ts). */
  get cmView(): EditorView {
    return this.view;
  }

  setSchema(schema: Record<string, string[]>, driver: Driver): void {
    this.schema = schema;
    this.driver = driver;
    this.view.dispatch({ effects: [this.lang.reconfigure(this.langExtension()), setRunDriver.of(driver)] });
  }

  focus(): void {
    this.view.focus();
  }

  /** Cross-source completion / unattached-alias marks (null = off). */
  setFedHooks(hooks: FedHooks | null): void {
    this.fedHolder.hooks = hooks;
    this.refreshFedMarks();
  }

  /** Recomputes the cross-source marks (attached sources changed). */
  refreshFedMarks(): void {
    this.view.dispatch({ effects: refreshFed.of(null) });
  }

  /** Document offset under a viewport point (drops), or null outside the text. */
  posAtCoords(x: number, y: number): number | null {
    return this.view.posAtCoords({ x, y });
  }

  /** Inserts `text` at `pos` (a drop) as its own undo step, caret after it. */
  insertAt(pos: number, text: string): void {
    const p = Math.max(0, Math.min(this.view.state.doc.length, pos));
    this.view.dispatch({
      changes: { from: p, to: p, insert: text },
      selection: { anchor: p + text.length },
      scrollIntoView: true,
      userEvent: "input.drop",
      annotations: isolateHistory.of("full"),
    });
    this.view.focus();
  }

  destroy(): void {
    this.offSettings?.();
    this.offSettings = null;
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
          EditorState.transactionFilter.of((tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
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

  private complete(ctx: CompletionContext): CompletionResult | null {
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
      .map((c): Completion => ({
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
