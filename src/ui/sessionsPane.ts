// Sessions & locks tab (v0.16, board W): every server session of a data source (user, application, state, duration,
// what it waits for, query), lock-wait chains, filters, auto-refresh 2 / 5 / 10 s, Cancel query / Kill session with a
// confirmation showing the exact command. Queries run through a dedicated session of this tab (never a console's);
// that session itself is protected.
import { api } from "../api";
import type { Driver, SessionInfo } from "../types";
import { DRIVER_LABELS } from "../types";
import { copyText, errMsg, h, icon } from "./dom";
import { opsConfirm } from "./opsDialogs";
import { applyTransactions, applyWaits, blockedChain, filterSessions, fmtDuration, lockChains, normalizeSessions, sessionCommand, sessionQueries } from "./sessionsData";
import type { SessionAction, SessionRow } from "./sessionsData";
import { store } from "./state";
import type { TabPane } from "./tabs";
import { toast } from "./toast";
import type { WsSessions } from "./workspace";
import "../styles/ops.css";

const INTERVALS = [2, 5, 10] as const;

export class SessionsPane implements TabPane {
  readonly kind = "sessions" as const;
  readonly el: HTMLElement;
  readonly controls: HTMLElement = h("div", { class: "cap-controls" });
  title = "Sessions & locks";
  database: string | null = null;
  readonly tabIcon = { icon: "server", cls: "kt-sessions" };

  private session: SessionInfo | null = null;
  private opening: Promise<SessionInfo> | null = null;
  private rows: SessionRow[] = [];
  private error: string | null = null;
  private loading = false;
  private loadedAt: Date | null = null;
  private alive = true;
  private timer: number | undefined;
  private auto = true;
  private every: (typeof INTERVALS)[number] = 5;
  private activeOnly = false;
  private hideIdle = false;
  private query = "";
  private sel: string | null = null;
  private note = "";
  private seq = 0;
  private headEl: HTMLElement;
  private filterEl: HTMLElement;
  private chainEl: HTMLElement;
  private tableEl: HTMLElement;
  private detailEl: HTMLElement;
  private noteEl: HTMLElement;
  private searchInput: HTMLInputElement;
  /** v0.17: restored on launch and not shown yet: nothing is loaded (no session) until first shown. */
  private lazy: (() => Promise<boolean>) | null = null;
  /** v0.17: filters / auto-refresh changed (the shell saves the workspace). */
  onChange: (() => void) | null = null;

  /**
   * `init.state`: filters and auto-refresh of a restored tab; `init.ensure`: restored on launch — connect (and
   * load) only when the tab is first shown.
   */
  constructor(public connId: string, init: { state?: WsSessions | null; ensure?: () => Promise<boolean> } = {}) {
    const st = init.state;
    if (st) {
      this.activeOnly = st.activeOnly;
      this.hideIdle = st.hideIdle;
      this.query = st.query;
      this.auto = st.auto;
      this.every = INTERVALS.find((n) => n === st.every) ?? 5;
    }
    this.headEl = h("div", { class: "ss-head" });
    this.searchInput = h("input", {
      type: "search",
      placeholder: "Filter by user, application or query",
      "aria-label": "Filter sessions",
      spellcheck: false,
      oninput: () => {
        this.query = this.searchInput.value;
        this.renderTable();
        this.onChange?.();
      },
    });
    this.searchInput.value = this.query;
    this.filterEl = h("div", { class: "ss-filters" });
    this.chainEl = h("div", { class: "ss-chain", hidden: true });
    this.tableEl = h("div", { class: "ss-table", role: "grid", "aria-label": "Sessions" });
    this.detailEl = h("div", { class: "ss-detail", hidden: true });
    this.noteEl = h("div", { class: "ss-note", hidden: true, role: "status" });
    this.el = h("div", { class: "sessions-view", tabindex: "-1" }, this.headEl, this.filterEl, this.chainEl, this.tableEl, this.detailEl, this.noteEl);
    this.title = `Sessions · ${this.connName}`;
    this.renderHead();
    this.renderFilters();
    if (!sessionQueries(this.driver)) {
      this.error =
        this.driver === "sqlite"
          ? "Sessions & locks doesn't apply to SQLite: a database file has no server sessions to list or kill."
          : `Sessions & locks isn't available for ${DRIVER_LABELS[this.driver]}.`;
      this.renderTable();
      return;
    }
    if (init.ensure) {
      this.lazy = init.ensure;
      this.renderTable();
      return;
    }
    void this.load();
    this.schedule();
  }

