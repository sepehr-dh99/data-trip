// AI assistant UI of one SQL console (board N): the inline prompt box (⌘I / ✦ Ask AI), the pending insertion's
// action bar (Accept ⇥ · Reject esc · Refine… · Explain), "Fix with AI" in the error view and Explain selection.
// Generated SQL is only ever inserted into the editor; nothing runs until the user runs it.
import "../styles/ai.css";
import { api } from "../api";
import type { AiMode, AiProviderStatus, AiRequest, AiResult, Driver, QueryResult, SchemaNode } from "../types";
import type { EditorView } from "@codemirror/view";
import { copyText, errMsg, h } from "./dom";
import { toast } from "./toast";
import { getSettings } from "./settings";
import { shortcutLabel } from "./keymap";
import { splitOptionsFor } from "./sqlutil";
import { isDesktop } from "../platform";
import { openSettings } from "./dialogs";
import { store } from "./state";
import {
  AI_DRIVERS,
  DIALECT_NAMES,
  SAMPLE_TABLES,
  aiBlockedReason,
  buildSchemaContext,
  loadProviders,
  modelFor,
  providerChip,
  providerShort,
  renderSamples,
  sampleSql,
  samplesAllowed,
} from "./ai";
import type { SchemaContext } from "./ai";
import { buildCrossContext, checkCrossSql, detectCrossSource, refinePrompt, sourcesSection } from "./aiCross";
import type { AiSourceInfo, CrossDetect } from "./aiCross";
import { routeStatement, sourceRef } from "./federation";
import type { CatalogSource, RouteContext } from "./federation";
import { acceptPending, pendingOf, pendingText, rejectKeepTarget, rejectPending, showDiff, showInsertion } from "./aiEditor";
import type { AiBarModel } from "./aiEditor";

/** What the assistant needs from its console. */
export interface AiConsoleHost {
  /** The editor container (.c-editor): the prompt box floats in it. */
  readonly wrap: HTMLElement;
  view(): EditorView;
  connId(): string;
  driver(): Driver;
  /** Effective database name (null = unknown). */
  database(): string | null;
  defaultSchema(): string | null;
  serverVersion(): string;
  schemas(): SchemaNode[];
  /** Loads the database's introspection when it isn't yet (resolves either way). */
  ensureSchemas(): Promise<void>;
  isLineBased(): boolean;
  /** Runs one read-only sample query on the console's session (sample rows option). */
  sample(sql: string): Promise<QueryResult>;
  statements(): { text: string; from: number; to: number }[];
  focus(): void;
  /** This console is the visible tab (the app's Ask AI command / menu item goes to it). */
  isActive(): boolean;
  /** v0.15 cross-source: every SQL data source of the connection list. */
  catalog(): CatalogSource[];
  /** How the console routes a statement (CONTRACT v0.13). */
  routeCtx(): RouteContext;
  /** Database an attached source reads from (null = its default / not attached). */
  sourceDatabase(connId: string): string | null;
  /** Connects a source in the explorer and loads that database's introspection; true when ready. */
  loadSource(connId: string, database: string | null): Promise<boolean>;
}

/** The cross-source side of one request: what was detected and the sources' info after loading. */
interface CrossPlan {
  det: CrossDetect;
  /** Own source first, then the involved ones. */
  involved: AiSourceInfo[];
  all: AiSourceInfo[];
}

// The app dispatches `dt-action` { id: "askAi" } on window for ⌘I, the command palette and the menu; the
// assistant of the visible console handles it (preventDefault tells the app it was handled).
const instances = new Set<AiAssist>();
window.addEventListener("dt-action", (e: Event) => {
  const d = (e as CustomEvent<{ id?: string } | null>).detail;
  if (!d || d.id !== "askAi") return;
  e.preventDefault();
  for (const a of instances) {
    if (a.isActive()) {
      a.open();
      return;
    }
  }
  toast("Open a SQL console to ask AI for a query", "info");
});

const CANCELLED = "AI_CANCELLED";
const norm = (x: string): string => x.replace(/\s+/g, " ").trim().replace(/;$/, "").trim();

interface LastRun {
  mode: AiMode;
  prompt: string;
  result: AiResult;
  tables: number;
}

