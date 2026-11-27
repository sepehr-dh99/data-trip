// CodeMirror side of the AI assistant: a pending AI insertion / fix diff shown in the editor before it is
// accepted. (editor.ts keeps the rest of the CodeMirror setup; this file only adds the AI extension.)
//
// The pending text is really inserted into the document, but outside the undo history, so it gets line numbers,
// syntax colors and the run gutter like any other text. Lines are tinted (purple for a new statement, green /
// red-struck for a fix) with a +/− marker in the line-number gutter and a block widget below with the action bar.
// Accept removes the pending text (no history) and applies the final change as ONE isolated undo step; Reject
// removes it without a trace in the history. Nothing is ever executed.
import { Prec, RangeSet, StateEffect, StateField, Transaction } from "@codemirror/state";
import type { ChangeDesc, ChangeSet, EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutterLineClass, keymap } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { statementAt } from "../sqlsplit";
import type { SplitOptions } from "../sqlsplit";

/** The action bar under a pending insertion (rendered by aiPanel.ts). */
export interface AiBarModel {
  /** Fresh DOM for the bar (CodeMirror may re-create a widget's DOM when it scrolls back into view). */
  render(): HTMLElement;
  accept(): void;
  reject(): void;
}

/** A range of pending (inserted, not yet accepted) text. `body*` = the part that is tinted. */
interface Seg {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  /** Not tinted (e.g. a `;` that terminates the previous statement). */
  silent: boolean;
}

export interface AiPending {
  kind: "insert" | "diff";
  added: Seg[];
  /** diff: original lines that the fix removes (struck out). */
  removed: { from: number; to: number }[];
  /** diff: the statement range the replacement goes into on Accept. */
  target: { from: number; to: number } | null;
  replacement: string;
  model: AiBarModel;
}

const setPending = StateEffect.define<AiPending | null>();

function mapPending(p: AiPending, ch: ChangeDesc): AiPending {
  const m = (pos: number, assoc: number): number => ch.mapPos(pos, assoc);
  const added = p.added.map((s) => {
    const from = m(s.from, 1);
    const to = Math.max(from, m(s.to, -1));
    const bodyFrom = Math.min(Math.max(m(s.bodyFrom, 1), from), to);
    const bodyTo = Math.max(bodyFrom, Math.min(m(s.bodyTo, -1), to));
    return { from, to, bodyFrom, bodyTo, silent: s.silent };
  });
  const removed = p.removed.map((r) => {
    const from = m(r.from, 1);
    return { from, to: Math.max(from, m(r.to, -1)) };
  });
  const target = p.target ? { from: m(p.target.from, -1), to: m(p.target.to, 1) } : null;
  return { ...p, added, removed, target };
}

const pendingField = StateField.define<AiPending | null>({
  create: (): AiPending | null => null,
  update(v: AiPending | null, tr: Transaction): AiPending | null {
    let next = v;
    if (next && tr.docChanged) next = mapPending(next, tr.changes);
    for (const e of tr.effects) if (e.is(setPending)) next = e.value;
    return next;
  },
});

