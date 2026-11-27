// Kafka topic tab: header chips, "from / partition / filters" controls, a virtualized message grid, the
// message detail panel and Follow (poll for new messages). The capsule gets the Follow toggle and "+ Produce".
import { api } from "../api";
import type { KafkaConsumeRequest, KafkaConsumeResult, KafkaMessage, KafkaTopicDetail } from "../types";
import { clear, copyText, debounce, errMsg, h, icon } from "./dom";
import {
  bytesText,
  fmtInt,
  fmtTs,
  fmtTsFull,
  hexDump,
  humanDuration,
  kafkaSid,
  looksBinary,
  msgKey,
  overviewOf,
  previewValue,
  toLocalInput,
} from "./kafka";
import { openProduceDialog } from "./kafkaDialogs";
import type { ProducePrefill } from "./kafkaDialogs";
import { parseJsonLoose, tintJson } from "./keyView";
import { showMenu } from "./menu";
import { store } from "./state";
import type { TabPane } from "./tabs";
import { toast } from "./toast";
import { errorHelpButton } from "./help";

type FromMode = "latest" | "earliest" | "timestamp" | "offset";

const LIMIT = 200;
const ROW_H = 32;
const OVERSCAN = 6;
const BUFFER_CAP = 5000;
const FOLLOW_MS = 1500;
const FRESH_MS = 2600;
const FROM_LABEL: Record<FromMode, string> = { latest: "Latest", earliest: "Earliest", timestamp: "Timestamp", offset: "Offset" };

const ts = (m: KafkaMessage): number => m.timestampMs ?? -1;
const cmpDesc = (a: KafkaMessage, b: KafkaMessage): number => ts(b) - ts(a) || b.offset - a.offset || a.partition - b.partition;
const cmpAsc = (a: KafkaMessage, b: KafkaMessage): number => ts(a) - ts(b) || a.partition - b.partition || a.offset - b.offset;

export class TopicPane implements TabPane {
  readonly kind = "topic" as const;
  readonly el: HTMLElement;
  readonly controls: HTMLElement;
  title: string;
  database: string | null = null;
  readonly tabIcon = { icon: "topic", cls: "kt-topic" };

  private detail: KafkaTopicDetail | null = null;
  private from: FromMode = "latest";
  private tsMs: number | null = Date.now() - 3_600_000;
  private offsetVal: number | null = 0;
  private partition: number | null = null;
  private keyQ = "";
  private valQ = "";
  private msgs: KafkaMessage[] = [];
  private seen = new Set<string>();
  private scanned = 0;
  /** Positions after the newest message read (Follow) / after the last message read (forward modes). */
  private next: Record<number, number> | null = null;
  /** Latest mode: per-partition offset already covered going backwards. */
  private older: Record<number, number> = {};
  private reachedEnd = false;
  private olderDone = false;
  private loading = false;
  private loadingMore = false;
  private error: string | null = null;
  private seq = 0;
  private alive = true;
  private following = false;
  private followTimer: number | undefined;
  private polling = false;
  private selKey: string | null = null;
  private fresh = new Map<string, number>();
  private pretty = true;
  private hex = true;

  private headEl: HTMLElement;
  private ctlEl: HTMLElement;
  private scrollEl: HTMLElement;
  private innerEl: HTMLElement;
  private bodyMsg: HTMLElement;
  private detailEl: HTMLElement;
  private statusEl: HTMLElement;
  private fromSeg: HTMLElement;
  private extraWrap: HTMLElement;
  private partBtn: HTMLButtonElement;
  private followBtn: HTMLButtonElement;
  private produceBtn: HTMLButtonElement;
  private rendered = new Map<number, HTMLElement>();
  private paintQueued = false;