  /** v0.17: what restore on launch saves for this tab. */
  snapshot(): WsSessions {
    return { activeOnly: this.activeOnly, hideIdle: this.hideIdle, query: this.query, auto: this.auto, every: this.every };
  }

  /** v0.17: a restored tab shown for the first time: connect the data source, then load and start refreshing. */
  private async startLazy(): Promise<void> {
    const ensure = this.lazy;
    if (!ensure) return;
    this.lazy = null;
    this.loading = true;
    this.renderTable();
    let ok = false;
    try {
      ok = await ensure();
    } catch {
      ok = false;
    }
    this.loading = false;
    if (!this.alive) return;
    if (!ok) {
      this.lazy = ensure;
      this.error = `Couldn't connect to ${this.connName}. Show the tab again to retry.`;
      this.renderTable();
      return;
    }
    this.error = null;
    await this.load();
    this.schedule();
  }

  // ---------------------------------------------------------------- TabPane

  get driver(): Driver {
    return store.conns.get(this.connId)?.config.driver ?? "postgres";
  }
  private get connName(): string {
    return store.conns.get(this.connId)?.config.name ?? "Data source";
  }
  get effectiveDatabase(): string | null {
    return null;
  }
  get isRunning(): boolean {
    return false;
  }
  focus(): void {
    this.el.focus({ preventScroll: true });
    if (this.lazy) {
      if (this.visible && !this.loading) void this.startLazy();
      return;
    }
    if (this.visible && this.auto && !this.loading) void this.load(true);
  }
  updateSchema(): void {}
  dropSession(): void {
    // the data source was disconnected: this tab's session went with it
    this.session = null;
    this.opening = null;
    this.error = "The connection was closed. Reconnect the data source, then refresh.";
    this.renderTable();
  }
  async dispose(): Promise<void> {
    this.alive = false;
    window.clearTimeout(this.timer);
    const s = this.session;
    this.session = null;
    if (s) await api.closeSession(s.sessionId).catch(() => undefined);
  }
  async switchDatabase(): Promise<void> {}
  async switchConnection(): Promise<void> {}
  currentSchemaName(): string | null {
    return null;
  }
  async setDefaultSchema(): Promise<void> {}

  matches(connId: string): boolean {
    return this.connId === connId;
  }

  private get visible(): boolean {
    return this.alive && this.el.isConnected && !this.el.classList.contains("hidden");
  }

  // ---------------------------------------------------------------- data

  private ensureSession(): Promise<SessionInfo> {
    if (this.session) return Promise.resolve(this.session);
    if (!this.opening) {
      this.opening = api.openSession(this.connId, null).then(
        (s) => {
          if (!this.alive) {
            void api.closeSession(s.sessionId).catch(() => undefined);
            throw new Error("closed");
          }
          this.session = s;
          return s;
        },
        (e) => {
          this.opening = null;
          throw e;
        },
      );
    }
    return this.opening;
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    if (!this.alive || !this.auto) return;
    this.timer = window.setTimeout(async () => {
      if (this.visible && !this.loading && store.conns.get(this.connId)?.status === "connected") await this.load(true);
      this.schedule();
    }, this.every * 1000);
  }

