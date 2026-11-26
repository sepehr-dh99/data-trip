// Breadcrumb navigator in the capsule: [data source ▾] › [database ▾] › [schema ▾] [Go to…].
// Each segment opens a searchable glass switcher under the capsule. ↵ applies to the current console,
// ⌘/Ctrl+↵ opens a new console there.
import { api } from "../api";

import type { RedisKey, RoutineNode, SchemaNode, TableNode } from "../types";
import type { ConsolePane } from "./console";
import type { TabPane } from "./tabs";
import { dbLabel, redisDbMeta, redisSession, searchKeys, ttlShort, typeInfo } from "./redis";
import { loadOverview, overviewOf, stateLabel } from "./kafka";
import { clear, errMsg, h, icon } from "./dom";
import type { OpenConsoleOpts } from "./explorer";
import { humanSize } from "./format";
import type { ObjKind } from "./prefs";
import { getRecent, pushRecent } from "./prefs";
import { dbVisible, userDatabases } from "./scope";
import { DRIVER_ABBR, dataBadge, hasIcon, svgMarkup } from "./icons";
import { topItems } from "./layout";
import type { ConnEntry } from "./state";
import { store } from "./state";
import { connColor, qualifiedName } from "./sqlutil";
import { toast } from "./toast";

const IS_MAC = /Mac/.test(navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const MAX_OBJECTS = 120;

export type NavKind = "source" | "db" | "schema" | "obj";

export interface NavHost {
  sheet(): HTMLElement;
  openConsole(connId: string, o: OpenConsoleOpts): void;
  openKey(connId: string, db: string, key: string, keyType: string): void;
  openTopic(connId: string, topic: string): void;
  openGroup(connId: string, groupId: string): void;
  manageScope(connId: string, anchor: DOMRect): void;
}

interface NavItem {
  header?: boolean;
  note?: boolean;
  label: string;
  meta?: string;
  badgeText?: string;
  /** Inline SVG markup replacing the text (custom data-source icon). */
  badgeSvg?: string;
  badgeIcon?: string;
  badgeColor?: string;
  /** Extra class on the badge (Redis key type colors). */
  badgeCls?: string;
  current?: boolean;
  muted?: boolean;
  run?: (newConsole: boolean) => void;
}

const TITLES: Record<NavKind, [string, string]> = {
  source: ["Switch data source", "Search data sources…"],
  db: ["Switch database", "Search databases…"],
  schema: ["Switch schema", "Search schemas…"],
  obj: ["Go to object", "Tables, views, functions…"],
};

const REDIS_GOTO: [string, string] = ["Go to key", "Search keys…"];
const KAFKA_GOTO: [string, string] = ["Go to topic or consumer group", "Search topics and groups…"];
const dbNav = (name: string): string => `db ${name}`;

const OBJ_ICON: Record<ObjKind, string> = { table: "table", view: "view", materialized: "matview", function: "func", procedure: "proc", sequence: "seq" };

function routineSkeleton(driver: string, schema: string, r: RoutineNode): string {
  const q = qualifiedName(driver as "postgres", schema, r.name);
  const args = r.arguments ? `/* ${r.arguments} */` : "";
  if (driver === "mssql") return r.kind === "procedure" ? `EXEC ${q} ${args}` : `SELECT ${q}(${args})`;
  return r.kind === "procedure" ? `CALL ${q}(${args});` : `SELECT ${q}(${args});`;
}

function sequenceSql(driver: string, schema: string, name: string): string {
  const q = qualifiedName(driver as "postgres", schema, name);
  if (driver === "postgres") return `SELECT nextval('${q.replace(/'/g, "''")}');`;
  if (driver === "mssql") return `SELECT NEXT VALUE FOR ${q};`;
  return `SELECT * FROM ${q};`;
}

export class Navigator {
  readonly el: HTMLElement;
  private pane: TabPane | null = null;
  private segs = new Map<NavKind, HTMLButtonElement>();
  private kind: NavKind | null = null;
  private panel: HTMLElement | null = null;
  private catcher: HTMLElement | null = null;
  private listEl!: HTMLElement;
  private input!: HTMLInputElement;
  private selectable: { it: NavItem; el: HTMLElement }[] = [];
  private hi = 0;
  private q = "";
  /** The query as typed (Redis key search is case-sensitive). */
  private qRaw = "";
  private seq = 0;
  /** Redis "Go to…": key search state. */
  private keyHits: { query: string; keys: RedisKey[]; complete: boolean } | null = null;
  private keySearching = false;
  private keyError: string | null = null;
  private keyTimer: number | undefined;
  private keySeq = 0;

  constructor(private host: NavHost) {
    this.el = h("nav", { class: "crumbs", "aria-label": "Location" });
    this.update(null);
  }

  get isOpen(): boolean {
    return this.kind !== null;
  }

  /** Rebuilds the segments for the active console (null = none). */
  update(pane: TabPane | null): void {
    if (this.kind && pane !== this.pane) this.close(false);
    this.pane = pane;
    clear(this.el);
    this.segs.clear();
    const e = pane ? store.conns.get(pane.connId) : undefined;
    this.el.hidden = store.list().length === 0;
    if (!pane || !e) {
      this.el.append(this.seg("source", "Choose data source", [h("span", { class: "crumb-label" }, "Choose data source")], "Choose data source"));
      return;
    }
    const driver = e.config.driver;
    if (driver === "kafka") {
      const caret = (): HTMLElement => h("span", { class: "crumb-caret", "aria-hidden": "true" }, "▾");
      this.el.append(
        this.seg(
          "source",
          `Data source: ${e.config.name}`,
          [dataBadge(e.config, "crumb-badge", 10), h("span", { class: "crumb-label" }, e.config.name), caret()],
          `Data source: ${e.config.name}`,
        ),
        h("span", { class: "crumb-sep", "aria-hidden": "true" }, "›"),
      );
      const ol = pane.objectLabel;
      if (ol) {
        this.el.append(this.seg("obj", `${ol.glyph === "topic" ? "Topic" : "Consumer group"}: ${ol.name}`, [h("span", { class: "crumb-glyph " + ol.glyph }, icon(ol.glyph, 13)), h("span", { class: "crumb-label mono" }, ol.name), caret()], `Switch topic or consumer group (current: ${ol.name})`));
      } else {
        this.el.append(this.seg("obj", KAFKA_GOTO[0], [icon("search", 12), h("span", { class: "crumb-goto" }, "Go to…")], KAFKA_GOTO[0], "goto"));
      }
      return;
    }
    const redis = driver === "redis";
    const dbName = redis ? dbNav(pane.effectiveDatabase ?? "0") : (pane.effectiveDatabase ?? "database");
    const caret = (): HTMLElement => h("span", { class: "crumb-caret", "aria-hidden": "true" }, "▾");
    this.el.append(
      this.seg(
        "source",
        `Data source: ${e.config.name}`,
        [dataBadge(e.config, "crumb-badge", 10), h("span", { class: "crumb-label" }, e.config.name), caret()],
        `Data source: ${e.config.name}`,
      ),
      h("span", { class: "crumb-sep", "aria-hidden": "true" }, "›"),
      this.seg("db", `Database: ${dbName}`, [icon("database", 12), h("span", { class: "crumb-label" }, dbName), caret()], `Database: ${dbName}`),
    );
    if (driver === "postgres" || driver === "mssql") {
      const sch = pane.currentSchemaName() ?? "schema";
      this.el.append(
        h("span", { class: "crumb-sep", "aria-hidden": "true" }, "›"),
        this.seg("schema", `Schema: ${sch}`, [icon("schema", 12), h("span", { class: "crumb-label" }, sch), caret()], `Schema: ${sch}`),
      );
    }
    const gotoTitle = redis ? "Go to key" : "Go to table, view or routine";
    this.el.append(this.seg("obj", gotoTitle, [icon("search", 12), h("span", { class: "crumb-goto" }, "Go to…")], gotoTitle, "goto"));
  }

  private seg(kind: NavKind, title: string, kids: HTMLElement[], aria: string, extra = ""): HTMLButtonElement {
    const b = h(
      "button",
      {
        class: "crumb " + extra + (this.kind === kind ? " on" : ""),
        type: "button",
        title,
        "aria-label": aria,
        "aria-haspopup": "dialog",
        "aria-expanded": String(this.kind === kind),
        onclick: () => (this.kind === kind ? this.close(true) : void this.open(kind)),
      },
      ...kids,
    );
    this.segs.set(kind, b);
    return b;
  }

  /** Opens a switcher programmatically (e.g. a keyboard shortcut). */
  openKind(kind: NavKind): void {
    void this.open(kind);
  }

  // ---------------------------------------------------------------- panel

  private async open(kind: NavKind): Promise<void> {
    this.close(false);
    const seg = this.segs.get(kind);
    if (!seg) return;
    this.kind = kind;
    this.q = "";
    this.qRaw = "";
    this.keyHits = null;
    this.keySearching = false;
    this.keyError = null;
    this.keySeq++;
    this.hi = -1;
    const mine = ++this.seq;
    for (const [k, b] of this.segs) {
      b.classList.toggle("on", k === kind);
      b.setAttribute("aria-expanded", String(k === kind));
    }
    const sheet = this.host.sheet();
    const sr = sheet.getBoundingClientRect();
    const r = seg.getBoundingClientRect();
    const cap = this.el.closest(".capsule")?.getBoundingClientRect();
    const width = Math.min(360, sr.width - 16);
    const left = Math.max(8, Math.min(r.left - sr.left, sr.width - width - 8));
    const top = (cap ? cap.bottom : r.bottom) - sr.top + 8;

    const redisNow = this.entry()?.config.driver === "redis";
    const kafkaNow = this.entry()?.config.driver === "kafka";
    const [title, placeholder] = kind === "obj" && redisNow ? REDIS_GOTO : kind === "obj" && kafkaNow ? KAFKA_GOTO : TITLES[kind];
    this.input = h("input", {
      type: "text",
      role: "combobox",
      "aria-label": title,
      "aria-expanded": "true",
      "aria-controls": "nav-list",
      "aria-autocomplete": "list",
      placeholder,
      spellcheck: false,
      autocomplete: "off",
      oninput: () => {
        this.qRaw = this.input.value.trim();
        this.q = this.qRaw.toLowerCase();
        this.hi = -1;
        if (this.kind === "obj" && this.entry()?.config.driver === "redis") this.scheduleKeySearch();
        else this.renderList();
      },
      onkeydown: (ev: KeyboardEvent) => this.onKey(ev),
    });
    this.listEl = h("div", { class: "nav-list", id: "nav-list", role: "listbox", "aria-label": title });
    const manage = kind === "db" && this.pane ? h("button", { class: "nav-manage", type: "button", onclick: () => this.manage() }, "Manage visible…") : null;
    const hint = (k: string, text: string): HTMLElement => h("span", null, h("b", null, k), " " + text);
    this.panel = h(
      "div",
      { class: "nav-panel", role: "dialog", "aria-label": title, style: `left:${left}px;top:${top}px;width:${width}px` },
      h("div", { class: "nav-search" }, h("label", { class: "nav-field" }, icon("search", 13), this.input, h("span", { class: "nav-esc" }, "esc"))),
      this.listEl,
      h(
        "div",
        { class: "nav-foot" },
        hint("↵", kind === "obj" ? (redisNow ? "open key" : kafkaNow ? "open tab" : "open here") : "switch this console"),
        (redisNow || kafkaNow) && kind === "obj" ? null : hint(MOD + "↵", "new console"),
        h("div", { class: "spacer" }),
        manage,
      ),
    );
    this.catcher = h("div", { class: "nav-catcher", "aria-hidden": "true", onpointerdown: () => this.close(false) });
    sheet.append(this.catcher, this.panel);
    window.addEventListener("keydown", this.onWinKey, true);
    this.renderList();
    this.input.focus();
    // Data the list needs that may not be loaded yet.
    const need = this.prefetch(kind);
    if (need) {
      await need;
      if (this.kind === kind && mine === this.seq) this.renderList();
    }
  }

  private onWinKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && this.kind) {
      ev.stopPropagation();
      ev.preventDefault();
      this.close(true);
    }
  };

  close(focusSeg: boolean): void {
    const kind = this.kind;
    if (!kind) return;
    this.kind = null;
    this.seq++;
    this.keySeq++;
    window.clearTimeout(this.keyTimer);
    window.removeEventListener("keydown", this.onWinKey, true);
    this.panel?.remove();
    this.catcher?.remove();
    this.panel = this.catcher = null;
    for (const [, b] of this.segs) {
      b.classList.remove("on");
      b.setAttribute("aria-expanded", "false");
    }
    if (focusSeg) this.segs.get(kind)?.focus();
  }

  private manage(): void {
    const pane = this.pane;
    const r = (this.segs.get("db") ?? this.el).getBoundingClientRect();
    this.close(false);
    if (pane) this.host.manageScope(pane.connId, r);
  }

  private prefetch(kind: NavKind): Promise<void> | null {
    const pane = this.pane;
    const e = pane ? store.conns.get(pane.connId) : undefined;
    if (!pane || !e || e.status !== "connected") return null;
    if (e.config.driver === "kafka") return kind === "obj" ? loadOverview(e.config.id).then(() => undefined) : null;
    if (kind === "db" && e.databases.length === 0 && e.session) {
      return api
        .listDatabases(e.session.sessionId)
        .then((d) => void (e.databases = d))
        .catch((err) => void toast(errMsg(err), "error"));
    }
    if ((kind === "schema" || kind === "obj") && pane.database !== null && pane.database !== e.defaultDb) {
      const d = e.dbs.get(pane.database);
      if (!d || d.status !== "ready") return store.ensureDb(pane.connId, pane.database);
    }
    return null;
  }

  private onKey(ev: KeyboardEvent): void {
    const n = this.selectable.length;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!n) return;
      this.hi = (this.hi + (ev.key === "ArrowDown" ? 1 : -1) + n) % n;
      this.syncHi();
    } else if (ev.key === "Home" && ev.ctrlKey) {
      this.hi = 0;
      this.syncHi();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      this.pick(this.hi, ev.metaKey || ev.ctrlKey);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      this.close(true);
    }
  }

  private pick(i: number, newConsole: boolean): void {
    const s = this.selectable[i];
    if (!s?.it.run) return;
    const run = s.it.run;
    this.close(false);
    run(newConsole);
  }

  private syncHi(): void {
    this.selectable.forEach((s, i) => {
      const on = i === this.hi;
      s.el.classList.toggle("hi", on);
      if (on) {
        this.input.setAttribute("aria-activedescendant", s.el.id);
        const top = s.el.offsetTop;
        const bottom = top + s.el.offsetHeight;
        if (top < this.listEl.scrollTop + 24) this.listEl.scrollTop = Math.max(0, top - 30);
        else if (bottom > this.listEl.scrollTop + this.listEl.clientHeight) this.listEl.scrollTop = bottom - this.listEl.clientHeight + 6;
      }
    });
    if (this.hi < 0) this.input.removeAttribute("aria-activedescendant");
  }

  private renderList(): void {
    if (!this.kind) return;
    clear(this.listEl);
    this.selectable = [];
    const items = this.compute(this.kind);
    for (const it of items) {
      if (it.header) {
        this.listEl.appendChild(h("div", { class: "nav-hdr", role: "presentation" }, it.label, h("div", { class: "spacer" }), it.meta ? h("span", { class: "nav-hdr-meta" }, it.meta) : null));
        continue;
      }
      if (it.note) {
        this.listEl.appendChild(h("div", { class: "nav-note", role: "presentation" }, it.label));
        continue;
      }
      const idx = this.selectable.length;
      const badge = h(
        "span",
        { class: "nav-badge" + (it.badgeColor ? " solid" : "") + (it.badgeCls ? " " + it.badgeCls : ""), style: it.badgeColor ? `--c:${it.badgeColor}` : undefined, "aria-hidden": "true" },
        it.badgeIcon ? icon(it.badgeIcon, 12) : (it.badgeText ?? ""),
      );
      if (it.badgeSvg) {
        badge.innerHTML = it.badgeSvg;
        badge.classList.add("has-icon");
      }
      const el = h(
        "button",
        {
          class: "nav-opt" + (it.current ? " current" : "") + (it.muted ? " muted" : ""),
          type: "button",
          role: "option",
          id: "nav-opt-" + idx,
          tabindex: "-1",
          "aria-selected": String(it.current === true),
          onclick: (ev: MouseEvent) => this.pick(idx, ev.metaKey || ev.ctrlKey),
          onmousemove: () => {
            if (this.hi !== idx) {
              this.hi = idx;
              this.syncHi();
            }
          },
        },
        badge,
        h("span", { class: "nav-label" }, it.label),
        it.meta ? h("span", { class: "nav-meta" }, it.meta) : null,
        h("span", { class: "nav-check", "aria-hidden": "true" }, it.current ? icon("check", 12) : null),
      );
      this.selectable.push({ it, el });
      this.listEl.appendChild(el);
    }
    if (this.selectable.length === 0 && !items.some((i) => i.note)) this.listEl.appendChild(h("div", { class: "nav-note" }, "No matches"));
    if (this.hi < 0 || this.hi >= this.selectable.length) {
      const cur = this.selectable.findIndex((s) => s.it.current);
      this.hi = this.q ? 0 : cur >= 0 ? cur : 0;
    }
    this.syncHi();
  }

  // ---------------------------------------------------------------- content

  private compute(kind: NavKind): NavItem[] {
    switch (kind) {
      case "source":
        return this.sourceItems();
      case "db":
        return this.dbItems();
      case "schema":
        return this.schemaItems();
      default:
        return this.objItems();
    }
  }

  private match(label: string): boolean {
    return !this.q || label.toLowerCase().includes(this.q);
  }

  private sourceItems(): NavItem[] {
    const pane = this.pane;
    // Same order as the explorer: folders (and their members) as arranged there, loose sources last.
    const groups = new Map<string, ConnEntry[]>();
    const loose: ConnEntry[] = [];
    for (const it of topItems()) {
      if (it.kind === "folder") groups.set(it.name, it.members);
      else loose.push(it.entry);
    }
    const out: NavItem[] = [];
    const add = (name: string, list: ConnEntry[]): void => {
      const hits = list.filter((e) => this.match(e.config.name) || this.match(name));
      if (!hits.length) return;
      out.push({ header: true, label: name, meta: String(hits.length) });
      for (const e of hits) {
        out.push({
          label: e.config.name,
          meta: e.status === "connected" ? "connected" : e.status === "error" ? "failed" : "",
          badgeText: DRIVER_ABBR[e.config.driver],
          badgeColor: connColor(e.config),
          badgeSvg: hasIcon(e.config.icon) ? svgMarkup(e.config.icon, 12, "#fff", 2.2) : undefined,
          current: pane?.connId === e.config.id,
          run: (nc) => {
            const id = e.config.id;
            if (nc || !pane || pane.kind !== "console") this.host.openConsole(id, {});
            else void pane.switchConnection(id).then(() => pane.focus());
          },
        });
      }
    };
    for (const [name, list] of groups) add(name, list);
    if (loose.length) add(groups.size ? "Other" : "Data sources", loose);
    if (!out.length) out.push({ note: true, label: store.list().length ? "No matches" : "No data sources yet" });
    return out;
  }

  private entry(): ConnEntry | undefined {
    return this.pane ? store.conns.get(this.pane.connId) : undefined;
  }

  private dbItems(): NavItem[] {
    const pane = this.pane;
    const e = this.entry();
    if (!pane || !e) return [{ note: true, label: "Choose a data source first" }];
    if (e.status !== "connected") return [{ note: true, label: "Not connected" }];
    if (e.databases.length === 0) return [{ note: true, label: "Loading databases…" }];
    const cur = pane.effectiveDatabase;
    const redis = e.config.driver === "redis";
    const mk = (name: string, size: number | null, muted: boolean): NavItem => ({
      label: redis ? dbNav(name) : name,
      meta: redis ? redisDbMeta(e.databases.find((d) => d.name === name) ?? { name, isCurrent: false, isSystem: false, sizeBytes: null, comment: null }) : (humanSize(size) ?? ""),
      badgeIcon: "database",
      muted,
      current: name === cur,
      run: (nc) => {
        const target = name === e.defaultDb ? null : name;
        if (nc || !pane || pane.kind !== "console") this.host.openConsole(e.config.id, { database: target });
        else void pane.switchDatabase(name).then(() => pane.focus());
      },
    });
    const user = userDatabases(e).filter((d) => this.match(d.name) || (redis && this.match(dbNav(d.name))));
    if (redis) user.sort((a, b) => Number(a.name) - Number(b.name));
    const shown = user.filter((d) => dbVisible(e, d.name));
    const hidden = user.filter((d) => !dbVisible(e, d.name));
    const sys = e.databases.filter((d) => d.isSystem && this.match(d.name));
    const out: NavItem[] = [];
    if (shown.length) out.push({ header: true, label: "Shown in explorer", meta: String(shown.length) }, ...shown.map((d) => mk(d.name, d.sizeBytes, false)));
    if (hidden.length) out.push({ header: true, label: "Hidden on this server", meta: String(hidden.length) }, ...hidden.map((d) => mk(d.name, d.sizeBytes, true)));
    if (sys.length) out.push({ header: true, label: "System databases", meta: String(sys.length) }, ...sys.map((d) => mk(d.name, d.sizeBytes, true)));
    return out;
  }

  private schemaItems(): NavItem[] {
    const pane = this.pane;
    const e = this.entry();
    if (!pane || !e) return [{ note: true, label: "Choose a data source first" }];
    if (e.status !== "connected") return [{ note: true, label: "Not connected" }];
    const schemas = store.schemasFor(pane.connId, pane.database);
    const dbName = pane.effectiveDatabase ?? "database";
    if (schemas.length === 0) return [{ note: true, label: "Loading schemas…" }];
    const cur = pane.currentSchemaName();
    const hits = schemas.filter((s) => this.match(s.name));
    const out: NavItem[] = [{ header: true, label: "Schemas in " + dbName, meta: String(hits.length) }];
    for (const s of hits) {
      const n = s.tables.filter((t) => t.kind === "table").length;
      out.push({
        label: s.name,
        meta: `${n} table${n === 1 ? "" : "s"}`,
        badgeIcon: "schema",
        current: s.name === cur,
        run: (nc) => {
          if (nc || !pane || pane.kind !== "console") this.host.openConsole(e.config.id, { database: pane.database, schema: s.name, explicitSchema: true });
          else void pane.setDefaultSchema(s.name).then(() => pane.focus());
        },
      });
    }
    return out;
  }

  // ---- Redis "Go to…": SCAN for keys containing the query (debounced), first 50 hits.

  private scheduleKeySearch(): void {
    window.clearTimeout(this.keyTimer);
    const q = this.qRaw;
    const mine = ++this.keySeq;
    if (!q) {
      this.keyHits = null;
      this.keySearching = false;
      this.keyError = null;
      this.renderList();
      return;
    }
    this.keySearching = true;
    this.renderList();
    this.keyTimer = window.setTimeout(() => void this.runKeySearch(q, mine), 200);
  }

  private async runKeySearch(q: string, mine: number): Promise<void> {
    const pane = this.pane;
    if (!pane) return;
    const stale = (): boolean => mine !== this.keySeq || this.kind !== "obj";
    try {
      const s = await redisSession(pane.connId, pane.effectiveDatabase);
      const r = await searchKeys(s.sessionId, q, 50, stale);
      if (stale()) return;
      this.keyHits = { query: q, keys: r.keys, complete: r.complete };
      this.keyError = null;
    } catch (err) {
      if (stale()) return;
      this.keyHits = null;
      this.keyError = errMsg(err);
    } finally {
      if (!stale()) {
        this.keySearching = false;
        this.renderList();
      }
    }
  }

  private redisKeyItems(): NavItem[] {
    const pane = this.pane;
    if (!pane) return [];
    const db = pane.effectiveDatabase ?? "0";
    if (!this.qRaw) return [{ note: true, label: `Type part of a key name to search ${dbNav(db)}` }];
    if (this.keyError) return [{ note: true, label: this.keyError }];
    if (this.keySearching || !this.keyHits || this.keyHits.query !== this.qRaw) return [{ note: true, label: "Searching…" }];
    const { keys, complete } = this.keyHits;
    if (keys.length === 0) return [{ note: true, label: `No keys contain “${this.qRaw}” in ${dbNav(db)}` }];
    const out: NavItem[] = [{ header: true, label: `Keys in ${dbNav(db)}`, meta: complete ? String(keys.length) : `first ${keys.length}` }];
    for (const k of keys) {
      const t = typeInfo(k.keyType);
      out.push({
        label: k.key,
        meta: ttlShort(k.ttl),
        badgeText: t.chip,
        badgeCls: t.cls,
        run: () => this.host.openKey(pane.connId, db, k.key, k.keyType),
      });
    }
    if (!complete) out.push({ note: true, label: "More keys match — keep typing to narrow the search" });
    return out;
  }

  // ---- Kafka "Go to…": topics and consumer groups of the cached overview, as two sections.

  private kafkaItems(e: ConnEntry): NavItem[] {
    const pane = this.pane;
    const o = overviewOf(e.config.id);
    if (!o) return [{ note: true, label: "Loading topics…" }];
    const cur = pane?.objectLabel;
    const topics = o.topics.filter((t) => this.match(t.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const groups = o.groups.filter((g) => this.match(g.groupId)).sort((a, b) => a.groupId.localeCompare(b.groupId, undefined, { numeric: true }));
    const out: NavItem[] = [];
    const cap = 150;
    if (topics.length) {
      out.push({ header: true, label: "Topics", meta: String(topics.length) });
      for (const t of topics.slice(0, cap)) {
        out.push({
          label: t.name,
          meta: `${t.partitions}p`,
          badgeIcon: "topic",
          current: cur?.glyph === "topic" && cur.name === t.name,
          run: () => this.host.openTopic(e.config.id, t.name),
        });
      }
      if (topics.length > cap) out.push({ note: true, label: `…and ${topics.length - cap} more — keep typing to narrow down` });
    }
    if (groups.length) {
      out.push({ header: true, label: "Consumer groups", meta: String(groups.length) });
      for (const g of groups.slice(0, cap)) {
        out.push({
          label: g.groupId,
          meta: stateLabel(g.state),
          badgeIcon: "group",
          current: cur?.glyph === "group" && cur.name === g.groupId,
          run: () => this.host.openGroup(e.config.id, g.groupId),
        });
      }
    }
    if (!out.length) out.push({ note: true, label: this.q ? `No topic or group contains “${this.qRaw}”` : "This cluster has no topics yet" });
    return out;
  }

  private objItems(): NavItem[] {
    const pane = this.pane;
    const e = this.entry();
    if (!pane || !e) return [{ note: true, label: "Choose a data source first" }];
    if (e.status !== "connected") return [{ note: true, label: "Not connected" }];
    if (e.config.driver === "redis") return this.redisKeyItems();
    if (e.config.driver === "kafka") return this.kafkaItems(e);
    const schemas = store.schemasFor(pane.connId, pane.database);
    if (schemas.length === 0) return [{ note: true, label: "Loading objects…" }];
    const driver = e.config.driver;
    const dbName = pane.effectiveDatabase;
    const cur = pane.currentSchemaName();
    const ordered = [...schemas].sort((a, b) => Number(b.name === cur) - Number(a.name === cur));
    const out: NavItem[] = [];

    const make = (s: SchemaNode, name: string, kind: ObjKind, meta: string): NavItem => ({
      label: name,
      meta,
      badgeIcon: OBJ_ICON[kind],
      run: (nc) => this.openObject(e, s, name, kind, nc, schemas),
    });
    const recents = getRecent(e.config.id).filter((r) => r.db === dbName && schemas.some((s) => s.name === r.schema) && (this.match(r.name) || this.match(`${r.schema}.${r.name}`)));
    if (recents.length) {
      out.push({ header: true, label: "Recent" });
      for (const r of recents) {
        const s = schemas.find((x) => x.name === r.schema);
        if (s) out.push(make(s, r.name, r.kind, `${r.schema} · ${r.kind === "materialized" ? "matview" : r.kind}`));
      }
    }
    let total = 0;
    let more = 0;
    for (const s of ordered) {
      const entries: NavItem[] = [];
      const hit = (n: string): boolean => this.match(n) || this.match(`${s.name}.${n}`);
      for (const t of s.tables as TableNode[]) if (hit(t.name)) entries.push(make(s, t.name, t.kind, t.kind === "materialized" ? "matview" : t.kind));
      for (const r of s.routines ?? []) if (hit(r.name)) entries.push(make(s, r.name + "()", r.kind, r.kind));
      for (const q of s.sequences ?? []) if (hit(q)) entries.push(make(s, q, "sequence", "sequence"));
      if (!entries.length) continue;
      const room = MAX_OBJECTS - total;
      if (room <= 0) {
        more += entries.length;
        continue;
      }
      const shown = entries.slice(0, room);
      more += entries.length - shown.length;
      total += shown.length;
      const scopeName = driver === "mysql" || driver === "sqlite" ? s.name : `${dbName ?? ""}.${s.name}`;
      out.push({ header: true, label: "In " + scopeName, meta: String(entries.length) }, ...shown);
    }
    if (more > 0) out.push({ note: true, label: `…and ${more} more — keep typing to narrow down` });
    return out;
  }

  private openObject(e: ConnEntry, s: SchemaNode, shownName: string, kind: ObjKind, newConsole: boolean, _schemas: SchemaNode[]): void {
    const pane = this.pane;
    const name = shownName.replace(/\(\)$/, "");
    const id = e.config.id;
    const driver = e.config.driver;
    const dbName = pane?.effectiveDatabase ?? e.defaultDb ?? null;
    pushRecent(id, { db: dbName, schema: s.name, name, kind });
    const consoleDb = pane ? pane.database : null;
    const cp = pane && pane.kind === "console" ? (pane as ConsolePane) : null;
    if (kind === "table" || kind === "view" || kind === "materialized") {
      const sql = `SELECT * FROM ${qualifiedName(driver, s.name, name)} `;
      if (newConsole || !cp) this.host.openConsole(id, { sql, run: true, title: name, table: name, database: consoleDb, schema: s.name });
      else {
        // Keep the user's work: add the query as a new statement instead of replacing the text.
        cp.insertStatement(sql, true);
        void cp.runSqlText(sql);
        cp.focus();
      }
      return;
    }
    let sql = "";
    if (kind === "sequence") sql = sequenceSql(driver, s.name, name);
    else {
      const r = s.routines.find((x) => x.name === name && x.kind === kind);
      sql = r ? routineSkeleton(driver, s.name, r) : `${kind === "procedure" ? "CALL" : "SELECT"} ${qualifiedName(driver, s.name, name)}()`;
    }
    if (newConsole || !cp) this.host.openConsole(id, { sql, title: name, database: consoleDb, schema: s.name });
    else cp.insertStatement(sql);
  }
}