  constructor(
    public connId: string,
    readonly topic: string,
  ) {
    this.title = topic;
    this.headEl = h("div", { class: "kf-head" });
    this.fromSeg = h("div", { class: "kf-seg", role: "radiogroup", "aria-label": "Read from" });
    this.extraWrap = h("div", { class: "kf-extra" });
    this.partBtn = h("button", { class: "kf-pill-btn lg", type: "button", "aria-haspopup": "menu", onclick: () => this.openPartitionMenu() });
    this.statusEl = h("div", { class: "kf-status", "aria-live": "polite" });
    const filt = (label: string, w: number, ph: string, get: () => string, set: (v: string) => void): HTMLElement => {
      const input = h("input", { type: "text", placeholder: ph, spellcheck: false, autocomplete: "off", "aria-label": `${label} contains`, value: get() });
      const apply = debounce(() => {
        if (get() !== input.value.trim()) {
          set(input.value.trim());
          void this.reload();
        }
      }, 450);
      input.addEventListener("input", apply);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          set(input.value.trim());
          void this.reload();
        }
      });
      return h("label", { class: "kf-filter", style: `width:${w}px` }, label, input);
    };
    this.ctlEl = h(
      "div",
      { class: "kf-ctl" },
      this.fromSeg,
      this.extraWrap,
      this.partBtn,
      filt("key", 150, "contains…", () => this.keyQ, (v) => (this.keyQ = v)),
      filt("value", 190, "contains…", () => this.valQ, (v) => (this.valQ = v)),
      h("div", { class: "spacer" }),
      this.statusEl,
    );

    this.scrollEl = h("div", { class: "kf-scroll", tabindex: "0", role: "grid", "aria-label": "Messages", onkeydown: (e: KeyboardEvent) => this.onGridKey(e) });
    this.innerEl = h("div", { class: "kf-inner" });
    this.scrollEl.append(this.innerEl);
    this.scrollEl.addEventListener("scroll", () => this.queuePaint(), { passive: true });
    new ResizeObserver(() => this.queuePaint()).observe(this.scrollEl);
    this.bodyMsg = h("div", { class: "kf-bodymsg" });
    const ghead = h(
      "div",
      { class: "kf-grow kf-ghead", role: "row" },
      h("span", null, "part."),
      h("span", null, "offset"),
      h("span", null, "timestamp"),
      h("span", null, "key"),
      h("span", null, "value"),
      h("span", { style: "text-align:right" }, "hdrs"),
    );
    const gridWrap = h("div", { class: "kf-gridwrap" }, ghead, h("div", { class: "kf-gbody" }, this.scrollEl, this.bodyMsg));
    this.detailEl = h("aside", { class: "kf-detail", "aria-label": "Message detail" });
    this.el = h("div", { class: "kafkaview", tabindex: "-1" }, this.headEl, this.ctlEl, h("div", { class: "kf-main" }, gridWrap, this.detailEl));

    this.followBtn = h("button", { class: "kf-follow", type: "button", "aria-pressed": "false", title: "Poll for new messages (newest first)", onclick: () => void this.toggleFollow() });
    this.produceBtn = h("button", { class: "kf-produce-btn", type: "button", title: "Produce a message to this topic", onclick: () => this.produce() }, h("span", { class: "plus" }, "＋"), "Produce");
    this.produceBtn.hidden = this.readOnly;
    this.controls = h("div", { class: "cap-controls kf-capctl" }, this.followBtn, this.produceBtn);
    this.syncFollowBtn();

    this.renderFrom();
    this.renderHead();
    this.renderDetail();
    this.renderStatus();
    void this.loadDetail();
    void this.reload();
  }

  // ---------------------------------------------------------------- TabPane

  get effectiveDatabase(): string | null {
    return null;
  }
  get isRunning(): boolean {
    return false;
  }
  get objectLabel(): { glyph: "topic"; name: string } {
    return { glyph: "topic", name: this.topic };
  }
  focus(): void {
    this.scrollEl.focus({ preventScroll: true });
  }
  updateSchema(): void {}
  dropSession(): void {
    this.stopFollow();
    this.error = "The connection was closed. Reconnect and refresh.";
    this.renderBody();
    this.renderStatus();
  }
  async dispose(): Promise<void> {
    this.alive = false;
    this.stopFollow();
  }
  async switchDatabase(): Promise<void> {}
  async switchConnection(): Promise<void> {}
  currentSchemaName(): string | null {
    return null;
  }
  async setDefaultSchema(): Promise<void> {}

  matches(connId: string, topic: string): boolean {
    return this.connId === connId && this.topic === topic;
  }

  get readOnly(): boolean {
    return store.conns.get(this.connId)?.config.readOnly === true;
  }

  private get visible(): boolean {
    return this.alive && this.el.isConnected && !this.el.classList.contains("hidden");
  }

  // ---------------------------------------------------------------- actions

  produce(prefill?: ProducePrefill): void {
    openProduceDialog({ connId: this.connId, topic: this.topic, prefill, onSent: () => void this.afterProduce() });
  }

  /** A message was sent from this tab: show it right away when we are reading the head of the topic. */
  private async afterProduce(): Promise<void> {
    void this.loadDetail();
    if (this.from === "latest" && this.next && !this.polling) await this.pollOnce(false);
  }

  async refresh(): Promise<void> {
    void this.loadDetail();
    await this.reload();
  }

  private async loadDetail(): Promise<void> {
    const sid = kafkaSid(this.connId);
    if (!sid) return;
    try {
      const d = await api.kafkaTopic(sid, this.topic);
      if (!this.alive) return;
      this.detail = d;
      this.renderHead();
      this.renderFrom();
    } catch (e) {
      if (!this.alive) return;
      if (!this.detail) this.error = this.error ?? errMsg(e);
      this.renderBody();
    }
  }

  // ---------------------------------------------------------------- loading

  private baseRequest(): Omit<KafkaConsumeRequest, "from"> {
    return { topic: this.topic, partition: this.partition, limit: LIMIT, keyContains: this.keyQ || null, valueContains: this.valQ || null, timeoutMs: 10_000 };
  }

  private async reload(): Promise<void> {
    const mine = ++this.seq;
    const sid = kafkaSid(this.connId);
    if (!sid) {
      this.error = "Not connected.";
      this.renderBody();
      return;
    }
    this.loading = true;
    this.error = null;
    this.renderStatus();
    this.renderBody();
    const req: KafkaConsumeRequest = { ...this.baseRequest(), from: this.from };
    if (this.from === "timestamp") {
      if (this.tsMs === null) {
        this.loading = false;
        this.msgs = [];
        this.seen.clear();
        this.renderAll();
        return;
      }
      req.timestampMs = this.tsMs;
    }
    if (this.from === "offset") req.offset = this.offsetVal ?? 0;
    try {
      const r = await api.kafkaConsume(sid, req);
      if (!this.alive || mine !== this.seq) return;
      const sorted = [...r.messages].sort(this.from === "latest" ? cmpDesc : cmpAsc);
      this.msgs = sorted;
      this.seen = new Set(sorted.map(msgKey));
      this.scanned = r.scanned;
      this.next = r.nextPositions;
      this.reachedEnd = r.reachedEnd;
      this.fresh.clear();
      if (this.from === "latest") this.initOlder(r);
      if (this.selKey && !this.seen.has(this.selKey)) this.selKey = null;
      this.scrollEl.scrollTop = 0;
    } catch (e) {
      if (!this.alive || mine !== this.seq) return;
      this.error = errMsg(e);
      this.msgs = [];
      this.seen.clear();
    } finally {
      if (this.alive && mine === this.seq) {
        this.loading = false;
        this.renderAll();
        if (this.following && this.from === "latest") this.scheduleFollow(FOLLOW_MS);
      }
    }
  }

  private partitionIds(): number[] {
    if (this.partition !== null) return [this.partition];
    return this.detail ? this.detail.partitions.map((p) => p.id) : Object.keys(this.next ?? {}).map(Number);
  }

  private lowOf(p: number): number {
    return this.detail?.partitions.find((x) => x.id === p)?.low ?? 0;
  }

  /** After a "latest" load: how far back each partition has been covered. */
  private initOlder(r: KafkaConsumeResult): void {
    const ids = this.partitionIds();
    const min = new Map<number, number>();
    for (const m of this.msgs) min.set(m.partition, Math.min(min.get(m.partition) ?? Infinity, m.offset));
    this.older = {};
    const share = Math.ceil(r.scanned / Math.max(1, ids.length));
    for (const p of ids) {
      const end = r.nextPositions[p];
      this.older[p] = min.get(p) ?? (end !== undefined ? Math.max(this.lowOf(p), end - share) : this.lowOf(p));
    }
    this.olderDone = ids.every((p) => (this.older[p] ?? 0) <= this.lowOf(p));
  }

  private async loadMore(): Promise<void> {
    if (this.loading || this.loadingMore) return;
    const sid = kafkaSid(this.connId);
    if (!sid) return;
    const mine = this.seq;
    this.loadingMore = true;
    this.renderStatus();
    try {
      let r: KafkaConsumeResult;
      if (this.from === "latest") {
        const ids = this.partitionIds().filter((p) => (this.older[p] ?? 0) > this.lowOf(p));
        if (!ids.length) {
          this.olderDone = true;
          return;
        }
        const per = Math.ceil(LIMIT / ids.length);
        const positions: Record<number, number> = {};
        let want = 0;
        for (const p of ids) {
          positions[p] = Math.max(this.lowOf(p), (this.older[p] ?? 0) - per);
          want += (this.older[p] ?? 0) - positions[p];
        }
        r = await api.kafkaConsume(sid, { ...this.baseRequest(), from: "positions", positions, limit: Math.min(1000, Math.max(LIMIT, want)), partition: null });
        if (!this.alive || mine !== this.seq) return;
        for (const p of ids) this.older[p] = positions[p];
        this.olderDone = this.partitionIds().every((p) => (this.older[p] ?? 0) <= this.lowOf(p));
        const add = r.messages.filter((m) => !this.seen.has(msgKey(m)) && (this.partition === null || m.partition === this.partition)).sort(cmpDesc);
        for (const m of add) this.seen.add(msgKey(m));
        this.msgs = this.msgs.concat(add);
      } else {
        if (!this.next) return;
        r = await api.kafkaConsume(sid, { ...this.baseRequest(), from: "positions", positions: this.next });
        if (!this.alive || mine !== this.seq) return;
        const add = r.messages.filter((m) => !this.seen.has(msgKey(m))).sort(cmpAsc);
        for (const m of add) this.seen.add(msgKey(m));
        this.msgs = this.msgs.concat(add);
        this.next = { ...this.next, ...r.nextPositions };
        this.reachedEnd = r.reachedEnd;
      }
      this.scanned += r.scanned;
    } catch (e) {
      if (this.alive) toast(errMsg(e), "error");
    } finally {
      this.loadingMore = false;
      if (this.alive && mine === this.seq) this.renderAll();
    }
  }

  // ---------------------------------------------------------------- follow

  private async toggleFollow(): Promise<void> {
    if (this.following) {
      this.stopFollow();
      return;
    }
    this.following = true;
    this.syncFollowBtn();
    if (this.from !== "latest") {
      this.from = "latest";
      this.renderFrom();
      await this.reload();
    } else if (!this.next) await this.reload();
    if (this.following) this.scheduleFollow(FOLLOW_MS);
  }

  private stopFollow(): void {
    this.following = false;
    window.clearTimeout(this.followTimer);
    this.syncFollowBtn();
  }

  private scheduleFollow(ms: number): void {
    window.clearTimeout(this.followTimer);
    if (!this.following || !this.alive) return;
    this.followTimer = window.setTimeout(() => void this.followTick(), ms);
  }

  private async followTick(): Promise<void> {
    if (!this.following || !this.alive) return;
    let delay = FOLLOW_MS;
    // Paused while the tab is hidden: the next tick catches up.
    if (this.visible && !this.loading && !this.loadingMore && this.from === "latest" && this.next) {
      const got = await this.pollOnce(true);
      if (got && !this.reachedEnd) delay = 120;
    }
    this.scheduleFollow(delay);
  }

  /** Reads what arrived after `next`. Returns true when it brought messages. */
  private async pollOnce(tint: boolean): Promise<boolean> {
    const sid = kafkaSid(this.connId);
    if (!sid || !this.next || this.polling) return false;
    const mine = this.seq;
    this.polling = true;
    try {
      const positions = this.partition === null ? this.next : { [this.partition]: this.next[this.partition] ?? 0 };
      const r = await api.kafkaConsume(sid, { ...this.baseRequest(), from: "positions", positions, timeoutMs: 800 });
      if (!this.alive || mine !== this.seq) return false;
      this.next = { ...this.next, ...r.nextPositions };
      this.reachedEnd = r.reachedEnd;
      this.scanned += r.scanned;
      const add = r.messages.filter((m) => !this.seen.has(msgKey(m))).sort(cmpDesc);
      if (!add.length) {
        this.renderStatus();
        return false;
      }
      const now = Date.now();
      for (const m of add) {
        this.seen.add(msgKey(m));
        if (tint) this.fresh.set(msgKey(m), now + FRESH_MS);
      }
      const keepY = this.scrollEl.scrollTop;
      this.msgs = add.concat(this.msgs);
      if (this.msgs.length > BUFFER_CAP) {
        for (const m of this.msgs.slice(BUFFER_CAP)) this.seen.delete(msgKey(m));
        this.msgs.length = BUFFER_CAP;
      }
      this.renderAll();
      // Keep what the user is reading in place.
      if (keepY > 0) this.scrollEl.scrollTop = keepY + add.length * ROW_H;
      if (tint) window.setTimeout(() => this.alive && this.queuePaint(true), FRESH_MS + 80);
      return true;
    } catch {
      return false;
    } finally {
      this.polling = false;
    }
  }

  private syncFollowBtn(): void {
    clear(this.followBtn);
    this.followBtn.append(h("span", { class: "kf-dot" }), "Follow");
    this.followBtn.classList.toggle("on", this.following);
    this.followBtn.setAttribute("aria-pressed", String(this.following));
  }

  // ---------------------------------------------------------------- header / controls

  private renderHead(): void {
    clear(this.headEl);
    const d = this.detail;
    const info = overviewOf(this.connId)?.topics.find((t) => t.name === this.topic);
    const chips: HTMLElement[] = [];
    const chip = (t: string, cls = ""): void => void chips.push(h("span", { class: "kf-chip " + cls }, t));
    const parts = d ? d.partitions.length : info?.partitions;
    if (parts !== undefined) chip(`${fmtInt(parts)} partition${parts === 1 ? "" : "s"}`);
    const rf = info?.replicationFactor ?? d?.partitions[0]?.replicas.length;
    if (rf !== undefined) chip(`RF ${rf}`);
    if (d) chip(`${fmtInt(d.messageCount)} message${d.messageCount === 1 ? "" : "s"}`);
    if (d) {
      const ret = d.configs.find((c) => c.name === "retention.ms");
      const clean = d.configs.find((c) => c.name === "cleanup.policy");
      const dur = humanDuration(ret?.value);
      const text = [dur ? `retention ${dur}` : "", clean?.value ? clean.value.replace(/,/g, " + ") : ""].filter(Boolean).join(" · ");
      if (text) chip(text);
      if (d.internal) chip("internal", "dim");
    }
    this.headEl.append(
      h("span", { class: "kf-name mono", title: this.topic }, this.topic),
      ...chips,
      h("div", { class: "spacer" }),
      h("button", { class: "kf-icon-btn", type: "button", title: "Reload messages", "aria-label": "Reload", onclick: () => void this.refresh() }, icon("refresh", 14)),
    );
    this.syncPartBtn();
  }

  private renderFrom(): void {
    clear(this.fromSeg);
    for (const m of ["latest", "earliest", "timestamp", "offset"] as FromMode[]) {
      this.fromSeg.append(
        h(
          "button",
          {
            type: "button",
            class: "kf-seg-btn" + (this.from === m ? " on" : ""),
            role: "radio",
            "aria-checked": String(this.from === m),
            onclick: () => {
              if (this.from === m) return;
              this.from = m;
              if (m !== "latest" && this.following) this.stopFollow();
              this.renderFrom();
              void this.reload();
            },
          },
          FROM_LABEL[m],
        ),
      );
    }
    clear(this.extraWrap);
    if (this.from === "timestamp") {
      const inp = h("input", { class: "kf-input-pill", type: "datetime-local", step: "1", value: this.tsMs === null ? "" : toLocalInput(this.tsMs), "aria-label": "Start time" });
      inp.addEventListener("change", () => {
        const t = new Date(inp.value).getTime();
        this.tsMs = Number.isNaN(t) ? null : t;
        void this.reload();
      });
      this.extraWrap.append(inp);
    } else if (this.from === "offset") {
      const inp = h("input", {
        class: "kf-input-pill narrow",
        type: "number",
        min: "0",
        step: "1",
        value: this.offsetVal === null ? "" : String(this.offsetVal),
        title: "Start offset (per partition — pick a partition for an exact position)",
        "aria-label": "Start offset",
      });
      const apply = (): void => {
        const n = Number(inp.value);
        this.offsetVal = inp.value.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null;
        if (this.offsetVal !== null) void this.reload();
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply();
      });
      this.extraWrap.append(inp);
    }
    this.syncPartBtn();
  }

  private syncPartBtn(): void {
    clear(this.partBtn);
    this.partBtn.append(`Partition: ${this.partition === null ? "All" : this.partition} `, h("span", { class: "kf-caret" }, "▾"));
  }

  private openPartitionMenu(): void {
    const r = this.partBtn.getBoundingClientRect();
    const parts = this.detail?.partitions ?? [];
    const pick = (p: number | null): void => {
      if (p === this.partition) return;
      this.partition = p;
      this.syncPartBtn();
      void this.reload();
    };
    showMenu(
      r.left,
      r.bottom + 6,
      [
        { label: "All partitions", checked: this.partition === null, onClick: () => pick(null) },
        { sep: true },
        ...parts.map((p) => ({ label: `Partition ${p.id}`, hint: `${fmtInt(Math.max(0, p.high - p.low))} msgs`, checked: this.partition === p.id, onClick: () => pick(p.id) })),
      ],
      { minWidth: 190 },
    );
  }

  private renderStatus(): void {
    clear(this.statusEl);
    if (this.loading || this.loadingMore) this.statusEl.append(h("span", { class: "spinner sm", "aria-hidden": "true" }));
    this.statusEl.append(h("span", null, `${fmtInt(this.msgs.length)} shown · ${fmtInt(this.scanned)} scanned`));
  }

  // ---------------------------------------------------------------- grid

  private renderAll(): void {
    this.renderStatus();
    this.renderBody();
    this.renderDetail();
  }

  private get canMore(): boolean {
    if (this.msgs.length === 0 && !this.next) return false;
    return this.from === "latest" ? !this.olderDone : !this.reachedEnd;
  }

  private renderBody(): void {
    clear(this.bodyMsg);
    const n = this.msgs.length;
    const more = this.canMore && n > 0;
    this.innerEl.style.height = n * ROW_H + (more ? 46 : 0) + "px";
    this.rendered.clear();
    clear(this.innerEl);
    if (this.error && n === 0) {
      this.bodyMsg.className = "kf-bodymsg show";
      this.bodyMsg.append(h("div", { class: "r-message err", role: "alert" }, icon("alert", 20), h("div", { class: "r-message-title" }, "Could not read messages"), h("div", { class: "r-error-text" }, this.error), errorHelpButton(this.error, { driver: "kafka" })));
    } else if (this.loading && n === 0) {
      this.bodyMsg.className = "kf-bodymsg show";
      this.bodyMsg.append(h("div", { class: "r-wait", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, "Reading messages…")));
    } else if (n === 0) {
      this.bodyMsg.className = "kf-bodymsg show";
      const filtered = this.keyQ || this.valQ || this.partition !== null;
      this.bodyMsg.append(
        h(
          "div",
          { class: "r-message" },
          icon("topic", 22),
          h("div", { class: "r-message-title" }, this.canMore ? "No matches in what was scanned" : "No messages"),
          h("div", { class: "r-message-sub" }, filtered ? "Nothing matched the filters here. Try another partition or clear the filters." : this.from === "latest" ? "This topic is empty." : "Nothing at or after that position."),
          this.canMore ? h("button", { class: "kf-pill-btn", type: "button", style: "margin-top:10px", onclick: () => void this.loadMore() }, "Scan further") : null,
        ),
      );
    } else this.bodyMsg.className = "kf-bodymsg";
    this.paint(true);
  }

  private queuePaint(force = false): void {
    if (this.paintQueued && !force) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.paint(force);
    });
  }

  private paint(force: boolean): void {
    const n = this.msgs.length;
    if (force) {
      for (const el of this.rendered.values()) el.remove();
      this.rendered.clear();
      this.innerEl.querySelector(".kf-more")?.remove();
    }
    if (n === 0) return;
    const top = this.scrollEl.scrollTop;
    const vh = this.scrollEl.clientHeight || 560;
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(n, Math.ceil((top + vh) / ROW_H) + OVERSCAN);
    for (const [i, el] of this.rendered) {
      if (i < start || i >= end) {
        el.remove();
        this.rendered.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const el = this.rowEl(this.msgs[i], i);
      this.rendered.set(i, el);
      this.innerEl.appendChild(el);
    }
    if (this.canMore && !this.innerEl.querySelector(".kf-more")) {
      this.innerEl.appendChild(
        h(
          "div",
          { class: "kf-more", style: `top:${n * ROW_H}px` },
          h("button", { class: "kf-pill-btn", type: "button", disabled: this.loadingMore, onclick: () => void this.loadMore() }, this.loadingMore ? "Loading…" : this.from === "latest" ? "Load older messages" : "Load newer messages"),
        ),
      );
    }
  }

  private rowEl(m: KafkaMessage, i: number): HTMLElement {
    const k = msgKey(m);
    const exp = this.fresh.get(k);
    const isFresh = exp !== undefined && exp > Date.now();
    const sel = this.selKey === k;
    const keyText = m.key === null ? "∅" : m.key;
    return h(
      "div",
      {
        class: "kf-grow kf-row" + (sel ? " sel" : "") + (isFresh ? " fresh" : ""),
        role: "row",
        "aria-selected": String(sel),
        style: `top:${i * ROW_H}px`,
        onclick: () => this.select(k),
      },
      h("span", { class: "mono dim" }, String(m.partition)),
      h("span", { class: "mono" }, fmtInt(m.offset)),
      h("span", { class: "dim" }, fmtTs(m.timestampMs)),
      h("span", { class: "mono ell" + (m.key === null ? " nul" : "") }, keyText),
      h("span", { class: "mono ell val" + (m.value === null ? " nul" : "") }, m.value === null ? "∅ tombstone" : previewValue(m.value)),
      h("span", { class: "hdrs" }, m.headers.length ? String(m.headers.length) : ""),
    );
  }

  private select(k: string | null): void {
    this.selKey = k;
    for (const [i, el] of this.rendered) {
      const on = this.msgs[i] && msgKey(this.msgs[i]) === k;
      el.classList.toggle("sel", on);
      el.setAttribute("aria-selected", String(on));
    }
    this.renderDetail();
  }

  private onGridKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    if (!this.msgs.length) return;
    e.preventDefault();
    let i = this.selKey ? this.msgs.findIndex((m) => msgKey(m) === this.selKey) : -1;
    i = e.key === "Home" ? 0 : e.key === "End" ? this.msgs.length - 1 : Math.max(0, Math.min(this.msgs.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    const y = i * ROW_H;
    if (y < this.scrollEl.scrollTop) this.scrollEl.scrollTop = y;
    else if (y + ROW_H > this.scrollEl.scrollTop + this.scrollEl.clientHeight) this.scrollEl.scrollTop = y + ROW_H - this.scrollEl.clientHeight;
    this.paint(false);
    this.select(msgKey(this.msgs[i]));
  }

  // ---------------------------------------------------------------- detail panel

  private current(): KafkaMessage | null {
    if (!this.selKey) return null;
    return this.msgs.find((m) => msgKey(m) === this.selKey) ?? null;
  }

  private renderDetail(): void {
    clear(this.detailEl);
    const m = this.current();
    if (!m) {
      this.detailEl.append(
        h("div", { class: "kf-d-head" }, h("span", { class: "kf-d-title" }, "Message")),
        h("div", { class: "kf-d-empty" }, icon("topic", 20), h("div", null, this.msgs.length ? "Select a message to inspect it" : "No message selected")),
      );
      return;
    }
    const raw = m.value ?? "";
    const binary = m.value !== null && looksBinary(raw);
    const parsed = m.value !== null && !binary ? parseJsonLoose(raw) : undefined;
    const isJson = parsed !== undefined && typeof parsed === "object";
    const kind = m.value === null ? "null" : binary ? "binary" : isJson ? "JSON" : "text";

    const btn = (label: string, fn: () => void, disabled = false, title = label): HTMLButtonElement => h("button", { class: "kf-pill-btn", type: "button", disabled, title, onclick: fn }, label);
    const head = h(
      "div",
      { class: "kf-d-head" },
      h("span", { class: "kf-d-title" }, "Message"),
      h("span", { class: "mono dim sm" }, `p${m.partition} · #${fmtInt(m.offset)}`),
      h("div", { class: "spacer" }),
      btn("Copy", () => void copyText(m.value ?? "").then(() => toast("Value copied", "ok")), m.value === null, "Copy the value"),
      this.readOnly ? null : btn("Resend…", () => this.produce({ key: m.key, headers: m.headers, value: isJson ? JSON.stringify(parsed, null, 2) : m.value }), false, "Open the produce dialog with this message"),
    );
    const props = h(
      "div",
      { class: "kf-d-props" },
      h("span", { class: "k" }, "Timestamp"),
      h("span", null, fmtTsFull(m.timestampMs)),
      h("span", { class: "k" }, "Key"),
      h("span", { class: "mono sel-text" + (m.key === null ? " nul" : "") }, m.key ?? "∅ null"),
      h("span", { class: "k" }, "Size"),
      h("span", null, `key ${fmtInt(m.keySize)} B · value ${bytesText(m.valueSize)}`),
    );
    const hdrs = h(
      "div",
      { class: "kf-d-hdrs" },
      m.headers.length
        ? m.headers.map((x) => h("span", { class: "kf-hchip mono", title: `${x.key}: ${x.value ?? ""}` }, `${x.key}: ${x.value ?? "∅"}`))
        : h("span", { class: "dim sm" }, "none"),
    );

    let toggle: HTMLElement | null = null;
    const mkToggle = (a: string, b: string, firstOn: boolean, set: (v: boolean) => void): HTMLElement =>
      h(
        "div",
        { class: "kf-mini-seg", role: "radiogroup" },
        [a, b].map((t, i) =>
          h(
            "button",
            {
              type: "button",
              class: "kf-mini-btn" + ((i === 0) === firstOn ? " on" : ""),
              role: "radio",
              "aria-checked": String((i === 0) === firstOn),
              onclick: () => {
                set(i === 0);
                this.renderDetail();
              },
            },
            t,
          ),
        ),
      );
    const pre = h("pre", { class: "kf-pre mono", tabindex: "0", "aria-label": "Value" });
    if (m.value === null) pre.append(h("span", { class: "dim" }, "null — a tombstone (no value)"));
    else if (binary) {
      toggle = mkToggle("Hex", "Text", this.hex, (v) => (this.hex = v));
      pre.textContent = this.hex ? hexDump(raw) : raw.slice(0, 20_000);
    } else if (isJson) {
      toggle = mkToggle("Pretty", "Raw", this.pretty, (v) => (this.pretty = v));
      if (this.pretty) {
        const text = JSON.stringify(parsed, null, 2);
        if (text.length <= 250_000) pre.appendChild(tintJson(text));
        else pre.textContent = text.slice(0, 250_000);
      } else pre.textContent = raw.slice(0, 250_000);
    } else pre.textContent = raw.slice(0, 250_000);
    const valHead = h(
      "div",
      { class: "kf-d-sec flex" },
      `Value · ${kind}`,
      m.valueTruncated ? h("span", { class: "kf-trunc", title: "The broker value was cut off for display" }, "truncated") : null,
      h("div", { class: "spacer" }),
      toggle,
    );
    this.detailEl.append(head, props, h("div", { class: "kf-d-sec" }, "Headers"), hdrs, valHead, h("div", { class: "kf-prewrap" }, pre));
  }
}