  async load(quiet = false): Promise<void> {
    const q = sessionQueries(this.driver);
    if (!q || this.loading) return;
    const mine = ++this.seq;
    this.loading = true;
    if (!quiet) this.renderHead();
    try {
      const s = await this.ensureSession();
      const res = await api.execute(s.sessionId, q.list, 5000, false);
      const rows = normalizeSessions(this.driver, res.columns.map((c) => c.name), res.rows);
      if (q.trx) {
        try {
          const t = await api.execute(s.sessionId, q.trx, 5000, false);
          applyTransactions(rows, t.rows.map((r) => [String(r[0]), typeof r[1] === "number" ? r[1] : r[1] === null ? null : Number(r[1])]));
        } catch {
          /* no PROCESS privilege: states stay as reported */
        }
      }
      for (const w of q.waits) {
        try {
          const r = await api.execute(s.sessionId, w, 5000, false);
          applyWaits(rows, r.rows.map((x) => [String(x[0]), String(x[1])]));
          break;
        } catch {
          /* next variant (server version / privileges) */
        }
      }
      if (!this.alive || mine !== this.seq) return;
      this.rows = rows;
      this.error = null;
      this.loadedAt = new Date();
    } catch (e) {
      if (!this.alive || mine !== this.seq) return;
      const msg = errMsg(e);
      // the tab's session may have dropped (server restart): open a new one next time
      if (/connection|closed|broken|not connected|terminat/i.test(msg)) {
        this.session = null;
        this.opening = null;
      }
      if (!quiet || !this.rows.length) this.error = msg;
    } finally {
      if (mine === this.seq) this.loading = false;
      if (this.alive) {
        this.renderHead();
        this.renderTable();
      }
    }
  }

  // ---------------------------------------------------------------- rendering

  private swBtn(label: string, on: boolean, toggle: () => void, disabled = false): HTMLElement {
    const b = h("button", { class: "sw sm" + (on ? " on" : ""), type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, disabled, onclick: () => toggle() });
    return h("label", { class: "ss-switch" + (disabled ? " off" : "") }, b, label);
  }

  private renderHead(): void {
    const cfg = store.conns.get(this.connId)?.config;
    const live = this.loadedAt ? this.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    const seg = h(
      "div",
      { class: "seg ss-seg", role: "radiogroup", "aria-label": "Refresh interval" },
      INTERVALS.map((n) =>
        h("button", {
          class: "seg-btn" + (this.every === n ? " on" : ""),
          type: "button",
          role: "radio",
          "aria-checked": String(this.every === n),
          onclick: () => {
            this.every = n;
            this.renderHead();
            this.schedule();
            this.onChange?.();
          },
        }, `${n} s`),
      ),
    );
    this.headEl.replaceChildren(
      h("span", { class: "ss-pill" }, h("span", { class: "ss-badge", style: `background:${cfg?.color ?? "#8e44c4"}` }, (cfg?.driver ?? "pg").slice(0, 2).toUpperCase()), `${this.connName} — Sessions & locks`),
      h("span", { class: "ss-sub" }, "every server session, what it runs and what it waits for"),
      h("div", { class: "spacer" }),
      sessionQueries(this.driver)
        ? h("span", { class: "ss-headctl" },
            this.swBtn("Auto-refresh", this.auto, () => {
              this.auto = !this.auto;
              this.renderHead();
              this.schedule();
              this.onChange?.();
            }),
            this.auto ? seg : null,
            h("span", { class: "ss-live" + (this.auto ? " on" : "") }, this.loading && !live ? "loading…" : live ? `${this.auto ? "● live" : "paused"} · ${live}` : ""),
            h("button", { class: "icon-btn sm ss-refresh", type: "button", title: "Refresh now", "aria-label": "Refresh now", onclick: () => void this.load() }, icon("refresh", 14)),
          )
        : "",
    );
  }

  private renderFilters(): void {
    if (!sessionQueries(this.driver)) {
      this.filterEl.hidden = true;
      return;
    }
    const count = h("span", { class: "ss-count" });
    this.filterEl.replaceChildren(
      this.swBtn("Active only", this.activeOnly, () => {
        this.activeOnly = !this.activeOnly;
        this.renderFilters();
        this.renderTable();
        this.onChange?.();
      }),
      this.swBtn("Hide idle", this.hideIdle || this.activeOnly, () => {
        this.hideIdle = !this.hideIdle;
        this.renderFilters();
        this.renderTable();
        this.onChange?.();
      }, this.activeOnly),
      h("label", { class: "ss-search" }, icon("search", 12), this.searchInput),
      h("div", { class: "spacer" }),
      count,
    );
  }

