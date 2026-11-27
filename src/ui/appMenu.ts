// The app menu. macOS: the native menu bar (built in src-tauri/src/lib.rs, same ids) sends a Tauri event "menu"
// with the item id. Windows / Linux: no native menu bar; the ☰ button at the left of the console tab bar opens the
// same structure as an in-app two-level dropdown. Both end up in App.runCommand(id).
import { listen } from "@tauri-apps/api/event";
import { showMenu } from "./menu";
import type { MenuItem } from "./menu";

export const IS_MAC = /Mac/.test(navigator.userAgent);

/** Ids of the custom menu items (native menu ids in lib.rs must match). */
export type MenuCommand =
  | "about"
  | "settings"
  | "keyboardShortcuts"
  | "newConnection"
  | "newConsole"
  | "newCrossSource"
  | "importDataGrip"
  | "vaultProfiles"
  | "sshProfiles"
  | "reopenTab"
  | "closeTab"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "find"
  | "tabsTop"
  | "tabsLeft"
  | "tabsRight"
  | "toggleSidebar"
  | "compactExplorer"
  | "queryHistory"
  | "commandPalette"
  | "runStatement"
  | "runAll"
  | "cancel"
  | "formatSql"
  | "askAi"
  | "attachSource"
  | "reconnect"
  | "nextTab"
  | "prevTab"
  | "jumpToTab"
  | "crossSourceGuide"
  | "helpShortcuts"
  | "helpPalette"
  | "checkUpdates";

export interface AppMenuEntry {
  id?: MenuCommand;
  label?: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  sep?: boolean;
}

export interface AppMenuSection {
  label: string;
  items: AppMenuEntry[];
}

/** Listens for native menu clicks (macOS). Harmless elsewhere and outside Tauri (dev preview). */
export function listenNativeMenu(run: (id: string) => void): void {
  try {
    void listen<string>("menu", (e) => run(String(e.payload))).catch(() => undefined);
  } catch {
    // not running inside Tauri
  }
}

/**
 * In-app menu (Windows / Linux): a dropdown of the menu titles; picking one opens its items in place
 * (a second-level dropdown; its first row goes back to the titles).
 */
export function showAppMenu(anchor: HTMLElement, sections: AppMenuSection[], run: (id: MenuCommand) => void): void {
  const r = anchor.getBoundingClientRect();
  const x = r.left;
  const y = r.bottom + 6;
  const openSection = (s: AppMenuSection): void => {
    const items: MenuItem[] = [
      { label: "‹ " + s.label, onClick: () => window.setTimeout(top, 0) },
      { sep: true },
      ...s.items.map((it): MenuItem => (it.sep ? { sep: true } : { label: it.label, hint: it.hint, checked: it.checked, disabled: it.disabled, onClick: () => it.id && run(it.id) })),
    ];
    showMenu(x, y, items, { minWidth: 260 });
  };
  const top = (): void => {
    showMenu(
      x,
      y,
      sections.map((s) => ({ label: s.label, hint: "▸", onClick: () => window.setTimeout(() => openSection(s), 0) })),
      { minWidth: 200 },
    );
  };
  top();
}
