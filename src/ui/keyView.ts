// Redis key viewer: a tab in the capsule strip that shows one key — header (name, type, TTL, size,
// memory, actions) and a body by type: text / JSON for strings, the read-only grid for collections.
import { api } from "../api";
import type { QueryResult, RedisValue } from "../types";
import { clear, copyText, errMsg, h, icon } from "./dom";
import { confirmDialog } from "./confirm";
import { humanSize } from "./format";
import { ResultGrid } from "./grid";
import { promptDialog } from "./prompt";
import { dbLabel, parseTtlInput, redisSession, ttlLong, typeInfo } from "./redis";
import { confirmProdRedisAction } from "./prodUi";
import { errorHelpButton } from "./help";
import { store } from "./state";
import type { TabPane } from "./tabs";
import { toast } from "./toast";

const DEFAULT_LIMIT = 500;
const MAX_TEXT = 600_000;
const MAX_TINT = 250_000;

export interface KeyHost {
  /** The tab changed what it shows (type known, key gone): refresh the tab strip. */
  changed(p: KeyPane): void;
  /** Keys deleted from this tab: the explorer drops them. */
  keysDeleted(connId: string, db: string, keys: string[]): void;
  /** TTL changed from this tab: the explorer row updates. */
  ttlChanged(connId: string, db: string, key: string, ttl: number | null): void;
}

const NOUN: Record<string, [string, string]> = {
  hash: ["field", "fields"],
  list: ["element", "elements"],
  set: ["member", "members"],
  zset: ["member", "members"],
  stream: ["entry", "entries"],
};

/** "{…}" / "[…]" text that parses as JSON, else undefined. */
export function parseJsonLoose(text: string, anyValue = false): unknown | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (!anyValue && t[0] !== "{" && t[0] !== "[") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Syntax-tinted JSON text (keys, strings, numbers, literals, punctuation) as DOM nodes. */
export function tintJson(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const span = (cls: string, t: string): void => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = t;
    frag.appendChild(s);
  };
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        span("jt-key", m[1]);
        span("jt-p", m[2]);
      } else span("jt-str", m[1]);
    } else if (/^(true|false|null)$/.test(t)) span("jt-lit", t);
    else if (/^[{}[\],:]$/.test(t)) span("jt-p", t);
    else span("jt-num", t);
    last = m.index + t.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/** The value of a collection key as a grid result. */
export function valueToResult(v: RedisValue): QueryResult {
  const col = (name: string, typeName: string) => ({ name, typeName });
  const base = { rowsAffected: null, truncated: v.truncated, elapsedMs: 0, statement: "" };
  const arr = Array.isArray(v.value) ? (v.value as unknown[]) : [];
  switch (v.keyType) {
    case "hash":
      return { ...base, columns: [col("field", "text"), col("value", "text")], rows: arr.map((x) => [cellText((x as { field?: unknown }).field), cellText((x as { value?: unknown }).value)]) };
    case "list":
      return { ...base, columns: [col("index", "int"), col("value", "text")], rows: arr.map((x, i) => [i, cellText(x)]) };
    case "set":
      return { ...base, columns: [col("member", "text")], rows: arr.map((x) => [cellText(x)]) };
    case "zset":
      return { ...base, columns: [col("member", "text"), col("score", "double")], rows: arr.map((x) => [cellText((x as { member?: unknown }).member), Number((x as { score?: unknown }).score)]) };
    case "stream":
      return {
        ...base,
        columns: [col("id", "text"), col("fields", "text")],
        rows: arr.map((x) => [cellText((x as { id?: unknown }).id), JSON.stringify((x as { fields?: unknown }).fields ?? {})]),
      };
    default:
      return { ...base, columns: [col("value", "text")], rows: arr.map((x) => [cellText(x)]) };
  }
}

export class KeyPane implements TabPane {
  readonly kind = "key" as const;
  readonly el: HTMLElement;
  /** Nothing to put in the capsule: the actions live in the key header. */
  readonly controls: HTMLElement = h("div", { class: "cap-controls key-controls" });
  title: string;
  database: string | null;
  private value: RedisValue | null = null;
  private error: string | null = null;
  private gone = false;
  private loading = false;
  private limit = DEFAULT_LIMIT;
  private alive = true;
  private pretty = true;
  private headEl: HTMLElement;
  private bodyEl: HTMLElement;
  private grid: ResultGrid | null = null;
  private seq = 0;