class BarWidget extends WidgetType {
  constructor(readonly model: AiBarModel) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof BarWidget && other.model === this.model;
  }
  toDOM(): HTMLElement {
    return this.model.render();
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class AiGutterClass extends GutterMarker {
  constructor(readonly cls: string) {
    super();
    this.elementClass = cls;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof AiGutterClass && other.cls === this.cls;
  }
}
const G_ADD = new AiGutterClass("cm-ai-g-add");
const G_DIFF_ADD = new AiGutterClass("cm-ai-g-add cm-ai-g-diff");
const G_DEL = new AiGutterClass("cm-ai-g-del");

/** Line starts of every line touched by [from, to]. */
function lineStarts(state: EditorState, from: number, to: number): number[] {
  const doc = state.doc;
  const a = doc.lineAt(Math.min(from, doc.length)).number;
  const b = doc.lineAt(Math.min(Math.max(from, to), doc.length)).number;
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(doc.line(n).from);
  return out;
}

function addedLines(state: EditorState, p: AiPending): number[] {
  const out: number[] = [];
  for (const s of p.added) if (!s.silent && s.bodyTo > s.bodyFrom) out.push(...lineStarts(state, s.bodyFrom, s.bodyTo));
  return out;
}

function removedLines(state: EditorState, p: AiPending): number[] {
  const out: number[] = [];
  for (const r of p.removed) out.push(...lineStarts(state, r.from, r.to));
  return out;
}

/** End of the last tinted line: the action bar goes below it. */
function barPos(state: EditorState, p: AiPending): number {
  let pos = -1;
  for (const s of p.added) if (!s.silent && s.bodyTo > s.bodyFrom) pos = Math.max(pos, s.bodyTo);
  for (const r of p.removed) pos = Math.max(pos, r.to);
  if (pos < 0) pos = p.added.length ? p.added[p.added.length - 1].to : 0;
  return state.doc.lineAt(Math.min(pos, state.doc.length)).to;
}

function decorations(state: EditorState): DecorationSet {
  const p = state.field(pendingField, false);
  if (!p) return Decoration.none;
  const add = Decoration.line({ class: p.kind === "diff" ? "cm-ai-add cm-ai-diff" : "cm-ai-add" });
  const del = Decoration.line({ class: "cm-ai-del" });
  const ranges: ReturnType<typeof add.range>[] = [];
  for (const at of addedLines(state, p)) ranges.push(add.range(at));
  for (const at of removedLines(state, p)) ranges.push(del.range(at));
  ranges.push(Decoration.widget({ widget: new BarWidget(p.model), block: true, side: 1 }).range(barPos(state, p)));
  return Decoration.set(ranges, true);
}

function gutterClasses(state: EditorState): RangeSet<GutterMarker> {
  const p = state.field(pendingField, false);
  if (!p) return RangeSet.empty;
  const mark = p.kind === "diff" ? G_DIFF_ADD : G_ADD;
  const ranges: ReturnType<typeof mark.range>[] = [];
  for (const at of addedLines(state, p)) ranges.push(mark.range(at));
  for (const at of removedLines(state, p)) ranges.push(G_DEL.range(at));
  return RangeSet.of(ranges, true);
}

/** The extension every SQL console editor carries (inactive until something is pending). */
export function aiEditorExtension(): Extension {
  return [
    pendingField,
    EditorView.decorations.compute([pendingField], decorations),
    gutterLineClass.compute([pendingField], gutterClasses),
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: (v: EditorView): boolean => {
            const p = v.state.field(pendingField, false);
            if (!p) return false;
            p.model.accept();
            return true;
          },
        },
        {
          key: "Escape",
          run: (v: EditorView): boolean => {
            const p = v.state.field(pendingField, false);
            if (!p) return false;
            p.model.reject();
            return true;
          },
        },
      ]),
    ),
  ];
}

// ---------------------------------------------------------------- queries

export function pendingOf(state: EditorState): AiPending | null {
  return state.field(pendingField, false) ?? null;
}

function removal(state: EditorState, p: AiPending): ChangeSet {
  return state.changes(p.added.filter((s) => s.to > s.from).map((s) => ({ from: s.from, to: s.to })));
}

/** The document without pending AI text (what restore-on-launch should save). */
export function docWithoutPending(state: EditorState): string {
  const p = pendingOf(state);
  if (!p) return state.doc.toString();
  return removal(state, p).apply(state.doc).toString();
}

/** The pending SQL as it would be inserted (insert) or the replacement (diff); null when nothing is pending. */
export function pendingText(state: EditorState): string | null {
  const p = pendingOf(state);
  if (!p) return null;
  if (p.kind === "diff") return p.replacement;
  const main = p.added.filter((s) => !s.silent);
  return main.map((s) => state.sliceDoc(s.bodyFrom, s.bodyTo)).join("\n");
}

// ---------------------------------------------------------------- show / accept / reject

/** Removes pending text without history and returns the change set that did it (null when nothing pending). */
function dropPending(view: EditorView): { p: AiPending; cs: ChangeSet } | null {
  const p = pendingOf(view.state);
  if (!p) return null;
  const cs = removal(view.state, p);
  view.dispatch({ changes: cs, effects: setPending.of(null), annotations: Transaction.addToHistory.of(false) });
  return { p, cs };
}

/** Rejects: the pending text disappears, the document and its undo history are as before. */
export function rejectPending(view: EditorView): boolean {
  return dropPending(view) !== null;
}

/** Rejects a pending fix and returns where its statement now is (to show a refined fix there), else null. */
export function rejectKeepTarget(view: EditorView): { from: number; to: number } | null {
  const dropped = dropPending(view);
  const t = dropped?.p.target;
  if (!dropped || !t) return null;
  const from = dropped.cs.mapPos(t.from, -1);
  return { from, to: Math.max(from, dropped.cs.mapPos(t.to, 1)) };
}

