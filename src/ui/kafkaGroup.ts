// Kafka consumer-group tab: state header, lag stat cards, per-partition lag table, members.
// Auto-refreshes every 5 s while the tab is visible. "Reset offsets…" needs an Empty group.
import { api } from "../api";
import type { KafkaGroupDetail } from "../types";
import { clear, copyText, errMsg, h, icon } from "./dom";
import { fmtInt, kafkaSid, loadOverview, memberByPartition, memberLabel, overviewOf, stateClass, stateLabel } from "./kafka";
import { openResetOffsetsDialog } from "./kafkaDialogs";
import { store } from "./state";
import type { TabPane } from "./tabs";
import { toast } from "./toast";

const REFRESH_MS = 5000;

export class GroupPane implements TabPane {
  readonly kind = "group" as const;
  readonly el: HTMLElement;
  /** Nothing in the capsule for a group: its actions live in the header. */
  readonly controls: HTMLElement = h("div", { class: "cap-controls kf-capctl" });
  title: string;
  database: string | null = null;
  readonly tabIcon = { icon: "group", cls: "kt-group" };

  private data: KafkaGroupDetail | null = null;
  private error: string | null = null;
  private loading = false;
  private alive = true;
  private seq = 0;
  private timer: number | undefined;
  private headEl: HTMLElement;
  private bodyEl: HTMLElement;

  constructor(
    public connId: string,
    readonly groupId: string,
  ) {
    this.title = groupId;
    this.headEl = h("div", { class: "kf-head" });
    this.bodyEl = h("div", { class: "kf-gbodyscroll" });
    this.el = h("div", { class: "kafkaview kf-group", tabindex: "-1" }, this.headEl, this.bodyEl);
    this.renderHead();
    this.renderBody();
    void this.load();
    this.schedule();
  }

  // ---------------------------------------------------------------- TabPane

  get effectiveDatabase(): string | null {
    return null;
  }
  get isRunning(): boolean {
    return false;
  }
  get objectLabel(): { glyph: "group"; name: string } {
    return { glyph: "group", name: this.groupId };
  }
  focus(): void {
    this.el.focus({ preventScroll: true });
  }
  updateSchema(): void {}
  dropSession(): void {
    window.clearTimeout(this.timer);
    this.error = "The connection was closed. Reconnect and refresh.";
    this.renderHead();
    this.renderBody();
  }
  async dispose(): Promise<void> {
    this.alive = false;
    window.clearTimeout(this.timer);
  }
  async switchDatabase(): Promise<void> {}
  async switchConnection(): Promise<void> {}
  currentSchemaName(): string | null {
    return null;
  }
  async setDefaultSchema(): Promise<void> {}

  matches(connId: string, group: string): boolean {
    return this.connId === connId && this.groupId === group;
  }

  get readOnly(): boolean {
    return store.conns.get(this.connId)?.config.readOnly === true;
  }

  private get visible(): boolean {
    return this.alive && this.el.isConnected && !this.el.classList.contains("hidden");
  }

  // ---------------------------------------------------------------- loading

  private schedule(): void {
    window.clearTimeout(this.timer);
    if (!this.alive) return;
    this.timer = window.setTimeout(async () => {
      if (this.visible && !this.loading && kafkaSid(this.connId)) await this.load(true);
      this.schedule();
    }, REFRESH_MS);
  }

  async load(quiet = false): Promise<void> {
    const mine = ++this.seq;
    const sid = kafkaSid(this.connId);
    if (!sid) {
      this.error = "Not connected.";
      this.renderBody();
      return;
    }
    this.loading = true;
    if (!quiet) this.renderHead();
    try {
      const d = await api.kafkaGroup(sid, this.groupId);
      if (!this.alive || mine !== this.seq) return;
      this.data = d;
      this.error = null;
    } catch (e) {
      if (!this.alive || mine !== this.seq) return;
      if (!quiet || !this.data) this.error = errMsg(e);
    } finally {
      if (this.alive && mine === this.seq) {
        this.loading = false;
        this.renderHead();
        this.renderBody();
      }
    }
  }

  // ---------------------------------------------------------------- header

  private renderHead(): void {
    clear(this.headEl);
    const d = this.data;
    const info = overviewOf(this.connId)?.groups.find((g) => g.groupId === this.groupId);
    const state = d?.state ?? info?.state ?? "";
    const n = d ? d.members.length : (info?.members ?? 0);
    const proto = info?.protocolType || "consumer";
    const sub = [proto, `${n} member${n === 1 ? "" : "s"}`, d?.protocol || ""].filter(Boolean).join(" · ");
    const empty = state === "Empty";
    const items: (Node | null)[] = [
      h("button", { class: "kf-name mono btn-like", type: "button", title: "Copy group id", onclick: () => void copyText(this.groupId).then(() => toast("Group id copied", "ok")) }, this.groupId),
      state ? h("span", { class: "kf-state " + stateClass(state) }, stateLabel(state)) : null,
      h("span", { class: "kf-sub" }, sub),
      h("div", { class: "spacer" }),
      h("button", { class: "kf-icon-btn", type: "button", title: "Refresh", "aria-label": "Refresh", disabled: this.loading, onclick: () => void this.load() }, icon("refresh", 14)),
      this.readOnly
        ? null
        : h(
            "button",
            {
              class: "kf-pill-btn lg" + (empty ? "" : " off"),
              type: "button",
              disabled: !empty,
              title: empty ? "Reset committed offsets for a topic" : "Stop all members first: the group must be Empty",
              onclick: () => {
                if (!empty || !this.data) return;
                openResetOffsetsDialog(this.connId, this.data, () => {
                  void this.load();
                  void loadOverview(this.connId, true);
                });
              },
            },
            "Reset offsets…",
          ),
    ];
    this.headEl.append(...items.filter((x): x is Node => x !== null));
  }

