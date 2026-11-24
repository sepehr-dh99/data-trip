// ALL CodeMirror usage lives here, behind the small SqlEditor interface.
import { Compartment, EditorState } from "@codemirror/state";
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
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { MSSQL, MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import { splitStatements, statementAt } from "../sqlsplit";
import type { SplitOptions } from "../sqlsplit";
import type { Driver } from "../types";

export interface EditorOptions {
  doc?: string;
  driver: Driver;
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
    ".cm-line": { padding: "0 20px 0 0" },
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

  constructor(parent: HTMLElement, opts: EditorOptions) {
    this.driver = opts.driver;
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
      autocompletion({ icons: false }),
      highlightSelectionMatches(),
      syntaxHighlighting(highlight),
      placeholder("Write SQL here — Ctrl/Cmd+Enter runs the statement at the cursor."),
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
    return sql({
      dialect: DIALECTS[this.driver],
      schema: this.schema,
      upperCaseKeywords: true,
    });
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
      return { text: text.replace(/;\s*$/, ""), from: sel.from, to: sel.to };
    }
    const s = statementAt(st.doc.toString(), sel.head, splitOptsFor(this.driver));
    return s ? { text: s.text, from: s.start, to: s.end } : null;
  }

  /** Splits arbitrary text (e.g. a selection) into statements using this editor's dialect. */
  splitText(text: string): string[] {
    return splitStatements(text, splitOptsFor(this.driver)).map((s) => s.text);
  }

  getAllStatements(): Runnable[] {
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
