// Shared two-pane "profiles manager" dialog shell (Vault profiles, SSH configurations).
import { clear, h, icon } from "./dom";

export interface PmItem {
  id: string;
  name: string;
  /** Small second line (token status, host…). */
  sub?: string;
  /** Tone of the sub line. */
  tone?: "ok" | "warn" | "bad" | "idle";
  color?: string | null;
}

export interface PmShell {
  overlay: HTMLElement;
  /** Editor pane. */
  editor: HTMLElement;
  /** Left slot of the footer (delete). */
  footLeft: HTMLElement;
  btnSave: HTMLButtonElement;
  btnClose: HTMLButtonElement;
  close(): void;
  setList(items: PmItem[], selected: string): void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClosed: () => void;
}

export function createPmShell(title: string, iconName: string, newLabel: string, ariaLabel: string): PmShell {
  const list = h("div", { class: "pm-list", role: "listbox", "aria-label": ariaLabel });
  const newBtn = h("button", { class: "pm-new", type: "button" }, icon("plus", 14), newLabel);
  const editor = h("div", { class: "pm-editor" });
  const footLeft = h("div", { class: "pm-foot-left" });
  const btnSave = h("button", { class: "btn primary", type: "button" }, "Save");
  const btnClose = h("button", { class: "btn ghost", type: "button" }, "Close");
  const overlay = h("div", { class: "overlay" });
  const shell: PmShell = {
    overlay,
    editor,
    footLeft,
    btnSave,
    btnClose,
    onSelect: () => undefined,
    onNew: () => undefined,
    onClosed: () => undefined,
    close() {
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
      shell.onClosed();
    },
    setList(items, selected) {
      clear(list);
      for (const it of items) {
        const row = h(
          "button",
          { class: "pm-item" + (it.id === selected ? " on" : ""), type: "button", role: "option", "aria-selected": String(it.id === selected) },
          h("span", { class: "pm-dot", style: `--pc:${it.color ?? "#8e8e93"}`, "aria-hidden": "true" }),
          h("span", { class: "pm-item-main" }, h("span", { class: "pm-item-name" }, it.name || "Untitled"), it.sub ? h("span", { class: "pm-item-sub " + (it.tone ?? "idle") }, it.sub) : null),
        );
        row.addEventListener("click", () => shell.onSelect(it.id));
        list.appendChild(row);
      }
      if (items.length === 0) list.appendChild(h("div", { class: "pm-empty" }, "Nothing here yet."));
    },
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || document.querySelector(".vault-pop, .ctx-menu")) return;
    const open = document.querySelectorAll(".overlay:not(.leaving)");
    if (open[open.length - 1] !== overlay) return;
    e.stopPropagation();
    shell.close();
  };
  newBtn.onclick = () => shell.onNew();
  btnClose.onclick = () => shell.close();
  overlay.appendChild(
    h(
      "div",
      { class: "dialog pm-dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
      h(
        "div",
        { class: "dialog-head" },
        h("div", { class: "dialog-title" }, icon(iconName, 18), title),
        h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: () => shell.close() }, icon("x", 16)),
      ),
      h("div", { class: "pm-body" }, h("div", { class: "pm-side" }, list, newBtn), editor),
      h("div", { class: "dialog-foot" }, footLeft, h("div", { class: "spacer" }), btnClose, btnSave),
    ),
  );
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) shell.close();
  });
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  return shell;
}
