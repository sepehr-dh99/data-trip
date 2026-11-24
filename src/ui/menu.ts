import { h, icon } from "./dom";

export interface MenuItem {
  label?: string;
  icon?: string;
  /** Radio-style item: shows a check mark in the icon slot when true. */
  checked?: boolean;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  onClick?: () => void;
}

export interface MenuOptions {
  /** Open upwards: `y` is the bottom edge of the menu instead of its top. */
  above?: boolean;
  /** Minimum width in px (e.g. the width of the anchoring button). */
  minWidth?: number;
  /** Called after the menu closed for any reason. */
  onClose?: () => void;
}

let current: HTMLElement | null = null;
let currentCleanup: (() => void) | null = null;

export function closeMenu(): void {
  if (current) {
    current.remove();
    current = null;
  }
  const c = currentCleanup;
  currentCleanup = null;
  c?.();
}

export function isMenuOpen(): boolean {
  return current !== null;
}

export function showMenu(x: number, y: number, items: MenuItem[], opts: MenuOptions = {}): void {
  closeMenu();
  const menu = h("div", { class: "ctx-menu", role: "menu" });
  if (opts.minWidth) menu.style.minWidth = opts.minWidth + "px";
  const buttons: HTMLButtonElement[] = [];
  for (const it of items) {
    if (it.sep) {
      menu.appendChild(h("div", { class: "ctx-sep", role: "separator" }));
      continue;
    }
    const lead = it.checked !== undefined ? (it.checked ? icon("check", 15) : h("span", { class: "ico", style: "width:15px" })) : it.icon ? icon(it.icon, 15) : h("span", { class: "ico", style: "width:15px" });
    const row = h(
      "button",
      {
        class: "ctx-item" + (it.danger ? " danger" : "") + (it.checked ? " checked" : ""),
        type: "button",
        role: it.checked !== undefined ? "menuitemradio" : "menuitem",
        "aria-checked": it.checked !== undefined ? String(it.checked) : undefined,
        disabled: it.disabled === true,
      },
      lead,
      h("span", { class: "ctx-label" }, it.label ?? ""),
      it.hint ? h("span", { class: "ctx-hint" }, it.hint) : null,
    );
    row.addEventListener("click", () => {
      closeMenu();
      it.onClick?.();
    });
    buttons.push(row);
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const top = opts.above ? y - r.height : y;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8)) + "px";
  if (opts.above) menu.classList.add("above");
  current = menu;
  const away = (e: Event): void => {
    if (current && e.target instanceof Node && current.contains(e.target)) return;
    closeMenu();
  };
  const keys = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      if (!enabled.length) return;
      const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const n = e.key === "ArrowDown" ? (i + 1) % enabled.length : (i - 1 + enabled.length) % enabled.length;
      enabled[n].focus();
    }
  };
  currentCleanup = (): void => {
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", keys, true);
    window.removeEventListener("blur", away);
    opts.onClose?.();
  };
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", keys, true);
  window.addEventListener("blur", away);
}