  constructor(
    public connId: string,
    /** Database name ("0".."15"), always explicit. */
    private db: string,
    readonly key: string,
    private host: KeyHost,
    private hintType = "",
  ) {
    this.title = key;
    const e = store.conns.get(connId);
    this.database = db === e?.defaultDb ? null : db;
    this.headEl = h("div", { class: "kv-head" });
    this.bodyEl = h("div", { class: "kv-body" });
    this.el = h("div", { class: "keyview", tabindex: "-1" }, this.headEl, this.bodyEl);
    this.renderHead();
    this.renderBody();
    void this.load(DEFAULT_LIMIT);
  }

  // ---------------------------------------------------------------- TabPane

  get effectiveDatabase(): string {
    return this.db;
  }
  get isRunning(): boolean {
    return false;
  }
  /** Last known key type ("" until loaded): restore on launch shows the right tab icon before loading. */
  get keyType(): string {
    return this.value?.keyType ?? this.hintType;
  }
  get tabIcon(): { icon: string; cls: string } {
    const t = typeInfo(this.value?.keyType ?? this.hintType);
    return { icon: t.icon, cls: t.cls };
  }
  focus(): void {
    this.el.focus({ preventScroll: true });
  }
  updateSchema(): void {}
  dropSession(): void {
    this.error = "The connection was closed. Reconnect and refresh.";
    this.renderBody();
  }
  async dispose(): Promise<void> {
    this.alive = false;
  }
  async switchDatabase(): Promise<void> {}
  async switchConnection(): Promise<void> {}
  currentSchemaName(): string | null {
    return null;
  }
  async setDefaultSchema(): Promise<void> {}

  /** The key was deleted elsewhere (explorer, another tab). */
  markGone(): void {
    this.gone = true;
    this.value = this.value ? { ...this.value, ttl: null } : null;
    this.renderHead();
    this.renderBody();
    this.host.changed(this);
  }

  matches(connId: string, db: string, key: string): boolean {
    return this.connId === connId && this.db === db && this.key === key;
  }

  get isGone(): boolean {
    return this.gone;
  }

  get readOnly(): boolean {
    return store.conns.get(this.connId)?.config.readOnly === true;
  }

  // ---------------------------------------------------------------- loading

  async load(limit: number = this.limit): Promise<void> {
    const mine = ++this.seq;
    this.loading = true;
    this.renderHead();
    if (!this.value) this.renderBody();
    try {
      const s = await redisSession(this.connId, this.db);
      const v = await api.redisGet(s.sessionId, this.key, limit);
      if (!this.alive || mine !== this.seq) return;
      this.value = v;
      this.limit = limit;
      this.error = null;
      this.gone = v.keyType === "none" || v.keyType === "";
    } catch (e) {
      if (!this.alive || mine !== this.seq) return;
      this.error = errMsg(e);
    } finally {
      if (this.alive && mine === this.seq) {
        this.loading = false;
        this.renderHead();
        this.renderBody();
        this.host.changed(this);
      }
    }
  }

  // ---------------------------------------------------------------- actions

