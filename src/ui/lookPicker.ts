// "Color & icon…" popover: 12 colors + the built-in icon set for a folder or a data source. Changes apply live.
import type { Driver } from "../types";
import { DRIVER_LABELS } from "../types";
import { h, icon } from "./dom";
import { COLORS, DRIVER_ABBR, ICONS, svgIcon, svgMarkup } from "./icons";
import { DRIVER_COLORS } from "./sqlutil";

export interface LookTarget {
  folder: boolean;
  name: () => string;
  /** Present for data sources (abbreviation + default color + kind line). */
  driver?: Driver;
  color: () => string | null;
  icon: () => string | null;
  set: (patch: { color?: string | null; icon?: string | null }) => void;
}

export interface LookAnchor {
  x: number;
  y: number;
}

let closeCurrent: (() => void) | null = null;

export function closeLookPicker(): void {
  closeCurrent?.();
}

export function openLookPicker(t: LookTarget, anchor: LookAnchor, onClose?: () => void): void {
  closeLookPicker();
  const pop = h("div", { class: "look-pop", role: "dialog", "aria-label": "Color and icon", tabindex: "-1" });
  const prevBadge = h("span", { class: "look-prev" });
  const prevName = h("div", { class: "look-name" });
  const prevKind = h("div", { class: "look-kind" }, t.folder ? "Folder" : `Data source · ${t.driver ? DRIVER_LABELS[t.driver].split(" / ")[0] : ""}`);

  const swatchBtns: { c: string | null; el: HTMLButtonElement }[] = [];
  const mkSwatch = (label: string, c: string | null): HTMLButtonElement => {
    const b = h("button", {
      class: "look-sw" + (c === null ? " default" : ""),
      type: "button",
      title: label,
      "aria-label": label,
      "aria-pressed": "false",
      style: c ? `background:${c}` : undefined,
      onclick: () => {
        t.set({ color: c });
        refresh();
      },
    });
    swatchBtns.push({ c, el: b });
    return b;
  };
  const swatches = h("div", { class: "look-swatches" }, mkSwatch("Default", null), ...COLORS.map(([n, c]) => mkSwatch(n, c)));

  const iconBtns: { name: string; el: HTMLButtonElement }[] = [];
  const grid = h(
    "div",
    { class: "look-grid" },
    ICONS.map(([name, d]) => {
      void d;
      const b = h("button", {
        class: "look-ic",
        type: "button",
        title: name,
        "aria-label": name,
        "aria-pressed": "false",
        onclick: () => {
          t.set({ icon: name });
          refresh();
        },
      });
      b.innerHTML = svgMarkup(name, 17, "currentColor", 2);
      iconBtns.push({ name, el: b });
      return b;
    }),
  );
  const empty = h("div", { class: "look-empty", hidden: true }, "No icons match");
  const search = h("input", {
    type: "search",
    placeholder: "Search icons",
    "aria-label": "Search icons",
    spellcheck: false,
    oninput: () => {
      const q = search.value.trim().toLowerCase();
      let n = 0;
      for (const b of iconBtns) {
        const show = !q || b.name.includes(q);
        b.el.hidden = !show;
        if (show) n++;
      }
      empty.hidden = n > 0;
    },
  });

  const refresh = (): void => {
    const color = t.color();
    const ic = t.icon();
    prevName.textContent = t.name();
    prevBadge.className = "look-prev" + (t.folder ? " folder" : "");
    prevBadge.replaceChildren();
    if (t.folder) {
      prevBadge.style.background = "";
      prevBadge.appendChild(svgIcon(ic && ICONS.some(([n]) => n === ic) ? ic : "folder", 16, color ?? "#c8c8ce", 2.2));
    } else {
      prevBadge.style.background = color ?? (t.driver ? DRIVER_COLORS[t.driver] : "#555");
      if (ic && ICONS.some(([n]) => n === ic)) prevBadge.appendChild(svgIcon(ic, 16, "#fff", 2.2));
      else prevBadge.textContent = t.driver ? DRIVER_ABBR[t.driver] : "";
    }
    for (const s of swatchBtns) {
      const on = s.c === null ? !color : color?.toLowerCase() === s.c.toLowerCase();
      s.el.classList.toggle("on", on);
      s.el.setAttribute("aria-pressed", String(on));
    }
    for (const b of iconBtns) {
      const on = ic === b.name;
      b.el.classList.toggle("on", on);
      b.el.setAttribute("aria-pressed", String(on));
    }
  };

  const done = h("button", { class: "look-done", type: "button", onclick: () => close() }, "Done");
  pop.append(
    h(
      "div",
      { class: "look-head" },
      prevBadge,
      h("div", { class: "look-id" }, prevName, prevKind),
      h(
        "button",
        {
          class: "look-reset",
          type: "button",
          title: "Reset color and icon",
          "aria-label": "Reset color and icon",
          onclick: () => {
            t.set({ color: null, icon: null });
            refresh();
          },
        },
        "Reset",
      ),
    ),
    h("div", { class: "look-lbl" }, "Color"),
    swatches,
    h("div", { class: "look-lbl row" }, h("span", null, "Icon"), h("div", { class: "spacer" }), h("label", { class: "look-search" }, icon("search", 11), search)),
    grid,
    empty,
    h("div", { class: "look-foot" }, done),
  );
  document.body.appendChild(pop);
  refresh();
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)) + "px";
  pop.style.top = Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)) + "px";

  const away = (e: Event): void => {
    if (e.target instanceof Node && pop.contains(e.target)) return;
    // Menus opened from inside other UI shouldn't be eaten; a click elsewhere just dismisses.
    close();
  };
  const keys = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const close = (): void => {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", keys, true);
    pop.remove();
    onClose?.();
  };
  closeCurrent = close;
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", keys, true);
  pop.focus();
}
