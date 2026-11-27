// Welcome tour (v0.15, board S): four short steps anchored to the real controls — the explorer, the run gutter
// (or the first console / New console), the ⌘K pill and the help button. Shown once on first launch
// (settings.help.tourDone), skippable, restartable from Help › Welcome tour.
import { h } from "./dom";
import { shortcutLabel } from "./keymap";
import { getSettings, updateSettings } from "./settings";

interface Step {
  title: string;
  text: () => string;
  /** The element to point at (first match that is visible). */
  anchor: string[];
}

const STEPS: Step[] = [
  {
    title: "Your data sources",
    text: () => "Everything you connect to lives here. Click + to add one; right-click one for consoles, reconnect, Run SQL file, colors and more.",
    anchor: [".sidebar .tree", ".sidebar"],
  },
  {
    title: "Run what you wrote",
    text: () => `Each statement gets a ▶ in the gutter. ${shortcutLabel("runStatement") || "Run"} runs the one under the cursor, ${shortcutLabel("runAll") || "Run all"} runs them all.`,
    anchor: [".console:not(.hidden) .cm-gutters", ".cap-btn.run", ".empty-actions .btn", ".empty-card"],
  },
  {
    title: "Find anything",
    text: () => `${shortcutLabel("commandPalette") || "The palette"} opens the command palette: actions, data sources, tables and tabs — with their shortcuts.`,
    anchor: [".side-k"],
  },
  {
    title: "Help is one key away",
    text: () => `${shortcutLabel("help") || "The ? button"} opens the help. Errors DataTrip knows also get a “What does this mean?” button.`,
    anchor: [".side-help"],
  },
];

let active: (() => void) | null = null;

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findAnchor(sel: string[]): HTMLElement | null {
  for (const s of sel) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(s))) if (visible(el)) return el;
  }
  return null;
}

/** Help › Welcome tour (and the first launch). */
export function startTour(): void {
  active?.();
  let i = 0;
  const overlay = h("div", { class: "overlay tour-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Welcome tour" });
  const ring = h("div", { class: "tour-ring", "aria-hidden": "true" });
  const count = h("div", { class: "tour-count" });
  const title = h("div", { class: "tour-title" });
  const text = h("div", { class: "tour-text" });
  const next = h("button", { class: "btn primary sm", type: "button" }, "Next");
  const skip = h("button", { class: "btn ghost sm", type: "button" }, "Skip tour");
  const card = h("div", { class: "tour-card" }, count, title, text, h("div", { class: "tour-actions" }, next, skip));
  overlay.append(ring, card);
  const finish = (): void => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 160);
    active = null;
    if (!getSettings().help.tourDone) updateSettings((s) => (s.help.tourDone = true));
  };
  const place = (): void => {
    const st = STEPS[i];
    const a = findAnchor(st.anchor);
    const cw = 330;
    if (!a) {
      ring.hidden = true;
      card.style.left = `${Math.round((window.innerWidth - cw) / 2)}px`;
      card.style.top = `${Math.round(window.innerHeight / 3)}px`;
      return;
    }
    const r = a.getBoundingClientRect();
    const pad = 6;
    ring.hidden = false;
    ring.style.left = `${r.left - pad}px`;
    ring.style.top = `${r.top - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${Math.min(r.height, window.innerHeight - 24) + pad * 2}px`;
    const ch = card.getBoundingClientRect().height || 170;
    // Right of the anchor when there is room, else below / above it.
    let left = r.right + 16;
    let top = r.top;
    if (left + cw > window.innerWidth - 12) {
      left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
      top = r.bottom + 14;
      if (top + ch > window.innerHeight - 12) top = r.top - ch - 14;
    }
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(Math.max(12, Math.min(top, window.innerHeight - ch - 12)))}px`;
  };
  const render = (): void => {
    const st = STEPS[i];
    count.textContent = `Step ${i + 1} of ${STEPS.length}`;
    title.textContent = st.title;
    text.textContent = st.text();
    next.textContent = i === STEPS.length - 1 ? "Done" : "Next";
    place();
    next.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    } else if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      next.click();
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      i--;
      render();
    }
  };
  next.addEventListener("click", () => {
    if (i >= STEPS.length - 1) finish();
    else {
      i++;
      render();
    }
  });
  skip.addEventListener("click", finish);
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  active = finish;
  render();
}

/** First launch: the tour once (after the window settled, never over another dialog). */
export function maybeStartTour(): void {
  if (getSettings().help.tourDone) return;
  window.setTimeout(() => {
    if (getSettings().help.tourDone || document.querySelector(".overlay:not(.leaving)")) return;
    startTour();
  }, 900);
}