  private async setTtl(): Promise<void> {
    if (this.readOnly) return;
    const cur = this.value?.ttl;
    const text = await promptDialog("Set TTL", "Time to live", cur !== null && cur !== undefined ? String(Math.round(cur)) : "", "Set TTL", [], {
      icon: "clock",
      hint: "Seconds, or 5m / 2h / 1d. Type “persist” to remove the expiry.",
      validate: (v) => (parseTtlInput(v) === undefined ? "Not a valid TTL — try 90, 5m, 2h, 1d or persist." : null),
    });
    if (text === null) return;
    const ttl = parseTtlInput(text);
    if (ttl === undefined) return;
    // v0.17: production sources confirm the write
    const prod = await confirmProdRedisAction({ config: store.conns.get(this.connId)?.config, where: dbLabel(this.db), title: "Change a TTL on production?", command: ttl === null ? "PERSIST" : "EXPIRE", keys: [this.key], args: ttl === null ? [] : [String(ttl)], okLabel: ttl === null ? "Remove expiry" : "Set TTL" });
    if (prod === false) return;
    try {
      const s = await redisSession(this.connId, this.db);
      await api.redisSetTtl(s.sessionId, this.key, ttl);
      toast(ttl === null ? "Expiry removed" : `TTL set to ${ttlLong(ttl)}`, "ok");
      this.host.ttlChanged(this.connId, this.db, this.key, ttl);
      await this.load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  private async remove(): Promise<void> {
    if (this.readOnly) return;
    // v0.17: on a production source its confirmation replaces the plain one (never two prompts)
    const prod = await confirmProdRedisAction({ config: store.conns.get(this.connId)?.config, where: dbLabel(this.db), title: "Delete a key on production?", command: "DEL", keys: [this.key], okLabel: "Delete key" });
    const ok = prod ?? (await confirmDialog("Delete key?", `“${this.key}” will be removed from ${dbLabel(this.db)}. This can't be undone.`, "Delete", true));
    if (!ok) return;
    try {
      const s = await redisSession(this.connId, this.db);
      const n = await api.redisDelete(s.sessionId, [this.key]);
      toast(n > 0 ? "Key deleted" : "Key was already gone", n > 0 ? "ok" : "info");
      this.host.keysDeleted(this.connId, this.db, [this.key]);
      this.markGone();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  /** Text for "Copy value": the raw string, else JSON. */
  private copyPayload(): string {
    const v = this.value;
    if (!v) return "";
    if (typeof v.value === "string") return v.value;
    return JSON.stringify(v.value, null, 2);
  }

  private async copyValue(): Promise<void> {
    if (!this.value) return;
    await copyText(this.copyPayload());
    toast("Value copied", "ok");
  }

  // ---------------------------------------------------------------- header

  private renderHead(): void {
    clear(this.headEl);
    const v = this.value;
    const t = typeInfo(v?.keyType ?? this.hintType);
    const ro = this.readOnly;
    const dead = this.gone || !v;
    const btn = (label: string, ic: string, fn: () => void, cls = "", disabled = false, title = label): HTMLButtonElement =>
      h("button", { class: "kv-btn " + cls, type: "button", title, "aria-label": label, disabled, onclick: fn }, icon(ic, 14), h("span", null, label));

    const keyEl = h(
      "button",
      { class: "kv-key", type: "button", title: "Copy key name", onclick: () => void copyText(this.key).then(() => toast("Key copied", "ok")) },
      h("span", { class: "kv-key-text" }, this.key),
      icon("copy", 12),
    );
    const top = h(
      "div",
      { class: "kv-top" },
      h("span", { class: "kv-type-ico " + t.cls }, icon(t.icon, 16)),
      keyEl,
      h("div", { class: "spacer" }),
      btn("Refresh", "refresh", () => void this.load(), "", this.loading, "Reload the value"),
      btn("Copy value", "copy", () => void this.copyValue(), "", dead || !v),
      btn("Delete", "trash", () => void this.remove(), "danger", dead || ro, ro ? "Read-only connection" : "Delete this key"),
    );

    const stat = (k: string, val: string, extra = ""): HTMLElement => h("span", { class: "kv-stat " + extra }, h("span", { class: "k" }, k), h("span", { class: "v" }, val));
    const stats: HTMLElement[] = [h("span", { class: "kv-chip " + t.cls, title: t.label }, t.chip)];
    if (v && !this.gone) {
      const ttlEl = h(
        "button",
        {
          class: "kv-stat kv-ttl" + (v.ttl === null ? " none" : ""),
          type: "button",
          disabled: ro,
          title: ro ? "Read-only connection" : v.ttl === null ? "No expiry — click to set a TTL" : `Expires in ${v.ttl} s — click to change`,
          onclick: () => void this.setTtl(),
        },
        h("span", { class: "k" }, "TTL"),
        h("span", { class: "v" }, v.ttl === null ? "∞" : ttlLong(v.ttl)),
        ro ? null : icon("pencil", 11),
      );
      stats.push(ttlEl);
      if (v.size !== null && v.size !== undefined) {
        const noun = NOUN[v.keyType];
        stats.push(stat("Size", noun ? `${v.size.toLocaleString()} ${noun[v.size === 1 ? 0 : 1]}` : (humanSize(v.size) ?? String(v.size))));
      }
      if (v.memoryBytes !== null && v.memoryBytes !== undefined) stats.push(stat("Memory", humanSize(v.memoryBytes) ?? "—"));
    } else if (this.gone) {
      stats.push(h("span", { class: "kv-stat gone" }, "deleted"));
    }
    stats.push(h("span", { class: "kv-where" }, dbLabel(this.db)));
    this.headEl.append(top, h("div", { class: "kv-meta" }, stats));
  }

  // ---------------------------------------------------------------- body

  private renderBody(): void {
    clear(this.bodyEl);
    const v = this.value;
    if (this.error && !v) {
      this.bodyEl.append(h("div", { class: "r-message err", role: "alert" }, icon("alert", 20), h("div", { class: "r-message-title" }, "Could not read the key"), h("div", { class: "r-error-text" }, this.error), errorHelpButton(this.error, { driver: "redis" })));
      return;
    }
    if (!v) {
      this.bodyEl.append(h("div", { class: "r-wait", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, "Loading…")));
      return;
    }
    if (this.gone) {
      this.bodyEl.append(h("div", { class: "r-message" }, icon("trash", 20), h("div", { class: "r-message-title" }, "This key no longer exists"), h("div", { class: "r-message-sub" }, "It was deleted or has expired. Refresh to check again.")));
      return;
    }
    if (typeof v.value === "string" || v.keyType === "string" || v.keyType === "ReJSON-RL") {
      this.renderText(v);
      return;
    }
    this.renderGrid(v);
  }

  private renderText(v: RedisValue): void {
    const raw = typeof v.value === "string" ? v.value : cellText(v.value);
    const isJsonType = v.keyType === "ReJSON-RL";
    const parsed = parseJsonLoose(raw, isJsonType);
    const canPretty = parsed !== undefined && typeof parsed === "object";
    const showPretty = canPretty && this.pretty;
    let text = showPretty ? JSON.stringify(parsed, null, 2) : raw;
    const cut = text.length > MAX_TEXT;
    if (cut) text = text.slice(0, MAX_TEXT);
    const pre = h("pre", { class: "kv-pre" + (showPretty ? " json" : ""), tabindex: "0", "aria-label": "Value" });
    if (showPretty && text.length <= MAX_TINT) pre.appendChild(tintJson(text));
    else pre.textContent = text;

    const seg = canPretty
      ? h(
          "div",
          { class: "seg kv-seg", role: "radiogroup", "aria-label": "Display" },
          (["pretty", "raw"] as const).map((m) =>
            h(
              "button",
              {
                type: "button",
                class: "seg-btn" + ((m === "pretty") === this.pretty ? " on" : ""),
                role: "radio",
                "aria-checked": String((m === "pretty") === this.pretty),
                onclick: () => {
                  this.pretty = m === "pretty";
                  this.renderBody();
                },
              },
              m === "pretty" ? "Pretty" : "Raw",
            ),
          ),
        )
      : null;
    const info = `${raw.length.toLocaleString()} chars${canPretty ? " · JSON" : isJsonType ? " · invalid JSON" : ""}${cut ? " · first " + MAX_TEXT.toLocaleString() + " shown" : ""}`;
    this.bodyEl.append(h("div", { class: "kv-bar" }, seg, h("span", { class: "kv-bar-info" }, info)), h("div", { class: "kv-textwrap" }, pre));
  }

  private renderGrid(v: RedisValue): void {
    if (!this.grid) {
      this.grid = new ResultGrid({
        onSubmit: async () => undefined,
        onLoadMore: () => void this.load(this.limit * 2),
        onExport: () => undefined,
      });
    }
    const g = this.grid;
    const noun = NOUN[v.keyType] ?? ["element", "elements"];
    g.setOptions({
      hideExport: true,
      hideReadOnlyChip: true,
      plainMenu: true,
      fillLast: true,
      loadMoreLabel: "Load more",
      minWidths: v.keyType === "stream" ? [196, 0] : v.keyType === "zset" ? [200, 110] : [],
      loadMoreTitle: `Showing the first ${this.limit.toLocaleString()} ${noun[1]} — load ${(this.limit * 2).toLocaleString()}`,
      countLabel: (shown, total, truncated) => (truncated ? `First ${total.toLocaleString()} ${noun[1]}` : `${shown === total ? total.toLocaleString() : `${shown.toLocaleString()} of ${total.toLocaleString()}`} ${noun[total === 1 ? 0 : 1]}`),
    });
    g.setResult(valueToResult(v), null, "", this.limit);
    g.setMeta("");
    this.bodyEl.append(g.el);
  }
}