  // ---------------------------------------------------------------- body

  private renderBody(): void {
    clear(this.bodyEl);
    const d = this.data;
    if (this.error && !d) {
      this.bodyEl.append(h("div", { class: "r-message err", role: "alert" }, icon("alert", 20), h("div", { class: "r-message-title" }, "Could not read the group"), h("div", { class: "r-error-text" }, this.error)));
      return;
    }
    if (!d) {
      this.bodyEl.append(h("div", { class: "r-wait", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, "Loading…")));
      return;
    }
    const offsets = [...d.offsets].sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.partition - b.partition));
    const withLag = offsets.filter((o) => (o.lag ?? 0) > 0).length;
    const topics = new Set(offsets.map((o) => o.topic)).size;
    const total = d.totalLag;
    const maxLag = Math.max(1, ...offsets.map((o) => o.lag ?? 0));
    const card = (label: string, value: HTMLElement | string, cls = ""): HTMLElement => h("div", { class: "kf-card" }, h("div", { class: "kf-card-k" }, label), h("div", { class: "kf-card-v " + cls }, value));

    this.bodyEl.append(
      h(
        "div",
        { class: "kf-cards" },
        card("Total lag", fmtInt(total), total > 0 ? "warn" : "ok"),
        card("Topics", fmtInt(topics)),
        card("Partitions with lag", h("span", null, fmtInt(withLag), " ", h("span", { class: "of" }, `of ${fmtInt(offsets.length)}`))),
      ),
    );

    const byPart = memberByPartition(d);
    const rows = offsets.map((o) => {
      const lag = o.lag ?? 0;
      const w = lag === 0 ? 0 : Math.max(4, Math.round((lag / maxLag) * 100));
      const tone = lag === 0 ? "none" : lag > 300 ? "high" : "low";
      return h(
        "div",
        { class: "kf-lrow" },
        h("span", { class: "mono ell", title: o.topic }, o.topic),
        h("span", { class: "mono dim" }, String(o.partition)),
        h("span", { class: "mono r" }, o.committed === null ? "—" : fmtInt(o.committed)),
        h("span", { class: "mono r dim" }, fmtInt(o.end)),
        h("span", { class: "kf-lag" }, h("span", { class: "kf-bar" }, h("span", { class: "kf-fill " + tone, style: `width:${w}%` })), h("span", { class: "mono kf-lagn " + tone }, o.lag === null ? "—" : fmtInt(lag))),
        h("span", { class: "dim ell sm", title: memberLabel(byPart.get(`${o.topic}:${o.partition}`)) }, memberLabel(byPart.get(`${o.topic}:${o.partition}`))),
      );
    });
    this.bodyEl.append(
      h(
        "div",
        { class: "kf-ltable", role: "table", "aria-label": "Lag per partition" },
        h("div", { class: "kf-lrow kf-lhead", role: "row" }, h("span", null, "topic"), h("span", null, "part."), h("span", { class: "r" }, "committed"), h("span", { class: "r" }, "end"), h("span", null, "lag"), h("span", null, "member")),
        rows.length ? rows : h("div", { class: "kf-empty-note" }, "This group has no committed offsets."),
      ),
    );

    // members
    this.bodyEl.append(h("div", { class: "kf-sec-title" }, "Members", h("span", { class: "kf-sec-count" }, String(d.members.length))));
    if (d.members.length === 0) {
      this.bodyEl.append(h("div", { class: "kf-empty-note" }, "No active members — the group is " + stateLabel(d.state).toLowerCase() + "."));
    } else {
      this.bodyEl.append(
        h(
          "div",
          { class: "kf-members" },
          d.members.map((m) =>
            h(
              "div",
              { class: "kf-member" },
              h("div", { class: "kf-member-top" }, h("span", { class: "mono kf-member-client" }, m.clientId || "(no client id)"), h("span", { class: "dim sm" }, m.host)),
              h("div", { class: "mono dim sm ell", title: m.memberId }, m.memberId),
              h("div", { class: "kf-assign" }, m.assignments.length ? m.assignments.map((a) => h("span", { class: "kf-hchip mono" }, a)) : h("span", { class: "dim sm" }, "no assignments")),
            ),
          ),
        ),
      );
    }
  }
}
