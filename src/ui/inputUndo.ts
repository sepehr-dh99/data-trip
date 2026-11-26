/**
 * Undo/redo for plain <input>/<textarea> fields.
 *
 * WebKit (macOS, Linux) keeps one undo stack per document and drops it whenever a script sets
 * `.value`, so Ctrl/Cmd+Z in a dialog field often does nothing after you click elsewhere and
 * come back. This keeps a small stack per field instead: typing is grouped into words/bursts,
 * focus changes and programmatic changes start a new step, and Mod+Z / Mod+Shift+Z / Ctrl+Y
 * walk it. CodeMirror editors keep their own history and are left alone.
 */

interface Snap {
  value: string;
  start: number;
  end: number;
}

interface Stack {
  undo: Snap[];
  redo: Snap[];
  /** The value after the last change we saw (detects script-made changes). */
  last: string;
  lastTime: number;
  lastKind: string;
}

const GROUP_MS = 800;
const MAX_STEPS = 200;
const stacks = new WeakMap<HTMLInputElement | HTMLTextAreaElement, Stack>();
let applying = false;

const TEXT_TYPES = /^(text|search|url|email|tel|password|number|)$/;

function field(t: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (t instanceof HTMLTextAreaElement) return t.closest(".cm-editor") ? null : t;
  if (t instanceof HTMLInputElement && TEXT_TYPES.test(t.type)) return t;
  return null;
}

function snap(el: HTMLInputElement | HTMLTextAreaElement): Snap {
  let start = el.value.length;
  let end = start;
  try {
    start = el.selectionStart ?? start;
    end = el.selectionEnd ?? end;
  } catch {
    /* type=number/email have no selection API */
  }
  return { value: el.value, start, end };
}

function stackFor(el: HTMLInputElement | HTMLTextAreaElement): Stack {
  let s = stacks.get(el);
  if (!s) {
    s = { undo: [], redo: [], last: el.value, lastTime: 0, lastKind: "" };
    stacks.set(el, s);
  }
  return s;
}

function push(s: Stack, v: Snap): void {
  s.undo.push(v);
  if (s.undo.length > MAX_STEPS) s.undo.shift();
}

function kindOf(inputType: string): string {
  if (inputType.startsWith("delete")) return "delete";
  if (inputType === "insertText") return "type";
  return inputType || "other";
}

function onBeforeInput(e: Event): void {
  if (applying) return;
  const el = field(e.target);
  if (!el) return;
  const s = stackFor(el);
  const ie = e as InputEvent;
  const kind = kindOf(ie.inputType ?? "");
  const now = Date.now();
  const scripted = el.value !== s.last;
  const breakWord = kind === "type" && typeof ie.data === "string" && /\s/.test(ie.data) && s.lastKind === "type";
  const newStep =
    scripted || now - s.lastTime > GROUP_MS || kind !== s.lastKind || (kind !== "type" && kind !== "delete") || breakWord || s.undo.length === 0;
  if (scripted && s.last !== el.value) {
    // A script changed the value since our last snapshot: keep the old value reachable too.
    push(s, { value: s.last, start: s.last.length, end: s.last.length });
  }
  if (newStep) push(s, snap(el));
  s.redo = [];
  s.lastKind = kind;
}

function onInput(e: Event): void {
  if (applying) return;
  const el = field(e.target);
  if (!el) return;
  const s = stackFor(el);
  s.last = el.value;
  s.lastTime = Date.now();
}

function onFocus(e: Event): void {
  const el = field(e.target);
  if (!el) return;
  const s = stackFor(el);
  // Coming back to a field always starts a new undo step.
  s.lastTime = 0;
  if (el.value !== s.last) {
    push(s, { value: s.last, start: s.last.length, end: s.last.length });
    s.last = el.value;
    s.redo = [];
  }
}

function apply(el: HTMLInputElement | HTMLTextAreaElement, v: Snap): void {
  applying = true;
  try {
    el.value = v.value;
    try {
      el.setSelectionRange(v.start, v.end);
    } catch {
      /* no selection API for this input type */
    }
    // Let dialogs re-validate / mirror the field exactly as if the user had typed it.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } finally {
    applying = false;
  }
  const s = stackFor(el);
  s.last = el.value;
  s.lastTime = 0;
  s.lastKind = "";
}

function onKey(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== "z" && k !== "y") return;
  const el = field(e.target);
  if (!el || el.readOnly || el.disabled) return;
  const s = stackFor(el);
  const isRedo = k === "y" || e.shiftKey;
  e.preventDefault();
  e.stopPropagation();
  if (el.value !== s.last) {
    // Script-made change since the last snapshot: treat it as a step of its own.
    push(s, { value: s.last, start: s.last.length, end: s.last.length });
    s.redo = [];
    s.last = el.value;
  }
  if (isRedo) {
    const next = s.redo.pop();
    if (!next) return;
    push(s, snap(el));
    apply(el, next);
  } else {
    let prev = s.undo.pop();
    while (prev && prev.value === el.value) prev = s.undo.pop();
    if (!prev) return;
    s.redo.push(snap(el));
    apply(el, prev);
  }
}

let installed = false;

/** Installs the document-wide listeners once (capture phase, before dialog key handlers). */
export function installInputUndo(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("focusin", onFocus, true);
  window.addEventListener("keydown", onKey, true);
}