type BoxKind = "ask" | "refine" | "fix" | "explain";

export class AiAssist {
  private box: HTMLElement | null = null;
  private boxKind: BoxKind = "ask";
  private input: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private chipsEl: HTMLElement | null = null;
  private genBtn: HTMLButtonElement | null = null;
  private running = false;
  private lastPrompt = "";
  private last: LastRun | null = null;
  private explanation: string | null = null;
  private explainOpen = false;
  private explaining = false;
  private barEl: HTMLElement | null = null;
  private model: AiBarModel | null = null;
  private fixContext: { sql: string; error: string } | null = null;
  private anchorPos = 0;
  private providers: AiProviderStatus[] = [];
  private chipTimer: number | undefined;
  private onScroll = (): void => this.place();

  constructor(private host: AiConsoleHost) {
    instances.add(this);
  }

  isActive(): boolean {
    return this.host.isActive();
  }

  /** True for SQL consoles (Redis / Kafka get no AI). */
  get supported(): boolean {
    return !this.host.isLineBased() && AI_DRIVERS.has(this.host.driver());
  }

  get busy(): boolean {
    return this.running;
  }

  private conn() {
    return store.conns.get(this.host.connId())?.config ?? null;
  }

  /** Refuses (with a toast) when AI is not available for this console. */
  private allowed(): boolean {
    if (!this.supported) {
      toast("The AI assistant writes SQL — it isn't available in Redis or Kafka consoles", "info");
      return false;
    }
    const why = aiBlockedReason(this.conn());
    if (why) {
      toast(why, "info", 6000);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- prompt box

  /** ⌘I / ✦ Ask AI: opens the prompt box under the cursor line (Refine when an AI insertion is pending). */
  open(): void {
    if (this.box) {
      this.input?.focus();
      return;
    }
    if (!this.allowed()) return;
    const view = this.host.view();
    const pending = pendingOf(view.state);
    if (pending) {
      this.openBox("refine", this.lastPrompt);
      return;
    }
    this.openBox("ask", "");
  }

  /** Closes the prompt box (cancels a running request). */
  close(): void {
    if (this.running) void api.aiCancel().catch(() => undefined);
    this.removeBox();
  }

  private removeBox(): void {
    if (!this.box) return;
    this.box.remove();
    this.box = null;
    this.input = null;
    this.statusEl = null;
    this.chipsEl = null;
    this.genBtn = null;
    this.host.view().scrollDOM.removeEventListener("scroll", this.onScroll);
    window.clearTimeout(this.chipTimer);
  }

  private openBox(kind: BoxKind, value: string, anchor?: number): void {
    this.removeBox();
    this.boxKind = kind;
    if (kind === "ask") this.fixContext = null;
    const view = this.host.view();
    const sel = view.state.selection.main;
    const p = pendingOf(view.state);
    this.anchorPos = anchor ?? (p ? Math.max(...p.added.map((s) => s.bodyTo), sel.head) : sel.empty ? sel.head : sel.to);
    const placeholder =
      kind === "refine" ? "How should the query change? (e.g. “only this year, group by month”)" : kind === "fix" ? "Optional: anything the fix should keep in mind" : "Describe the query — e.g. revenue per country for the last 30 days, top 10";
    const input = h("input", {
      class: "ai-input",
      type: "text",
      spellcheck: false,
      autocomplete: "off",
      "aria-label": kind === "refine" ? "Refine the query" : "Describe the query",
      placeholder,
    });
    input.value = value;
    const genLabel = kind === "refine" ? "Refine ↵" : kind === "fix" ? "Fix ↵" : "Generate ↵";
    const gen = h("button", { class: "ai-gen", type: "button", onclick: () => this.submit() }, genLabel);
    const closeBtn = h("button", { class: "ai-x", type: "button", "aria-label": "Close", title: "Close (Esc)", onclick: () => this.close() }, "✕");
    const status = h("div", { class: "ai-status", hidden: true });
    const chips = h("div", { class: "ai-chips" });
    const box = h(
      "div",
      { class: "ai-box", role: "dialog", "aria-label": "Ask AI" },
      h("div", { class: "ai-row" }, h("span", { class: "ai-spark", "aria-hidden": "true" }, "✦"), input, gen, closeBtn),
      chips,
      status,
    );
    if (!sel.empty && kind === "ask") {
      const ex = h("button", { class: "ai-chip ai-chip-btn", type: "button", title: "Explain the selected SQL in plain language", onclick: () => void this.explainSelection() }, "Explain selection");
      box.insertBefore(h("div", { class: "ai-sel" }, ex, h("span", { class: "ai-dim" }, "or describe a new query above")), status);
    }
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        this.submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (this.running) void api.aiCancel().catch(() => undefined);
        else {
          this.removeBox();
          this.host.focus();
        }
      }
    });
    input.addEventListener("input", () => {
      window.clearTimeout(this.chipTimer);
      this.chipTimer = window.setTimeout(() => this.renderChips(), 180);
    });
    this.box = box;
    this.input = input;
    this.statusEl = status;
    this.chipsEl = chips;
    this.genBtn = gen;
    this.host.wrap.appendChild(box);
    view.scrollDOM.addEventListener("scroll", this.onScroll);
    this.renderChips();
    this.place();
    input.focus();
    input.select();
    void this.host.ensureSchemas().then(() => this.renderChips());
    void loadProviders().then((list) => {
      this.providers = list;
      this.renderChips();
    });
  }

  /** Puts the box under the anchor line (above it when there is no room below). */
  private place(): void {
    const box = this.box;
    if (!box) return;
    const view = this.host.view();
    const wrapRect = this.host.wrap.getBoundingClientRect();
    const pos = Math.min(this.anchorPos, view.state.doc.length);
    const line = view.state.doc.lineAt(pos);
    const c = view.coordsAtPos(line.to) ?? view.coordsAtPos(line.from);
    const content = view.contentDOM.getBoundingClientRect();
    const left = Math.max(8, Math.min(content.left - wrapRect.left + 4, wrapRect.width - box.offsetWidth - 8));
    box.style.left = left + "px";
    const hgt = box.offsetHeight;
    let top = c ? c.bottom - wrapRect.top + 6 : 8;
    if (c && top + hgt > wrapRect.height - 4) top = Math.max(4, c.top - wrapRect.top - hgt - 6);
    box.style.top = Math.max(4, Math.min(top, Math.max(4, wrapRect.height - hgt - 4))) + "px";
  }

  /** The text tables are picked from: the request plus the SQL / error it is about. */
  private contextText(): string {
    const parts = [this.input?.value ?? ""];
    if (this.boxKind === "refine") parts.push(pendingText(this.host.view().state) ?? "");
    if (this.fixContext) parts.push(this.fixContext.sql, this.fixContext.error);
    return parts.join("\n");
  }

  private schemaContext(text: string): SchemaContext {
    const s = getSettings();
    return buildSchemaContext({
      driver: this.host.driver(),
      schemas: this.host.schemas(),
      database: this.host.database(),
      defaultSchema: this.host.defaultSchema(),
      text,
      autoTables: s.ai.autoTables,
    });
  }

  private renderChips(): void {
    const el = this.chipsEl;
    if (!el) return;
    const s = getSettings();
    const conn = this.conn();
    const ctx = this.schemaContext(this.contextText());
    const db = this.host.database();
    const chip = (text: string, cls = "", title = ""): HTMLElement => h("span", { class: "ai-chip " + cls, title }, text);
    const src = h("span", { class: "ai-chip", title: "Data source · database" }, h("span", { class: "ai-dot", style: `background:${conn?.color || "var(--accent)"}` }), `${conn?.name ?? "Data source"}${db ? " · " + db : ""}`);
    let tables: HTMLElement;
    if (ctx.namesOnly) tables = chip("Table names only", "", "Big schema and nothing in the request matched a table: only table names are sent");
    else if (ctx.tables.length === 0) tables = chip("No tables loaded", "warn", "The schema of this database isn't loaded — the AI only sees your request");
    else {
      const names = ctx.tables.map((t) => t.table.name);
      const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
      tables = h("span", { class: "ai-chip", title: names.join(", ") }, `Tables: ${shown}`, ctx.picked ? h("span", { class: "ai-dim" }, " (picked from your question)") : h("span", { class: "ai-dim" }, " (whole schema)"));
    }
    // v0.15: other data sources the request involves (cached metadata only; loaded when the request is sent)
    const crossChips: HTMLElement[] = [];
    const plan = this.crossPlan(this.contextText(), this.currentSqlForContext());
    if (plan.det.cross) {
      const others = plan.involved.filter((x) => !x.own);
      const why = others.map((x) => `${x.name} (${x.ref}) — ${plan.det.reasons[x.connId] ?? "named"}`).join("\n");
      crossChips.push(
        h(
          "span",
          { class: "ai-chip ai-cross", title: (why ? why + "\n" : "") + "Writes a cross-source query (source.database.table, runs in SQLite) when the request needs it" },
          others.length ? `Across: ${others.map((x) => x.ref).slice(0, 3).join(" · ")}${others.length > 3 ? ` +${others.length - 3}` : ""}` : "Across data sources",
        ),
      );
      const ct = buildCrossContext(plan.involved, this.contextText(), s.ai.autoTables);
      if (ct.tables.length) {
        const names = ct.tables.map((t) => `${t.ref}.${t.table.name}`);
        tables = h("span", { class: "ai-chip", title: names.join(", ") }, `Tables: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`, h("span", { class: "ai-dim" }, " (from each source)"));
      }
    }
    for (const b of plan.det.blocked) {
      const e = store.conns.get(b.connId);
      crossChips.push(chip(`${e?.config.name ?? "Source"}: AI blocked`, "warn", b.essential ? "Production data source with “Block AI for production data sources” on — the request can't be sent while it names this source" : "Production data source with “Block AI for production data sources” on — its schema isn't sent"));
    }
    const samples = samplesAllowed(conn, s);
    const data = samples ? chip("Schema + 20 sample rows", "amber", "Sample rows of up to 3 tables are sent (Settings › AI assistant)") : chip("Schema only · no row data", "ok", "Only table and column names and types are sent");
    const status = this.providers.find((p) => p.id === s.ai.provider);
    const prov = h(
      "button",
      { class: "ai-chip ai-prov" + (status && !status.available ? " warn" : ""), type: "button", title: status ? status.detail : "Settings › AI assistant", onclick: () => openSettings("ai") },
      status && !status.available ? `${providerShort(s.ai.provider)} · not set up` : providerChip(s, status),
    );
    el.replaceChildren(src, ...crossChips, tables, data, h("span", { class: "spacer" }), prov);
  }

  private setRunningUi(on: boolean, text = ""): void {
    this.running = on;
    if (this.input) this.input.disabled = on;
    if (this.genBtn) {
      this.genBtn.textContent = on ? "Cancel" : this.boxKind === "refine" ? "Refine ↵" : this.boxKind === "fix" ? "Fix ↵" : "Generate ↵";
      this.genBtn.classList.toggle("cancel", on);
    }
    const st = this.statusEl;
    if (st) {
      st.hidden = !on && !st.classList.contains("err");
      if (on) {
        st.className = "ai-status";
        st.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, text), h("span", { class: "ai-dim" }, " · Esc cancels"));
      }
    }
    this.box?.classList.toggle("running", on);
    this.place();
  }

  private showError(msg: string): void {
    const st = this.statusEl;
    if (!st) {
      toast(msg, "error");
      return;
    }
    st.hidden = false;
    st.className = "ai-status err";
    const open = h("button", { class: "ai-link", type: "button", onclick: () => openSettings("ai") }, "AI settings…");
    st.replaceChildren(h("span", null, msg), open);
    this.place();
  }

  private submit(): void {
    if (this.running) {
      void api.aiCancel().catch(() => undefined);
      return;
    }
    const text = (this.input?.value ?? "").trim();
    if (this.boxKind === "fix" && this.fixContext) void this.run("fix", text);
    else if (this.boxKind === "refine") void this.run("refine", text);
    else {
      if (!text) {
        this.input?.focus();
        return;
      }
      void this.run("write", text);
    }
  }

  // ---------------------------------------------------------------- generation

  // ---------------------------------------------------------------- cross-source context (v0.15)

  /** Every SQL data source as the assistant sees it (explorer cache; nothing is loaded). */
  private sourceInfos(): AiSourceInfo[] {
    const cat = this.host.catalog();
    const ownId = this.host.connId();
    return cat.map((c) => {
      const e = store.conns.get(c.connId);
      const own = c.connId === ownId;
      const att = own ? null : this.host.sourceDatabase(c.connId);
      return {
        connId: c.connId,
        name: c.name,
        driver: c.driver,
        ref: sourceRef(c, cat),
        database: own ? this.host.database() : c.driver === "sqlite" ? null : (att ?? e?.defaultDb ?? null),
        databases: (e?.databases ?? []).map((d) => ({ name: d.name, isSystem: d.isSystem })),
        schemas: own ? this.host.schemas() : store.schemasFor(c.connId, att),
        defaultSchema: own ? this.host.defaultSchema() : store.defaultSchemaFor(c.connId, att),
        own,
        blocked: !own && aiBlockedReason(e?.config) !== null,
      };
    });
  }

  /** The SQL a refine / fix / explain is about (its sources count as involved). */
  private currentSqlForContext(): string | null {
    if (this.boxKind === "refine") return pendingText(this.host.view().state);
    if (this.fixContext) return this.fixContext.sql;
    return null;
  }

  /** Detection over cached metadata: which other sources the request (and its SQL) involve. */
  private crossPlan(text: string, sql: string | null): CrossPlan {
    const all = this.sourceInfos();
    let uses: string[] = [];
    if (sql) {
      const r = routeStatement(sql, this.host.routeCtx());
      if (r.kind === "federated") uses = [...new Set(r.uses.map((u) => u.connId))];
    }
    const det = detectCrossSource(text, all, uses);
    const own = all.find((x) => x.own);
    const involved = [...(own ? [own] : []), ...all.filter((x) => det.involved.includes(x.connId))];
    return { det, involved, all };
  }

  /** Refuses a request that names a blocked (production) source; null when it may go. */
  private blockedMessage(det: CrossDetect): string | null {
    const b = det.blocked.find((x) => x.essential);
    if (!b) return null;
    const name = store.conns.get(b.connId)?.config.name ?? "That data source";
    return `“${name}” is a production data source and “Block AI for production data sources” is on, so the assistant can't use it. Leave it out of the request, or change the setting in Settings › AI assistant.`;
  }

  private async request(
    mode: AiMode,
    prompt: string,
    currentSql: string | null,
    error: string | null,
    ctxText: string,
  ): Promise<{ result: AiResult; tables: number; cross: CrossPlan | null }> {
    const s = getSettings();
    await this.host.ensureSchemas();
    // v0.15: the request may need other data sources — load their schemas lazily (explorer connect + introspect).
    let plan: CrossPlan | null = this.crossPlan(ctxText, currentSql);
    const refusal = this.blockedMessage(plan.det);
    if (refusal) throw new Error(refusal);
    if (!plan.det.cross) plan = null;
    else {
      const others = plan.involved.filter((x) => !x.own);
      await Promise.all(others.map((x) => this.host.loadSource(x.connId, this.host.sourceDatabase(x.connId)).catch(() => false)));
      const all = this.sourceInfos();
      plan = { det: plan.det, all, involved: plan.involved.map((x) => all.find((y) => y.connId === x.connId) ?? x) };
    }
    const list = sourcesSection(plan ? plan.all : this.sourceInfos());
    let schemaText: string;
    let count: number;
    let sampleTables: { schema: string; name: string }[];
    if (plan) {
      const ct = buildCrossContext(plan.involved, ctxText, s.ai.autoTables);
      schemaText = ct.text;
      count = ct.tables.length;
      // Samples only from the console's own source (on its session), never from the others.
      sampleTables = ct.tables.filter((t) => t.connId === this.host.connId()).map((t) => ({ schema: t.schema, name: t.table.name }));
    } else {
      const ctx = this.schemaContext(ctxText);
      schemaText = ctx.text;
      count = ctx.tables.length;
      sampleTables = ctx.tables.map((t) => ({ schema: t.schema, name: t.table.name }));
    }
    if (samplesAllowed(this.conn(), s) && mode !== "explain") {
      for (const t of sampleTables.slice(0, SAMPLE_TABLES)) {
        try {
          const res = await this.host.sample(sampleSql(this.host.driver(), t.schema, t.name));
          schemaText += "\n\n" + renderSamples(this.host.driver(), t.schema, t.name, res);
        } catch {
          /* a table we can't read just goes without samples */
        }
      }
    }
    if (list) schemaText = list + "\n\n" + schemaText;
    const version = this.host.serverVersion();
    const dialect = DIALECT_NAMES[this.host.driver()] ?? "SQL";
    const req: AiRequest = {
      provider: s.ai.provider,
      model: modelFor(s),
      baseUrl: s.ai.provider === "openai" && s.ai.baseUrl ? s.ai.baseUrl : null,
      mode,
      prompt,
      driver: this.host.driver(),
      dialectHint: version ? `${dialect} (server ${version.slice(0, 60)})` : dialect,
      schemaContext: schemaText,
      currentSql,
      error,
      crossSource: plan !== null,
    };
    const sourceIds = isDesktop() ? undefined : [this.host.connId(), ...(plan?.involved.map((source) => source.connId) ?? [])];
    const result = await api.aiGenerate(req, sourceIds);
    return { result, tables: count, cross: plan };
  }

  /**
   * Generated SQL that runs (or tries to run) across sources is checked locally first; problems get ONE automatic
   * refine round naming them. Returns the (possibly refined) result and what is still wrong.
   */
  private async checkCross(out: { result: AiResult; tables: number; cross: CrossPlan | null }, ctxText: string): Promise<{ out: { result: AiResult; tables: number; cross: CrossPlan | null }; left: string[] }> {
    const plan = out.cross;
    const sql = (out.result.sql ?? "").trim();
    if (!plan || !sql) return { out, left: [] };
    const named = Object.keys(plan.det.reasons).filter((id) => plan.det.reasons[id] === "named");
    const first = checkCrossSql(sql, this.host.routeCtx(), plan.all, named);
    if (first.problems.length === 0) return { out, left: [] };
    const who = providerShort(getSettings().ai.provider);
    this.setRunningUi(true, `${who} is fixing the cross-source query (${first.problems[0].split(" — ")[0]})…`);
    const again = await this.request("refine", refinePrompt(first.problems), sql, null, ctxText + "\n" + sql);
    const sql2 = (again.result.sql ?? "").trim();
    if (!sql2) return { out, left: first.problems };
    again.result.elapsedMs += out.result.elapsedMs;
    const second = checkCrossSql(sql2, this.host.routeCtx(), (again.cross ?? plan).all, named);
    return { out: { ...again, cross: again.cross ?? plan }, left: second.problems };
  }

  private async run(mode: AiMode, prompt: string): Promise<void> {
    if (this.running || !this.allowed()) return;
    const view = this.host.view();
    const s = getSettings();
    const who = providerShort(s.ai.provider);
    let currentSql: string | null = null;
    let error: string | null = null;
    if (mode === "refine") currentSql = pendingText(view.state);
    else if (mode === "fix" && this.fixContext) {
      currentSql = this.fixContext.sql;
      error = this.fixContext.error;
    } else {
      const sel = view.state.selection.main;
      if (!sel.empty) currentSql = view.state.sliceDoc(sel.from, sel.to);
    }
    if (mode === "refine" && !currentSql) mode = "write";
    this.lastPrompt = mode === "fix" ? this.lastPrompt : prompt;
    this.setRunningUi(true, mode === "fix" ? `${who} is fixing the statement…` : mode === "refine" ? `${who} is refining…` : `${who} is writing SQL…`);
    let out: { result: AiResult; tables: number; cross: CrossPlan | null };
    let left: string[] = [];
    try {
      const ctxText = this.contextText();
      out = await this.request(mode, prompt, currentSql, error, ctxText);
      ({ out, left } = await this.checkCross(out, ctxText));
    } catch (e) {
      const msg = errMsg(e);
      this.setRunningUi(false);
      if (msg.startsWith(CANCELLED)) {
        if (this.statusEl) this.statusEl.hidden = true;
        this.input?.focus();
        return;
      }
      this.showError(msg);
      this.input?.focus();
      return;
    }
    this.setRunningUi(false);
    const sql = (out.result.sql ?? "").trim();
    if (!sql) {
      this.showError(`${who} returned no SQL. Try rephrasing the request.`);
      return;
    }
    this.last = { mode, prompt, result: out.result, tables: out.tables };
    this.explanation = out.result.explanation;
    this.explainOpen = false;
    this.removeBox();
    const model = this.makeModel();
    if (mode === "fix" || (mode === "refine" && pendingOf(view.state)?.kind === "diff")) {
      const target = mode === "refine" ? rejectKeepTarget(view) : this.findStatement(this.fixContext?.sql ?? "");
      if (!target) {
        toast("The statement is no longer in the editor — the fix was inserted as a new statement instead", "info");
        showInsertion(view, sql, splitOptionsFor(this.host.driver()), model);
      } else {
        // The statement's terminating `;` stays where it is.
        const replacement = sql.replace(/;\s*$/, "");
        if (!showDiff(view, target.from, target.to, replacement, model)) {
          toast(`${who} found nothing to change${this.explanation ? ": " + this.explanation : ""}`, "info", 6000);
          this.model = null;
          this.host.focus();
          return;
        }
      }
    } else {
      showInsertion(view, sql, splitOptionsFor(this.host.driver()), model);
    }
    this.model = model;
    this.host.focus();
    if (left.length) toast(`Check the cross-source query before running it: ${left[0]}`, "info", 8000);
  }

  // ---------------------------------------------------------------- action bar

  private barText(): string {
    const r = this.last;
    if (!r) return "";
    const secs = (r.result.elapsedMs / 1000).toFixed(1);
    const who = providerShort(r.result.provider);
    if (pendingOf(this.host.view().state)?.kind === "diff") {
      const m = /^.*?[.!?](?=\s|$)/.exec(this.explanation ?? "");
      const first = m ? m[0] : (this.explanation ?? "");
      return first && first.length <= 90 ? first : `Suggested fix · ${who} · ${secs} s`;
    }
    return `${who} · ${secs} s · used ${r.tables} table${r.tables === 1 ? "" : "s"}`;
  }

  private makeModel(): AiBarModel {
    const model: AiBarModel = {
      render: (): HTMLElement => {
        const el = h("div", { class: "ai-barwrap" });
        this.barEl = el;
        this.fillBar(el);
        return el;
      },
      accept: () => this.accept(),
      reject: () => this.reject(),
    };
    return model;
  }

  private fillBar(el: HTMLElement): void {
    const btn = (label: string, cls: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = h("button", { class: "ai-bbtn " + cls, type: "button", title }, label);
      // mousedown: keep the editor's focus and selection (the bar lives inside the editor)
      b.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault());
      b.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        fn();
      });
      return b;
    };
    const bar = h(
      "div",
      { class: "ai-bar", role: "toolbar", "aria-label": "AI suggestion" },
      h("span", { class: "ai-spark", "aria-hidden": "true" }, "✦"),
      h("span", { class: "ai-bartext" }, this.barText()),
      btn("Accept ⇥", "primary", "Insert the suggestion (Tab)", () => this.accept()),
      btn("Reject esc", "", "Discard the suggestion (Esc)", () => this.reject()),
      btn("Refine…", "", "Ask for a change to this suggestion", () => this.openBox("refine", this.lastPrompt)),
      btn(this.explainOpen ? "Hide explanation" : "Explain", "", "Short description of what the SQL does", () => void this.toggleExplain()),
    );
    const parts: HTMLElement[] = [bar];
    if (this.explainOpen || this.explaining) {
      parts.push(
        h(
          "div",
          { class: "ai-explain", role: "note" },
          this.explaining ? [h("span", { class: "spinner", "aria-hidden": "true" }), " Explaining…"] : this.explanation ?? "No explanation available.",
        ),
      );
    }
    el.replaceChildren(...parts);
  }

  private refreshBar(): void {
    if (this.barEl && this.barEl.isConnected) this.fillBar(this.barEl);
    this.host.view().requestMeasure();
  }

  private async toggleExplain(): Promise<void> {
    if (this.explaining) return;
    if (this.explanation || this.explainOpen) {
      this.explainOpen = !this.explainOpen;
      this.refreshBar();
      return;
    }
    const sql = pendingText(this.host.view().state);
    if (!sql) return;
    this.explaining = true;
    this.refreshBar();
    try {
      const out = await this.request("explain", "", sql, null, sql);
      this.explanation = out.result.explanation ?? "No explanation available.";
    } catch (e) {
      const msg = errMsg(e);
      this.explanation = msg.startsWith(CANCELLED) ? null : `Couldn't explain: ${msg}`;
    } finally {
      this.explaining = false;
      this.explainOpen = this.explanation !== null;
      this.refreshBar();
    }
  }

  private accept(): void {
    const view = this.host.view();
    const kind = pendingOf(view.state)?.kind;
    if (!acceptPending(view)) return;
    this.model = null;
    this.barEl = null;
    this.host.focus();
    const run = shortcutLabel("runStatement") || "Run";
    toast(kind === "diff" ? `Fix applied — nothing runs until you press ${run}` : `Inserted — nothing runs until you press ${run}`, "ok");
  }

  private reject(): void {
    if (this.explaining) void api.aiCancel().catch(() => undefined);
    rejectPending(this.host.view());
    this.model = null;
    this.barEl = null;
    this.host.focus();
  }

  // ---------------------------------------------------------------- fix / explain selection

  private findStatement(sql: string): { from: number; to: number } | null {
    const want = norm(sql);
    if (!want) return null;
    const all = this.host.statements().filter((s) => norm(s.text) === want);
    if (!all.length) return null;
    const head = this.host.view().state.selection.main.head;
    const hit = all.find((s) => head >= s.from && head <= s.to) ?? all[0];
    return { from: hit.from, to: hit.to };
  }

  /** "✦ Fix with AI" + "Copy error" for a failed statement (null when AI doesn't apply here). */
  fixActions(sql: string, error: string): HTMLElement | null {
    if (!sql.trim() || !this.supported) return null;
    if (aiBlockedReason(this.conn())) return null;
    const fix = h("button", { class: "btn sm ai-fix-btn", type: "button", title: "Ask the AI assistant to fix this statement" }, "✦ Fix with AI");
    fix.addEventListener("click", () => this.fix(sql, error));
    const copy = h("button", { class: "btn sm", type: "button", onclick: () => void copyText(error).then(() => toast("Error copied", "ok")) }, "Copy error");
    return h(
      "div",
      { class: "ai-fix" },
      h("div", { class: "ai-fix-row" }, fix, copy),
      h("div", { class: "ai-fix-hint" }, "Sends the statement, the error and the schema of the tables it uses. The fix shows as a diff you accept or reject."),
    );
  }

  /** Fix with AI: asks for a corrected statement and shows it as a diff over the failed one. */
  fix(sql: string, error: string): void {
    if (!this.allowed() || this.running) return;
    const target = this.findStatement(sql);
    if (!target) {
      toast("The failed statement is no longer in the editor", "info");
      return;
    }
    rejectPending(this.host.view());
    this.fixContext = { sql, error };
    this.openBox("fix", "", target.to);
    void this.run("fix", "");
  }

  /** Explain selection: a plain-language description of the selected SQL, shown in the prompt box. */
  private async explainSelection(): Promise<void> {
    if (this.running) return;
    const view = this.host.view();
    const sel = view.state.selection.main;
    const sql = view.state.sliceDoc(sel.from, sel.to).trim();
    if (!sql) return;
    this.setRunningUi(true, `${providerShort(getSettings().ai.provider)} is reading the selection…`);
    try {
      const out = await this.request("explain", "", sql, null, sql);
      this.setRunningUi(false);
      const st = this.statusEl;
      if (st) {
        st.hidden = false;
        st.className = "ai-status explain";
        const text = out.result.explanation ?? "No explanation available.";
        st.replaceChildren(h("span", { class: "ai-explain-text" }, text), h("button", { class: "ai-link", type: "button", onclick: () => void copyText(text).then(() => toast("Explanation copied", "ok")) }, "Copy"));
        this.place();
      }
    } catch (e) {
      const msg = errMsg(e);
      this.setRunningUi(false);
      if (!msg.startsWith(CANCELLED)) this.showError(msg);
    }
  }

  /** The console is closing / rebinding: drop the box and any pending suggestion. */
  dispose(): void {
    instances.delete(this);
    this.close();
    try {
      rejectPending(this.host.view());
    } catch {
      /* the view may already be destroyed */
    }
  }
}