  private stateOf(r: SessionRow): string {
    return r.blockedBy.length ? "waiting" : r.state;
  }

  private renderTable(): void {
    const ec = this.filterEl.querySelector(".ss-count");
    if (this.error) {
      this.tableEl.replaceChildren(h("div", { class: "ss-error", role: "alert" }, icon("alert", 18), h("div", null, this.error), sessionQueries(this.driver) ? h("button", { class: "btn sm", type: "button", onclick: () => void this.load() }, "Try again") : null));
      this.chainEl.hidden = true;
      this.detailEl.hidden = true;
      if (ec) ec.textContent = "";
      return;
    }
    const rows = filterSessions(this.rows, { activeOnly: this.activeOnly, hideIdle: this.hideIdle, query: this.query });
    if (ec) ec.textContent = `${rows.length} of ${this.rows.length} sessions · ${this.rows.filter((r) => r.state !== "idle").length} not idle`;
    const chains = lockChains(this.rows);
    const roots = new Map(chains.map((c) => [c.root, c]));
    const waiting = new Set(chains.flatMap((c) => c.waiting));
    // banner: the biggest chain
    const top = chains[0];
    if (top) {
      const r = this.rows.find((x) => x.pid === top.root);
      const path = [top.root, ...top.waiting].join(" → ");
      this.chainEl.replaceChildren(
        h("span", { class: "ss-chain-ic", "aria-hidden": "true" }, "⛓"),
        h("span", { class: "ss-chain-text" }, `Lock chain: pid ${top.root}${r ? ` (${r.app || r.user}, ${r.state}${r.durationS !== null ? " for " + fmtDuration(r.durationS) : ""})` : ""} blocks ${top.waiting.length} ${top.waiting.length === 1 ? "session" : "sessions"}: ${path}${chains.length > 1 ? ` · ${chains.length - 1} more chain${chains.length > 2 ? "s" : ""}` : ""}`),
        h("button", {
          class: "btn sm",
          type: "button",
          onclick: () => {
            this.sel = top.root;
            this.renderTable();
          },
        }, "Select blocker"),
      );
      this.chainEl.hidden = false;
    } else this.chainEl.hidden = true;

    const head = h("div", { class: "ss-row ss-th", role: "row" }, ["pid", "user", "application", "state", "duration", "waiting on", "query"].map((t) => h("span", { role: "columnheader" }, t)));
    const list = rows.map((r) => {
      const st = this.stateOf(r);
      const root = roots.get(r.pid);
      const dur = r.durationS;
      const cls = "ss-row ss-tr" + (this.sel === r.pid ? " on" : "") + (root ? " root" : waiting.has(r.pid) ? " wait" : "");
      return h(
        "button",
        {
          class: cls,
          type: "button",
          role: "row",
          "aria-selected": String(this.sel === r.pid),
          onclick: () => {
            this.sel = r.pid;
            this.note = "";
            this.renderTable();
          },
        },
        h("span", { class: "mono ss-pid" }, r.pid),
        h("span", { class: "ss-ell" }, r.user),
        h("span", { class: "ss-ell ss-app" }, r.app),
        h(
          "span",
          { class: "ss-state" },
          h("span", { class: "ss-dot " + (r.blockedBy.length ? "wait" : st === "active" ? "active" : st.startsWith("idle in transaction") ? "itx" : "idle"), "aria-hidden": "true" }),
          h("span", { class: st === "idle" ? "ss-dim" : "" }, st),
          root ? h("span", { class: "ss-tag root" }, `blocks ${root.waiting.length}`) : r.self ? h("span", { class: "ss-tag" }, "this tab") : null,
        ),
        h("span", { class: "mono ss-dur" + (dur !== null && dur >= 300 ? " long" : dur !== null && dur >= 60 ? " mid" : "") }, fmtDuration(dur)),
        h("span", { class: "mono ss-waiton" }, r.blockedBy.length ? `lock · ${r.blockedBy.join(", ")}` : ""),
        h("span", { class: "mono ss-ell ss-q", title: r.query }, r.query.replace(/\s+/g, " ")),
      );
    });
    this.tableEl.replaceChildren(head, ...(list.length ? list : [h("div", { class: "ss-empty" }, this.loading ? "Loading sessions…" : this.rows.length ? "No session matches the filters" : "No sessions")]));
    this.renderDetail();
  }

