// "Run with parameters" popover (v0.16, board U): one row per parameter (inferred column / type, text · number · date,
// value, NULL toggle, validation), "Remember values for this console", Cancel Esc / Run ⌘↵. Anchored under the
// statement in the console's editor.
import type { EditorView } from "@codemirror/view";
import { h } from "./dom";
import { validateParam } from "./params";
import type { ParamInfo, ParamKind, ParamValue } from "./params";
import { shortcutLabel } from "./keymap";
import "../styles/ops.css";

export interface ParamsAsk {
  wrap: HTMLElement;
  view: EditorView;
  /** Doc offset the popover sits under (end of the statement). */
  anchor: number;
  /** "statement on lines 2–7 · named parameters". */
  subtitle: string;
  params: ParamInfo[];
  /** Initial values (remembered / last used). */
  values: Record<string, ParamValue>;
  remember: boolean;
  /** "last used 10 min ago" (shown next to the checkbox), or "". */
  rememberNote: string;
  /** Run button label ("Run" / "Explain"). */
  action: string;
}

export interface ParamsAnswer {
  values: Record<string, ParamValue>;
  remember: boolean;
}

let openBox: { close: () => void } | null = null;

/** Closes an open popover (console switched / disposed). */
export function closeParamsPopover(): void {
  openBox?.close();
}

