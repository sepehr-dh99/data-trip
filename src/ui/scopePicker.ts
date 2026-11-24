// "Visible databases" popover: choose which databases (and, for PostgreSQL / SQL Server, which schemas)
// the explorer shows for one data source. Changes apply at once and persist through scope.ts.
import { DRIVER_LABELS } from "../types";
import { clear, h, icon } from "./dom";
import { showMenu } from "./menu";
import {
  checkedDatabases,
  scopeLabel,
  scopeSummary,
  selectAllDatabases,
  selectDefaultOnly,
  setCheckedDatabases,
  setSchemaChecked,
  setShowNew,
  schemaVisible,
  userDatabases,
} from "./scope";
import { store } from "./state";
import { connColor } from "./sqlutil";
import { humanSize } from "./format";
import { dbLabel, redisDbMeta } from "./redis";

export const DRIVER_ABBR: Record<string, string> = { postgres: "PG", mysql: "MY", sqlite: "SQ", mssql: "MS", redis: "RD", kafka: "KF" };

export interface PickerAnchor {
  /** Preferred top-left corner (viewport px); the popover is clamped inside the window. */
  x: number;
  y: number;
}

let openId: string | null = null;
let closeCurrent: (() => void) | null = null;
let lastClosed = { id: "", t: 0 };

export function closeScopePicker(): void {
  closeCurrent?.();
}
export function isScopePickerOpen(id?: string): boolean {
  return openId !== null && (id === undefined || id === openId);
}

