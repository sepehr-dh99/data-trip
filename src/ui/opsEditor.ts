// CodeMirror additions of v0.16 for SQL consoles: parameter tokens highlighted (board U) and snippets (board W) —
// expansion of an abbreviation with Tab (or Enter / Space, Settings › Snippets) when completion isn't open, snippet
// items in completion, placeholders as snippet fields ($TABLE / $COLUMN complete tables / columns inside the field).
import { EditorState, Prec, StateField } from "@codemirror/state";
import type { Extension, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { acceptCompletion, completionStatus, hasNextSnippetField, hasPrevSnippetField, selectedCompletion, snippet, startCompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Driver } from "../types";
import { splitStatements } from "../sqlsplit";
import { splitOptionsFor } from "./sqlutil";
import { scanParams } from "./params";
import { abbrBefore, effectiveSnippets, findSnippet, snippetPreview, snippetTemplate, snippetsFor } from "./snippets";
import type { ExpandKey, Snippet } from "./snippets";
import { getSettings } from "./settings";

export interface OpsEditorHost {
  driver(): Driver;
  /** Table names for $TABLE completion (default schema bare, others qualified). */
  tables(): string[];
  /** Column names of the tables the statement at `pos` reads / writes ($COLUMN completion). */
  columns(state: EditorState, pos: number): string[];
}

// ---------------------------------------------------------------- parameter highlighting

const PARAM_MARK = Decoration.mark({ class: "cm-sql-param" });

function paramDecorations(state: EditorState, driver: Driver): DecorationSet {
  if (driver === "redis" || driver === "kafka" || state.doc.length > 300_000) return Decoration.none;
  const text = state.doc.toString();
  const ranges: ReturnType<typeof PARAM_MARK.range>[] = [];
  for (const st of splitStatements(text, splitOptionsFor(driver))) {
    for (const t of scanParams(st.text, driver)) ranges.push(PARAM_MARK.range(st.start + t.from, st.start + t.to));
  }
  return Decoration.set(ranges, true);
}

function paramHighlight(host: OpsEditorHost): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      driver: Driver;
      constructor(view: EditorView) {
        this.driver = host.driver();
        this.decorations = paramDecorations(view.state, this.driver);
      }
      update(u: ViewUpdate): void {
        const d = host.driver();
        if (u.docChanged || d !== this.driver) {
          this.driver = d;
          this.decorations = paramDecorations(u.state, d);
        }
      }
    },
    { decorations: (v: { decorations: DecorationSet }) => v.decorations },
  );
  const look = EditorView.baseTheme({
    ".cm-sql-param": {
      color: "#ff9aab",
      backgroundColor: "rgba(255, 26, 60, 0.18)",
      boxShadow: "inset 0 0 0 1px rgba(255, 26, 60, 0.45)",
      borderRadius: "4px",
    },
    ".cm-snippetField": { backgroundColor: "rgba(255, 26, 60, 0.18)", boxShadow: "inset 0 0 0 1px rgba(255, 26, 60, 0.55)", borderRadius: "4px" },
  });
  return [plugin, look];
}

// ---------------------------------------------------------------- snippets

/** Text that the latest typing replaced (select `orders`, type `sel` + Tab → $SELECTION = orders). */
const replacedSelection = StateField.define<{ from: number; text: string } | null>({
  create: (): { from: number; text: string } | null => null,
  update(v: { from: number; text: string } | null, tr: Transaction): { from: number; text: string } | null {
    if (tr.docChanged && tr.isUserEvent("input.type")) {
      const s = tr.startState.selection.main;
      if (!s.empty) return { from: s.from, text: tr.startState.sliceDoc(s.from, s.to) };
    }
    if (v && tr.docChanged) return { from: tr.changes.mapPos(v.from, -1), text: v.text };
    return v;
  },
});

function currentSnippets(driver: Driver): Snippet[] {
  return snippetsFor(effectiveSnippets(getSettings().snippets), driver);
}