/** Opens the popover; resolves with the values (Run) or null (Cancel / Esc / click elsewhere). */
export function askParams(o: ParamsAsk): Promise<ParamsAnswer | null> {
  closeParamsPopover();
  return new Promise((resolve) => {
    const values: Record<string, ParamValue> = {};
    for (const p of o.params) values[p.key] = { ...(o.values[p.key] ?? { kind: p.kind, value: "", isNull: false }) };
    let remember = o.remember;
    const rows: { p: ParamInfo; input: HTMLInputElement; err: HTMLElement; ring: HTMLElement; sync: () => void }[] = [];

    const runBtn = h("button", { class: "btn primary sm pp-run", type: "button" }, o.action, h("span", { class: "pp-kbd" }, shortcutLabel("runStatement") || "⌘↵"));
    const valid = (): boolean => o.params.every((p) => validateParam(values[p.key], p.columnType) === "");
    const syncRun = (): void => {
      runBtn.disabled = !valid();
    };

    const list = h("div", { class: "pp-rows" });
    for (const p of o.params) {
      const v = values[p.key];
      const input = h("input", {
        class: "pp-input mono",
        type: "text",
        spellcheck: false,
        autocomplete: "off",
        "aria-label": `${p.label} value`,
        value: v.isNull ? "" : v.value,
      });
      const ring = h("label", { class: "pp-field" }, input);
      const err = h("div", { class: "pp-err", hidden: true });
      const kinds: [ParamKind, string][] = [
        ["text", "text"],
        ["number", "number"],
        ["date", "date"],
      ];
      const segBtns = kinds.map(([k, label]) =>
        h("button", {
          class: "seg-btn",
          type: "button",
          role: "radio",
          onclick: () => {
            values[p.key].kind = k;
            sync();
          },
        }, label),
      );
      const nullBtn = h("button", {
        class: "pp-null mono",
        type: "button",
        "aria-pressed": "false",
        title: "Use NULL",
        onclick: () => {
          values[p.key].isNull = !values[p.key].isNull;
          sync();
          if (!values[p.key].isNull) input.focus();
        },
      }, "NULL");
      const sync = (): void => {
        const cur = values[p.key];
        kinds.forEach(([k], i) => {
          segBtns[i].classList.toggle("on", cur.kind === k);
          segBtns[i].setAttribute("aria-checked", String(cur.kind === k));
        });
        input.disabled = cur.isNull;
        input.placeholder = cur.isNull ? "NULL" : cur.kind === "date" ? "YYYY-MM-DD" : cur.kind === "number" ? "0" : "text";
        if (cur.isNull) input.value = "";
        nullBtn.classList.toggle("on", cur.isNull);
        nullBtn.setAttribute("aria-pressed", String(cur.isNull));
        // show errors only once something was typed (or for a non-empty invalid value)
        const msg = validateParam(cur, p.columnType);
        const show = msg !== "" && (cur.value !== "" || input.dataset.touched === "1");
        err.textContent = show ? msg : "";
        err.hidden = !show;
        ring.classList.toggle("bad", show);
        syncRun();
      };
      input.addEventListener("input", () => {
        values[p.key].value = input.value;
        input.dataset.touched = "1";
        sync();
      });
      rows.push({ p, input, err, ring, sync });
      list.append(
        h(
          "div",
          { class: "pp-row" },
          h("div", { class: "pp-name" }, h("span", { class: "pp-label mono" }, p.label), h("span", { class: "pp-hint", title: p.hint }, p.hint || "no column found")),
          h("div", { class: "seg pp-seg", role: "radiogroup", "aria-label": "Type" }, segBtns),
          ring,
          nullBtn,
        ),
        err,
      );
    }

    const remBox = h("span", { class: "pp-check", "aria-hidden": "true" });
    const remBtn = h("button", { class: "pp-remember", type: "button", role: "checkbox", "aria-checked": String(remember) }, remBox, "Remember values for this console");
    const syncRem = (): void => {
      remBtn.setAttribute("aria-checked", String(remember));
      remBox.textContent = remember ? "✓" : "";
      remBox.classList.toggle("on", remember);
    };
    remBtn.addEventListener("click", () => {
      remember = !remember;
      syncRem();
    });
    syncRem();

    const box = h(
      "div",
      { class: "pp-box", role: "dialog", "aria-label": "Query parameters" },
      h("div", { class: "pp-arrow", "aria-hidden": "true" }),
      h(
        "div",
        { class: "pp-head" },
        h("span", { class: "pp-title" }, "Run with parameters"),
        h("span", { class: "pp-sub" }, o.subtitle),
        h("div", { class: "spacer" }),
        h("button", { class: "pp-x", type: "button", "aria-label": "Close", onclick: () => done(null) }, "✕"),
      ),
      list,
      h(
        "div",
        { class: "pp-foot" },
        remBtn,
        h("span", { class: "pp-note" }, o.rememberNote),
        h("div", { class: "spacer" }),
        h("button", { class: "btn ghost sm", type: "button", onclick: () => done(null) }, "Cancel", h("span", { class: "pp-kbd" }, "Esc")),
        runBtn,
      ),
    );

    let finished = false;
    const done = (ans: ParamsAnswer | null): void => {
      if (finished) return;
      finished = true;
      openBox = null;
      window.removeEventListener("pointerdown", onDown, true);
      o.view.scrollDOM.removeEventListener("scroll", place);
      box.remove();
      resolve(ans);
      if (ans === null) o.view.focus();
    };
    const run = (): void => {
      for (const r of rows) r.input.dataset.touched = "1";
      rows.forEach((r) => r.sync());
      if (!valid()) {
        rows.find((r) => !r.err.hidden)?.input.focus();
        return;
      }
      done({ values, remember });
    };
    runBtn.addEventListener("click", run);
    box.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        // ↵ in a field and ⌘↵ anywhere run
        e.preventDefault();
        e.stopPropagation();
        run();
      }
    });
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && !box.contains(e.target)) done(null);
    };

    function place(): void {
      // fixed to the viewport: the editor pane clips its overflow, the box may float over the results
      const wrapRect = o.wrap.getBoundingClientRect();
      const pos = Math.min(o.anchor, o.view.state.doc.length);
      const line = o.view.state.doc.lineAt(pos);
      const c = o.view.coordsAtPos(line.to) ?? o.view.coordsAtPos(line.from);
      const content = o.view.contentDOM.getBoundingClientRect();
      const left = Math.max(8, Math.min(content.left + 24, window.innerWidth - box.offsetWidth - 8, wrapRect.right - box.offsetWidth - 8));
      box.style.left = left + "px";
      const hgt = box.offsetHeight;
      const anchorBottom = c ? Math.min(c.bottom, wrapRect.bottom) : wrapRect.top + 8;
      let top = anchorBottom + 8;
      box.classList.remove("above");
      if (top + hgt > window.innerHeight - 8 && c && c.top - hgt - 8 > 8) {
        top = c.top - hgt - 8;
        box.classList.add("above");
      }
      box.style.top = Math.max(8, Math.min(top, window.innerHeight - hgt - 8)) + "px";
    }

    document.body.appendChild(box);
    rows.forEach((r) => r.sync());
    place();
    o.view.scrollDOM.addEventListener("scroll", place);
    window.setTimeout(() => window.addEventListener("pointerdown", onDown, true), 0);
    openBox = { close: () => done(null) };
    const first = rows.find((r) => !values[r.p.key].isNull && values[r.p.key].value === "") ?? rows[0];
    first?.input.focus();
    first?.input.select();
  });
}

/** "last used 10 min ago" / "last used yesterday" for a timestamp (ms), or "". */
export function lastUsedNote(at: number): string {
  if (!at) return "";
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return "last used just now";
  if (min < 60) return `last used ${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `last used ${hr} h ago`;
  const d = Math.round(hr / 24);
  return d === 1 ? "last used yesterday" : `last used ${d} days ago`;
}