  private renderDetail(): void {
    const r = this.rows.find((x) => x.pid === this.sel);
    this.noteEl.hidden = !this.note;
    this.noteEl.textContent = this.note;
    if (!r) {
      this.detailEl.hidden = true;
      return;
    }
    const cancelCmd = sessionCommand(this.driver, "cancel", r.pid);
    const killCmd = sessionCommand(this.driver, "kill", r.pid);
    const own = r.self ? "This is the tab's own session — it can't be cancelled or killed from here" : "";
    const meta = [r.user, r.app, r.client, r.db, r.waitEvent ? `wait ${r.waitEvent}` : "", r.background ? "background process" : ""].filter(Boolean).join(" · ");
    const copyBtn = h("button", { class: "btn sm", type: "button", disabled: !r.query }, "Copy query");
    copyBtn.addEventListener("click", () => void copyText(r.query).then(() => toast("Query copied", "ok")));
    this.detailEl.replaceChildren(
      h(
        "div",
        { class: "ss-detail-head" },
        h("b", null, `pid ${r.pid}`),
        h("span", { class: "ss-meta" }, meta),
        h("div", { class: "spacer" }),
        copyBtn,
        h("button", { class: "btn sm", type: "button", disabled: !!own || !cancelCmd, title: own || (cancelCmd ? cancelCmd : "SQL Server can only kill a session"), onclick: () => void this.act("cancel", r) }, "Cancel query"),
        h("button", { class: "btn sm ss-kill", type: "button", disabled: !!own || !killCmd, title: own || killCmd || "", onclick: () => void this.act("kill", r) }, "Kill session"),
      ),
      h("pre", { class: "ss-query mono" }, r.query || "(no query)"),
    );
    this.detailEl.hidden = false;
  }

  private async act(action: SessionAction, r: SessionRow): Promise<void> {
    if (r.self) return;
    const cmd = sessionCommand(this.driver, action, r.pid);
    if (!cmd) return;
    const chain = blockedChain(this.rows, r.pid);
    const who = `${r.app || "the session"}${r.user ? ` (${r.user})` : ""}`;
    const ok = await opsConfirm(
      action === "kill"
        ? {
            title: `Kill session ${r.pid}?`,
            text: `Disconnects ${who}. Its open transaction is rolled back${chain.length ? `, which releases the locks blocking ${chain.length} ${chain.length === 1 ? "session" : "sessions"}.` : "."}`,
            sql: cmd,
            okLabel: "Kill session",
            cancelLabel: "Keep running",
          }
        : {
            title: `Cancel the query in ${r.pid}?`,
            text: "Stops the running statement. The session stays connected; the application gets an error for this query.",
            sql: cmd,
            okLabel: "Cancel query",
            cancelLabel: "Keep running",
          },
    );
    if (!ok || !this.alive) return;
    try {
      const s = await this.ensureSession();
      const res = await api.execute(s.sessionId, cmd.replace(/;$/, ""), 1);
      const v = res.rows[0]?.[0];
      if (v === false) this.note = `✕ ${r.pid}: the server reported nothing to ${action === "kill" ? "terminate" : "cancel"} (the session may have ended)`;
      else this.note = action === "kill" ? `✓ Session ${r.pid} terminated${chain.length ? " · waiting sessions can continue" : ""}` : `✓ Query in ${r.pid} cancelled`;
      if (action === "kill") this.sel = this.rows.find((x) => x.blockedBy.includes(r.pid))?.pid ?? null;
    } catch (e) {
      this.note = `✕ ${errMsg(e)}`;
      toast(errMsg(e), "error");
    }
    await this.load(true);
  }
}