/** Inserts `sn` over [from, to) as a CodeMirror snippet; opens table / column completion where it helps. */
export function applySnippet(view: EditorView, sn: Snippet, from: number, to: number): void {
  const rep = view.state.field(replacedSelection, false);
  const sel = rep && rep.from === from ? rep.text : "";
  const info = snippetTemplate(sn.body, sel, new Date());
  snippet(info.template)(view, null, from, to);
  if (info.firstIsTable || info.firstIsColumn || info.cursorAfterTableKeyword) {
    window.setTimeout(() => {
      if (view.dom.isConnected) startCompletion(view);
    }, 0);
  }
}

/** Expands the abbreviation before the caret; false when there is none. */
function expandAtCaret(view: EditorView, driver: Driver): boolean {
  const st = view.state;
  const sel = st.selection.main;
  if (!sel.empty || st.selection.ranges.length > 1) return false;
  const line = st.doc.lineAt(sel.head);
  const a = abbrBefore(line.text, sel.head - line.from);
  if (!a) return false;
  const sn = findSnippet(currentSnippets(driver), a.word);
  if (!sn) return false;
  applySnippet(view, sn, line.from + a.from, sel.head);
  return true;
}

function snippetKeys(host: OpsEditorHost): Extension {
  const run =
    (key: ExpandKey) =>
    (view: EditorView): boolean => {
      const driver = host.driver();
      if (driver === "redis" || driver === "kafka") return false;
      if (completionStatus(view.state) !== null) {
        // completion open: Tab expands a selected snippet item; everything else is the completion's
        if (key === "tab" && selectedCompletion(view.state)?.type === "dt-snippet") return acceptCompletion(view);
        return false;
      }
      if (getSettings().snippets.expandKey !== key) return false;
      return expandAtCaret(view, driver);
    };
  return Prec.high(
    keymap.of([
      { key: "Tab", run: run("tab") },
      { key: "Enter", run: run("enter") },
      { key: "Space", run: run("space") },
    ]),
  );
}

function snippetCompletions(host: OpsEditorHost): Extension {
  const source = (ctx: CompletionContext): CompletionResult | null => {
    const driver = host.driver();
    const s = getSettings().snippets;
    // inside a $TABLE / $COLUMN placeholder: tables / columns, unfiltered (the placeholder text is selected)
    const sel = ctx.state.selection.main;
    if (!sel.empty && (hasNextSnippetField(ctx.state) || hasPrevSnippetField(ctx.state))) {
      const t = ctx.state.sliceDoc(sel.from, sel.to);
      if (t === "table" || t === "column") {
        const names = t === "table" ? host.tables() : host.columns(ctx.state, sel.from);
        if (!names.length) return null;
        return {
          from: sel.from,
          to: sel.to,
          filter: false,
          options: names.slice(0, 400).map((n, i): Completion => ({ label: n, type: t === "table" ? "type" : "property", detail: t, boost: -i / 1000 })),
        };
      }
    }
    if (!s.inCompletion) return null;
    const list = snippetsFor(effectiveSnippets(s), driver);
    if (!list.length) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const a = abbrBefore(line.text, ctx.pos - line.from);
    if (!a && !ctx.explicit) return null;
    const word = a?.word ?? "";
    const from = a ? line.from + a.from : ctx.pos;
    const options = list
      .filter((sn) => !word || sn.abbr.toLowerCase().startsWith(word.slice(0, 1).toLowerCase()))
      .map(
        (sn): Completion => ({
          label: sn.abbr,
          detail: "{} " + (sn.name || "snippet"),
          type: "dt-snippet",
          boost: sn.abbr === word ? 60 : 2,
          info: snippetPreview(sn.body),
          apply: (view: EditorView, _c: Completion, f: number, t: number) => applySnippet(view, sn, f, t),
        }),
      );
    if (!options.length) return null;
    return { from, options, validFor: /^[A-Za-z0-9_]*$/ };
  };
  // languageData sources are merged with the SQL language's own completion (autocompletion() without override)
  return [replacedSelection, EditorState.languageData.of(() => [{ autocomplete: source }])];
}

/** Everything v0.16 adds to the SQL console editor. */
export function opsEditorExtension(host: OpsEditorHost): Extension {
  return [paramHighlight(host), snippetKeys(host), snippetCompletions(host)];
}
