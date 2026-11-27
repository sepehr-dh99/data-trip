// Confirmation dialog of v0.16 (board W): Cancel query / Kill session (with the exact command) and the production
// write confirmation (statement kind, table, filter, estimated rows, warning, statement, optional typed name).
import { h } from "./dom";
import "../styles/ops.css";

export interface OpsConfirmRow {
  k: string;
  v: string;
  tone?: "accent" | "warn" | "danger";
}

export interface OpsConfirmOptions {
  title: string;
  text?: string;
  rows?: OpsConfirmRow[];
  /** Red notice (no WHERE, data removed permanently…). */
  warn?: string;
  /** The exact SQL that will run. */
  sql?: string;
  /** Require typing this name before the OK button works. */
  typeName?: string;
  /** Accessible label of the typed-name field (default "Type the data source name"). */
  typeLabel?: string;
  okLabel: string;
  cancelLabel?: string;
  /** Accent of the ring / icon (production color); default the danger red. */
  color?: string;
  /** A row value that is filled in later (estimated rows): resolves to the text, or null to drop the row. */
  lateRow?: { k: string; value: Promise<string | null>; tone?: OpsConfirmRow["tone"] };
}

/** Shows the dialog; true = OK. Esc / Cancel / click outside = false. */
export function opsConfirm(o: OpsConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "overlay" });
    const color = o.color ?? "#ff453a";
    let finished = false;
    const done = (v: boolean): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(v);
    };
    const typed = o.typeName
      ? h("input", { class: "input oc-type", type: "text", spellcheck: false, autocomplete: "off", placeholder: o.typeName, "aria-label": o.typeLabel ?? "Type the data source name" })
      : null;
    const ok = h("button", { class: "btn danger-solid oc-ok", type: "button", onclick: () => tryOk() }, o.okLabel);
    const typedOk = (): boolean => !typed || typed.value === o.typeName;
    const sync = (): void => {
      ok.disabled = !typedOk();
      if (typed) {
        typed.classList.toggle("bad", typed.value !== "" && !typedOk());
        typed.classList.toggle("good", typedOk());
      }
    };
    const tryOk = (): void => {
      if (typedOk()) done(true);
      else typed?.focus();
    };
    typed?.addEventListener("input", sync);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        tryOk();
      }
    };
    const grid = h("div", { class: "oc-rows" });
    for (const r of o.rows ?? []) grid.append(h("span", { class: "oc-k" }, r.k), h("span", { class: "oc-v mono" + (r.tone ? " " + r.tone : "") }, r.v));
    if (o.lateRow) {
      const late = o.lateRow;
      const k = h("span", { class: "oc-k" }, late.k);
      const v = h("span", { class: "oc-v mono muted" }, "estimating…");
      grid.append(k, v);
      void late.value.then(
        (text) => {
          if (text === null) {
            k.remove();
            v.remove();
          } else {
            v.textContent = text;
            v.className = "oc-v mono" + (late.tone ? " " + late.tone : "");
          }
        },
        () => {
          k.remove();
          v.remove();
        },
      );
    }
    const dlg = h(
      "div",
      { class: "dialog small ops-confirm", role: "alertdialog", "aria-modal": "true", "aria-label": o.title, style: `--oc:${color}` },
      h("div", { class: "oc-head" }, h("span", { class: "oc-ic", "aria-hidden": "true" }, "!"), h("span", { class: "oc-title" }, o.title)),
      o.text ? h("div", { class: "oc-text" }, o.text) : null,
      grid.childElementCount ? grid : null,
      o.warn ? h("div", { class: "oc-warn" }, o.warn) : null,
      o.sql ? h("pre", { class: "oc-sql mono" }, o.sql) : null,
      typed ? h("label", { class: "oc-typed" }, h("span", null, "Type ", h("b", null, o.typeName ?? ""), " to confirm"), typed) : null,
      h("div", { class: "oc-foot" }, h("button", { class: "btn ghost", type: "button", onclick: () => done(false) }, o.cancelLabel ?? "Cancel"), ok),
    );
    overlay.append(dlg);
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) done(false);
    });
    document.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    sync();
    if (typed) typed.focus();
    else ok.focus();
  });
}
