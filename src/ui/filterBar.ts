// The WHERE / ORDER BY bar above a console's result grid (single-table SELECT results only).
// It owns two single-line SQL inputs; the console owns the statement logic and runs it.
import type { Driver } from "../types";
import { FilterInput } from "./editor";
import { h, icon } from "./dom";

const MOD = /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

/** Per-result filter state (kept while the user switches result tabs or console tabs). */
export interface FilterState {
  /** Applied WHERE / ORDER BY (what the grid currently shows). */
  where: string;
  order: string;
  /** What the inputs hold (applied value + unapplied edits). */
  draftWhere: string;
  draftOrder: string;
  /** Error of the last failed apply, shown under the bar. */
  error: string | null;
  columns: { name: string; type?: string }[];
}

export interface FilterBarHooks {
  /** Run the statement with these WHERE / ORDER BY texts. */
  onApply(where: string, order: string): void;
}

export class FilterBar {
  readonly el: HTMLElement;
  private whereIn: FilterInput;
  private orderIn: FilterInput;
  private wherePill: HTMLElement;
  private orderPill: HTMLElement;
  private errEl: HTMLElement;
  private btnApply: HTMLButtonElement;
  private state: FilterState | null = null;

  constructor(driver: Driver, private hooks: FilterBarHooks) {
    const mk = (kind: "where" | "order", label: string, placeholder: string): { pill: HTMLElement; input: FilterInput } => {
      const host = h("div", { class: "fb-cm" });
      const clear = h(
        "button",
        {
          class: "fb-x",
          type: "button",
          title: `Clear ${label} and re-run`,
          "aria-label": `Clear ${label}`,
          tabindex: -1,
          onclick: () => {
            input.setText("");
            this.sync();
            this.apply();
          },
        },
        icon("x", 11),
      );
      const pill = h("div", { class: "fb-pill " + kind, onmousedown: (e: MouseEvent) => {
        if (!(e.target as HTMLElement).closest(".cm-editor, .fb-x")) {
          e.preventDefault();
          input.focus();
        }
      } }, h("span", { class: "fb-lbl" }, label), host, clear);
      const input: FilterInput = new FilterInput(host, {
        kind,
        driver,
        placeholder,
        onSubmit: () => this.apply(),
        onCancel: () => {
          if (!this.state) return;
          input.setText(kind === "where" ? this.state.where : this.state.order);
          this.sync();
        },
        onChange: () => this.sync(),
      });
      return { pill, input };
    };
    const w = mk("where", "WHERE", "e.g. status = 'active' AND amount > 100");
    const o = mk("order", "ORDER BY", "e.g. created_at DESC");
    this.whereIn = w.input;
    this.orderIn = o.input;
    this.wherePill = w.pill;
    this.orderPill = o.pill;
    this.btnApply = h("button", { class: "fb-apply", type: "button", title: `Apply (Enter or ${MOD}Enter)`, onclick: () => this.apply() }, "Apply");
    this.errEl = h("div", { class: "fb-err", role: "alert", hidden: true });
    this.el = h(
      "div",
      { class: "fbar", hidden: true },
      h("div", { class: "fb-row" }, this.wherePill, this.orderPill, this.btnApply),
      this.errEl,
    );
  }

  /** Writes the inputs' texts back into the state and refreshes the clear buttons. */
  private sync(): void {
    const w = this.whereIn.getText();
    const o = this.orderIn.getText();
    if (this.state) {
      this.state.draftWhere = w;
      this.state.draftOrder = o;
    }
    this.wherePill.classList.toggle("has-text", w !== "");
    this.orderPill.classList.toggle("has-text", o !== "");
  }

  private apply(): void {
    if (this.btnApply.disabled) return;
    this.hooks.onApply(this.whereIn.getText(), this.orderIn.getText());
  }

  show(state: FilterState, driver: Driver): void {
    this.state = state;
    this.whereIn.setColumns(state.columns, driver);
    this.orderIn.setColumns(state.columns, driver);
    this.whereIn.setText(state.draftWhere);
    this.orderIn.setText(state.draftOrder);
    this.sync();
    this.setError(state.error);
    this.el.hidden = false;
  }

  hide(): void {
    this.state = null;
    this.el.hidden = true;
  }

  setError(msg: string | null): void {
    this.errEl.hidden = !msg;
    this.errEl.textContent = msg ?? "";
    this.el.classList.toggle("has-err", !!msg);
  }

  setBusy(on: boolean): void {
    this.btnApply.disabled = on;
    this.el.classList.toggle("busy", on);
  }

  focusWhere(): void {
    this.whereIn.focus();
  }

  destroy(): void {
    this.whereIn.destroy();
    this.orderIn.destroy();
  }
}