/** Accepts: applies the insertion / fix as one isolated undo step. Returns false when nothing was pending. */
export function acceptPending(view: EditorView): boolean {
  const before = view.state;
  const p = pendingOf(before);
  if (!p) return false;
  if (p.kind === "insert") {
    // Re-inserting the same text at the same places leaves the document exactly as shown.
    const pieces = p.added.filter((s) => s.to > s.from).map((s) => ({ at: s.from, text: before.sliceDoc(s.from, s.to) }));
    const main = p.added.filter((s) => !s.silent);
    const caret = main.length ? main[main.length - 1].bodyTo : before.selection.main.head;
    const dropped = dropPending(view);
    if (!dropped) return false;
    // pieces at the same position (a `;` right before the block) become one insert, in order
    const changes: { from: number; insert: string }[] = [];
    for (const x of pieces) {
      const at2 = dropped.cs.mapPos(x.at, -1);
      const last = changes[changes.length - 1];
      if (last && last.from === at2) last.insert += x.text;
      else changes.push({ from: at2, insert: x.text });
    }
    view.dispatch({
      changes,
      selection: { anchor: Math.min(caret, before.doc.length) },
      scrollIntoView: true,
      userEvent: "input.ai",
      annotations: isolateHistory.of("full"),
    });
    return true;
  }
  const target = p.target;
  const dropped = dropPending(view);
  if (!dropped || !target) return dropped !== null;
  const from = dropped.cs.mapPos(target.from, -1);
  const to = Math.max(from, dropped.cs.mapPos(target.to, 1));
  view.dispatch({
    changes: { from, to, insert: p.replacement },
    selection: { anchor: from + p.replacement.length },
    scrollIntoView: true,
    userEvent: "input.ai",
    annotations: isolateHistory.of("full"),
  });
  return true;
}

/**
 * Shows `sql` as a pending new statement after the statement under the cursor (or at the cursor when it sits on
 * an empty line), like SqlEditor.insertStatement places it. An unterminated previous statement gets a pending `;`.
 */
export function showInsertion(view: EditorView, sql: string, split: SplitOptions, model: AiBarModel): void {
  rejectPending(view);
  const st = view.state;
  const doc = st.doc.toString();
  const sel = st.selection.main;
  let body = sql.trim();
  if (!body) return;
  if (!/;\s*$/.test(body) && !/--[^\n]*$/.test(body)) body += ";";
  const head = sel.empty ? sel.head : sel.to;
  let pos = head;
  if (st.doc.lineAt(pos).text.trim() !== "") {
    pos = st.doc.lineAt(pos).to;
    const cur = statementAt(doc, head, split);
    if (cur && head >= cur.start && head <= cur.endWithTerminator) pos = Math.max(cur.endWithTerminator, st.doc.lineAt(cur.endWithTerminator).to);
  } else {
    pos = st.doc.lineAt(pos).from;
  }
  const specs: { from: number; insert: string; seg: Omit<Seg, "from" | "to"> & { off: number; len: number } }[] = [];
  const tail = doc.slice(0, pos).trimEnd();
  let prefix = "";
  if (tail) {
    const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
    if (!tail.endsWith(";") && !lastLine.includes("--")) {
      specs.push({ from: tail.length, insert: ";", seg: { bodyFrom: 0, bodyTo: 0, silent: true, off: 0, len: 1 } });
    }
    const lineSoFar = doc.slice(doc.lastIndexOf("\n", pos - 1) + 1, pos);
    prefix = lineSoFar.trim() ? "\n\n" : "";
  }
  const rest = doc.slice(pos);
  const suffix = rest.length > 0 && !/^[ \t]*(\n|$)/.test(rest) ? "\n" : "";
  const text = prefix + body + suffix;
  specs.push({ from: pos, insert: text, seg: { bodyFrom: 0, bodyTo: 0, silent: false, off: prefix.length, len: body.length } });
  const cs = st.changes(specs.map((s) => ({ from: s.from, insert: s.insert })));
  // Specs are in document order (the `;` may share the position of the block): place them by hand.
  let shift = 0;
  const added: Seg[] = specs.map((s) => {
    const from = s.from + shift;
    shift += s.insert.length;
    return { from, to: from + s.insert.length, bodyFrom: from + s.seg.off, bodyTo: from + s.seg.off + s.seg.len, silent: s.seg.silent };
  });
  const main = added[added.length - 1];
  view.dispatch({
    changes: cs,
    effects: [setPending.of({ kind: "insert", added, removed: [], target: null, replacement: body, model }), EditorView.scrollIntoView(main.bodyTo, { y: "nearest" })],
    annotations: Transaction.addToHistory.of(false),
  });
}

