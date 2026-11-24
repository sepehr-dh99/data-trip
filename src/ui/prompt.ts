import { h, icon } from "./dom";

/** Small glass prompt for a single line of text. Resolves with the trimmed value, or null when cancelled. */
export interface PromptOptions {
  icon?: string;
  /** Small explanatory line under the input. */
  hint?: string;
  /** Returns an error text to keep the dialog open, or null when the value is fine. */
  validate?: (v: string) => string | null;
}

export function promptDialog(title: string, label: string, initial = "", okLabel = "Save", suggestions: string[] = [], opts: PromptOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "overlay" });
    const listId = "dt-prompt-" + Math.random().toString(36).slice(2, 7);
    const input = h("input", { class: "input", type: "text", value: initial, spellcheck: false, "aria-label": label });
    if (suggestions.length) input.setAttribute("list", listId);
    const done = (v: string | null): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(v);
    };
    const errEl = h("div", { class: "prompt-err", role: "alert" });
    const submit = (): void => {
      const v = input.value.trim();
      const bad = v && opts.validate ? opts.validate(v) : null;
      if (bad) {
        errEl.textContent = bad;
        input.focus();
      } else if (v) done(v);
      else input.focus();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    };
    overlay.appendChild(
      h(
        "div",
        { class: "dialog small prompt", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon(opts.icon ?? "folder", 18), title)),
        h(
          "div",
          { class: "dialog-body" },
          h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, opts.hint ? h("span", { class: "vault-hint" }, opts.hint) : null),
          errEl,
          suggestions.length ? h("datalist", { id: listId }, suggestions.map((s) => h("option", { value: s }))) : null,
        ),
        h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: () => done(null) }, "Cancel"), h("button", { class: "btn primary", type: "button", onclick: submit }, okLabel)),
      ),
    );
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) done(null);
    });
    document.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    input.focus();
    input.select();
  });
}