export function openScopePicker(connId: string, anchor: PickerAnchor, onClose?: () => void): void {
  // A click on the chip while its popover is open closes it (pointerdown) — don't reopen it.
  if (lastClosed.id === connId && performance.now() - lastClosed.t < 250) return;
  closeCurrent?.();
  const e0 = store.conns.get(connId);
  if (!e0) return;
  const schemaLevel = e0.config.driver === "postgres" || e0.config.driver === "mssql";
  const isRedis = e0.config.driver === "redis";
  let q = "";
  const expanded = new Set<string>();
  const collapsed = new Set<string>();
  const entry = () => store.conns.get(connId);

  const countEl = h("span", { class: "sp-count" });
  const list = h("div", { class: "sp-list", role: "group", "aria-label": "Databases" });
  const search = h("input", {
    type: "search",
    placeholder: "Search databases and schemas",
    "aria-label": "Search databases",
    spellcheck: false,
    oninput: () => {
      q = search.value.trim().toLowerCase();
      renderList();
    },
  });
  const newBtn = h("button", { class: "sp-pill", type: "button", "aria-haspopup": "menu" });
  const newText = h("span", { class: "sp-new-text" });

  const syncMeta = (): void => {
    const e = entry();
    if (!e) return;
    const s = scopeSummary(e);
    countEl.textContent = `${scopeLabel(s)} shown`;
    const showNew = e.config.scope?.showNew === true;
    newText.textContent = `New databases on this server: ${showNew ? "shown" : "hidden"}`;
    clear(newBtn);
    newBtn.append(showNew ? "Hide" : "Show", " ▾");
  };

  const ensureSchemas = (db: string): void => {
    if (!schemaLevel) return;
    void store.ensureDb(connId, db).then(() => renderList());
  };

  function row(opts: { key: string; name: string; meta: string; on: boolean; nested?: boolean; muted?: boolean; onToggle: (v: boolean) => void; extra?: HTMLElement | null }): HTMLElement {
    const cb = h("input", { type: "checkbox", checked: opts.on, "aria-label": opts.name, "data-key": opts.key });
    cb.addEventListener("change", () => opts.onToggle(cb.checked));
    return h(
      "label",
      { class: "sp-row" + (opts.nested ? " nested" : "") + (opts.muted ? " muted" : "") },
      cb,
      h("span", { class: "sp-name" }, opts.name),
      h("span", { class: "sp-meta" }, opts.meta),
      opts.extra ?? null,
    );
  }

  function renderList(): void {
    const e = entry();
    if (!e) return close();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;
    clear(list);
    const checked = checkedDatabases(e);
    let n = 0;
    for (const d of userDatabases(e)) {
      const de = e.dbs.get(d.name);
      const schemaNames = de?.status === "ready" ? de.schemas.map((s) => s.name) : [];
      const schemaHit = q !== "" && schemaNames.some((s) => s.toLowerCase().includes(q));
      if (q && !d.name.toLowerCase().includes(q) && !(isRedis && dbLabel(d.name).includes(q)) && !schemaHit) continue;
      n++;
      const isOn = checked.has(d.name);
      // Checked databases whose schemas are already known show them right away; others on demand.
      const open = schemaLevel && isOn && (expanded.has(d.name) || schemaHit || (de?.status === "ready" && !collapsed.has(d.name)));
      const chev = schemaLevel && isOn
        ? h(
            "button",
            {
              class: "sp-chev" + (open ? " open" : ""),
              type: "button",
              "aria-label": (open ? "Hide" : "Show") + " schemas of " + d.name,
              "aria-expanded": String(open),
              onclick: (ev: Event) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (open) {
                  expanded.delete(d.name);
                  collapsed.add(d.name);
                } else {
                  collapsed.delete(d.name);
                  expanded.add(d.name);
                  ensureSchemas(d.name);
                }
                renderList();
              },
            },
            icon("caret", 9),
          )
        : null;
      const size = isRedis ? redisDbMeta(d) : humanSize(d.sizeBytes);
      const isDefault = d.name === e.defaultDb;
      list.appendChild(
        row({
          key: "db:" + d.name,
          name: isRedis ? dbLabel(d.name) : d.name,
          meta: [isDefault ? "default" : "", size ?? ""].filter(Boolean).join(" · "),
          on: isOn,
          extra: chev,
          onToggle: (v) => {
            const next = checkedDatabases(e);
            if (v) next.add(d.name);
            else next.delete(d.name);
            if (v && schemaLevel) {
              collapsed.delete(d.name);
              expanded.add(d.name);
              ensureSchemas(d.name);
            }
            setCheckedDatabases(e, next);
            renderList();
            syncMeta();
          },
        }),
      );
      if (open) {
        if (!de || de.status === "idle" || de.status === "loading") list.appendChild(h("div", { class: "sp-note" }, "loading…"));
        else if (de.status === "error") list.appendChild(h("div", { class: "sp-note err" }, "couldn't load schemas"));
        else {
          for (const s of de.schemas) {
            if (q && !d.name.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) continue;
            list.appendChild(
              row({
                key: `sc:${d.name}:${s.name}`,
                name: s.name,
                meta: "schema",
                nested: true,
                on: schemaVisible(e, d.name, s.name),
                onToggle: (v) => {
                  setSchemaChecked(e, d.name, schemaNames, s.name, v);
                  syncMeta();
                },
              }),
            );
          }
        }
      }
    }
    if (n === 0) list.appendChild(h("div", { class: "sp-note" }, q ? "No databases match." : "No databases listed."));
    if (active) list.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`)?.focus();
  }

  const title = `Visible databases for ${e0.config.name}`;
  const pop = h(
    "div",
    { class: "scope-pop", role: "dialog", "aria-label": title },
    h(
      "div",
      { class: "sp-head" },
      h("span", { class: "sp-badge", style: `--c:${connColor(e0.config)}`, title: DRIVER_LABELS[e0.config.driver] }, DRIVER_ABBR[e0.config.driver]),
      h("span", { class: "sp-title" }, e0.config.name),
      h("span", { class: "sp-sub" }, "· visible databases"),
      h("div", { class: "spacer" }),
      h("button", { class: "sp-x", type: "button", "aria-label": "Close", onclick: () => close() }, "×"),
    ),
    h("div", { class: "sp-search" }, h("label", { class: "sp-field" }, icon("search", 12), search)),
    h(
      "div",
      { class: "sp-tools" },
      h("button", { class: "sp-pill", type: "button", onclick: () => entry() && (selectAllDatabases(entry()!), renderList(), syncMeta()) }, "All"),
      h("button", { class: "sp-pill", type: "button", onclick: () => entry() && (selectDefaultOnly(entry()!), renderList(), syncMeta()) }, "Default only"),
      h("div", { class: "spacer" }),
      countEl,
    ),
    list,
    h("div", { class: "sp-foot" }, newText, newBtn),
  );
  newBtn.addEventListener("click", () => {
    const e = entry();
    if (!e) return;
    const r = newBtn.getBoundingClientRect();
    const cur = e.config.scope?.showNew === true;
    showMenu(
      r.left,
      r.top - 6,
      [
        { label: "Hidden", checked: !cur, onClick: () => (setShowNew(e, false), syncMeta()) },
        { label: "Shown", checked: cur, onClick: () => (setShowNew(e, true), syncMeta()) },
      ],
      { above: true, minWidth: Math.max(120, r.width) },
    );
  });

  const away = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof Node)) return;
    if (pop.contains(t) || (t instanceof Element && t.closest(".ctx-menu"))) return;
    close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && !document.querySelector(".ctx-menu")) {
      ev.stopPropagation();
      close();
    }
  };
  function close(): void {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    openId = null;
    lastClosed = { id: connId, t: performance.now() };
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    pop.remove();
    onClose?.();
  }
  closeCurrent = close;
  openId = connId;
  document.body.appendChild(pop);
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close);
  renderList();
  syncMeta();
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)) + "px";
  pop.style.top = Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)) + "px";
  search.focus();
}
