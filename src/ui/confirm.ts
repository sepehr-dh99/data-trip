import { h, icon } from "./dom";

export function confirmDialog(title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "overlay" });
    const done = (v: boolean): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") done(true);
    };
    const ok = h("button", { class: "btn " + (danger ? "danger-solid" : "primary"), type: "button", onclick: () => done(true) }, okLabel);
    overlay.appendChild(
      h(
        "div",
        { class: "dialog small", role: "alertdialog", "aria-modal": "true" },
        h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon("alert", 18), title)),
        h("div", { class: "dialog-body" }, h("p", { class: "confirm-text" }, text)),
        h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: () => done(false) }, "Cancel"), ok),
      ),
    );
    document.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    ok.focus();
  });
}