type Op = { t: "eq"; o: number } | { t: "del"; o: number } | { t: "add"; s: string };

/** Line diff (LCS on trimmed-right lines); falls back to "replace everything" for huge inputs. */
function lineDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) return [...a.map((_, o): Op => ({ t: "del", o })), ...b.map((s): Op => ({ t: "add", s }))];
  const A = a.map((x) => x.trimEnd());
  const B = b.map((x) => x.trimEnd());
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ t: "eq", o: i });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: "del", o: i++ });
    else ops.push({ t: "add", s: b[j++] });
  }
  while (i < n) ops.push({ t: "del", o: i++ });
  while (j < m) ops.push({ t: "add", s: b[j++] });
  return ops;
}

/**
 * Shows a fix of the statement at [from, to) as a diff: removed lines struck out in red, added lines in green right
 * after them. Returns false (and shows nothing) when the replacement equals the original.
 */
export function showDiff(view: EditorView, from: number, to: number, replacement: string, model: AiBarModel): boolean {
  rejectPending(view);
  const st = view.state;
  const oldText = st.sliceDoc(from, to);
  if (oldText.trim() === replacement.trim()) return false;
  const oldLines = oldText.split("\n");
  const starts: number[] = [];
  const ends: number[] = [];
  let at = from;
  for (const l of oldLines) {
    starts.push(at);
    ends.push(at + l.length);
    at += l.length + 1;
  }
  const ops = lineDiff(oldLines, replacement.split("\n"));
  const inserts: { pos: number; text: string; bodyOff: number; bodyLen: number }[] = [];
  const removed: { from: number; to: number }[] = [];
  let dels: number[] = [];
  let adds: string[] = [];
  let nextOld = 0;
  const flush = (): void => {
    if (dels.length) for (const d of dels) removed.push({ from: starts[d], to: ends[d] });
    if (adds.length) {
      const body = adds.join("\n");
      if (dels.length) inserts.push({ pos: ends[dels[dels.length - 1]], text: "\n" + body, bodyOff: 1, bodyLen: body.length });
      else if (nextOld === 0) inserts.push({ pos: starts[0], text: body + "\n", bodyOff: 0, bodyLen: body.length });
      else inserts.push({ pos: ends[nextOld - 1], text: "\n" + body, bodyOff: 1, bodyLen: body.length });
    }
    dels = [];
    adds = [];
  };
  for (const op of ops) {
    if (op.t === "eq") {
      flush();
      nextOld = op.o + 1;
    } else if (op.t === "del") {
      if (adds.length && !dels.length) flush();
      dels.push(op.o);
      nextOld = op.o + 1;
    } else adds.push(op.s);
  }
  flush();
  const cs = st.changes(inserts.map((x) => ({ from: x.pos, insert: x.text })));
  let shift = 0;
  const added: Seg[] = inserts.map((x) => {
    const f = x.pos + shift;
    shift += x.text.length;
    return { from: f, to: f + x.text.length, bodyFrom: f + x.bodyOff, bodyTo: f + x.bodyOff + x.bodyLen, silent: false };
  });
  const removedNew = removed.map((r) => ({ from: cs.mapPos(r.from, 1), to: cs.mapPos(r.to, -1) }));
  const target = { from: cs.mapPos(from, -1), to: cs.mapPos(to, 1) };
  const last = Math.max(target.from, ...added.map((s) => s.bodyTo), ...removedNew.map((r) => r.to));
  view.dispatch({
    changes: cs,
    effects: [setPending.of({ kind: "diff", added, removed: removedNew, target, replacement, model }), EditorView.scrollIntoView(last, { y: "nearest" })],
    annotations: Transaction.addToHistory.of(false),
  });
  return true;
}

/** Re-renders the action bar (its model changed, e.g. the explanation arrived). */
export function refreshBar(view: EditorView): void {
  view.requestMeasure();
}
