import { h, icon } from "./dom";

export interface MenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  onClick?: () => void;
}

let current: HTMLElement | null = null;

export function closeMenu(): void {
  if (current) {
    current.remove();
    current = null;
  }
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = h("div", { class: "ctx-menu", role: "menu" });
  for (const it of items) {
    if (it.sep) {
      menu.appendChild(h("div", { class: "ctx-sep" }));
      continue;
    }
    const row = h(
      "button",
      { class: "ctx-item" + (it.danger ? " danger" : ""), type: "button", role: "menuitem", disabled: it.disabled === true },
      it.icon ? icon(it.icon, 15) : h("span", { class: "ico", style: "width:15px" }),
      h("span", null, it.label ?? ""),
    );
    row.addEventListener("click", () => {
      closeMenu();
      it.onClick?.();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  current = menu;
  const away = (e: Event): void => {
    if (current && e.target instanceof Node && current.contains(e.target)) return;
    closeMenu();
    cleanup();
  };
  const esc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      closeMenu();
      cleanup();
    }
  };
  const cleanup = (): void => {
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", esc, true);
    window.removeEventListener("blur", away);
  };
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", esc, true);
  window.addEventListener("blur", away);
}
