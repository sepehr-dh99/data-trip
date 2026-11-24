// Kafka helpers shared by the explorer, topic / group tabs, console and navigator. No CodeMirror.
import { api } from "../api";
import type { KafkaGroupDetail, KafkaGroupMember, KafkaMessage, KafkaOverview } from "../types";
import { store } from "./state";

// ---------------------------------------------------------------- overview cache (per connection)

interface OvEntry {
  sid: string;
  data: KafkaOverview | null;
  error: string | null;
  promise: Promise<KafkaOverview | null> | null;
}

const cache = new Map<string, OvEntry>();
const listeners = new Set<(connId: string) => void>();

const errText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : (e as { message?: string })?.message ?? String(e));

export function onOverview(fn: (connId: string) => void): void {
  listeners.add(fn);
}

function emit(connId: string): void {
  for (const l of listeners) l(connId);
}

/** The session this connection's Kafka calls go through (null when not connected). */
export function kafkaSid(connId: string): string | null {
  const e = store.conns.get(connId);
  return e && e.status === "connected" && e.session ? e.session.sessionId : null;
}

function entryOf(connId: string): OvEntry | undefined {
  const c = cache.get(connId);
  const sid = kafkaSid(connId);
  return c && sid && c.sid === sid ? c : undefined;
}

/** The cached overview, or null while loading / never loaded. */
export function overviewOf(connId: string): KafkaOverview | null {
  return entryOf(connId)?.data ?? null;
}

export function overviewState(connId: string): { loading: boolean; error: string | null; loaded: boolean } {
  const c = entryOf(connId);
  return { loading: !!c?.promise, error: c?.error ?? null, loaded: !!c?.data };
}

/** Loads (or re-fetches with `fresh`) the brokers / topics / groups of a connection. */
export function loadOverview(connId: string, fresh = false): Promise<KafkaOverview | null> {
  const sid = kafkaSid(connId);
  if (!sid) return Promise.resolve(null);
  const cur = entryOf(connId);
  if (cur?.promise) return cur.promise;
  if (cur?.data && !fresh) return Promise.resolve(cur.data);
  const entry: OvEntry = { sid, data: cur?.data ?? null, error: null, promise: null };
  cache.set(connId, entry);
  entry.promise = api
    .kafkaOverview(sid)
    .then((o) => {
      entry.data = o;
      entry.error = null;
      return o;
    })
    .catch((e) => {
      entry.error = errText(e);
      return entry.data;
    })
    .finally(() => {
      entry.promise = null;
      emit(connId);
    });
  emit(connId);
  return entry.promise;
}

export function forgetOverview(connId: string): void {
  cache.delete(connId);
}

/** Topic / group names for console completion and the navigator. */
export function kafkaNames(connId: string): { topics: string[]; groups: string[] } {
  const o = overviewOf(connId);
  return { topics: o ? o.topics.map((t) => t.name).sort(collate) : [], groups: o ? o.groups.map((g) => g.groupId).sort(collate) : [] };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const collate = (a: string, b: string): number => collator.compare(a, b);

// ---------------------------------------------------------------- formatting

export const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));

/** "7d", "12h", "90m", "45s", "500ms"; "∞" for -1. Takes the raw `retention.ms` text. */
export function humanDuration(ms: string | number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms === "") return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return "∞";
  const units: [string, number][] = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]];
  for (const [u, v] of units) {
    if (n >= v && n % v === 0) return `${n / v}${u}`;
  }
  if (n >= 1000) {
    for (const [u, v] of units) if (n >= v) return `${Number((n / v).toFixed(1))}${u}`;
  }
  return `${n}ms`;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** Local "HH:MM:SS.mmm" (today) or "Mon DD HH:MM:SS.mmm". */
export function fmtTs(ms: number | null): string {
  if (ms === null || ms === undefined || ms < 0) return "—";
  const d = new Date(ms);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return t;
  return `${d.toLocaleString("en-US", { month: "short" })} ${pad(d.getDate())} ${t}`;
}

/** "2026-11-24 18:42:59.100 UTC+1" (local time). */
export function fmtTsFull(ms: number | null): string {
  if (ms === null || ms === undefined || ms < 0) return "—";
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = Math.floor(Math.abs(off) / 60);
  const om = Math.abs(off) % 60;
  const tz = off === 0 ? "UTC" : `UTC${sign}${oh}${om ? ":" + pad(om) : ""}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${tz}`;
}

/** Value for <input type="datetime-local"> from epoch ms (local time). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const bytesText = (n: number): string => (n < 1024 ? `${fmtInt(n)} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** CSS class (k-ok / k-warn / k-danger / k-muted) for a consumer group state. */
export function stateClass(state: string): string {
  switch (state) {
    case "Stable":
      return "k-ok";
    case "Empty":
      return "k-danger";
    case "PreparingRebalance":
    case "CompletingRebalance":
    case "Rebalancing":
      return "k-warn";
    case "Dead":
      return "k-danger";
    default:
      return "k-muted";
  }
}

export const stateLabel = (state: string): string => (/rebalance/i.test(state) ? "Rebalancing" : state || "Unknown");

// ---------------------------------------------------------------- message values

/** True when the text looks like decoded binary (replacement characters / control bytes). */
export function looksBinary(text: string): boolean {
  if (!text) return false;
  const n = Math.min(text.length, 2000);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) bad++;
  }
  return bad / n > 0.02;
}

/** "00000000  7b 22 69 64 …  |{"id…|" hex dump of the UTF-8 bytes. */
export function hexDump(text: string, maxBytes = 4096): string {
  const bytes = new TextEncoder().encode(text);
  const lines: string[] = [];
  const n = Math.min(bytes.length, maxBytes);
  for (let i = 0; i < n; i += 16) {
    const chunk = bytes.slice(i, Math.min(n, i + 16));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  |${ascii}|`);
  }
  if (bytes.length > n) lines.push(`… ${fmtInt(bytes.length - n)} more bytes`);
  return lines.join("\n");
}

/** One-line preview of a message value for the grid. */
export function previewValue(v: string | null): string {
  if (v === null) return "";
  const s = v.length > 400 ? v.slice(0, 400) : v;
  return s.replace(/\s+/g, " ").trim();
}

export const msgKey = (m: KafkaMessage): string => `${m.partition}:${m.offset}`;

// ---------------------------------------------------------------- consumer groups

/** Member descriptions per "topic:partition" parsed from the members' assignment strings. */
export function memberByPartition(g: KafkaGroupDetail): Map<string, KafkaGroupMember> {
  const out = new Map<string, KafkaGroupMember>();
  for (const m of g.members) {
    for (const a of m.assignments) {
      const list = /^(.+?)\[([\d,\s]+)\]$/.exec(a.trim());
      if (list) {
        for (const p of list[2].split(",")) out.set(`${list[1]}:${Number(p)}`, m);
        continue;
      }
      const one = /^(.+?)[:\-/](\d+)$/.exec(a.trim());
      if (one) out.set(`${one[1]}:${Number(one[2])}`, m);
    }
  }
  return out;
}

export const memberLabel = (m: KafkaGroupMember | undefined): string => (m ? `${m.clientId || m.memberId} · ${m.host}` : "—");

// ---------------------------------------------------------------- console command catalog

export interface KafkaCmd {
  name: string;
  sig: string;
  detail: string;
}

export const KAFKA_COMMANDS: KafkaCmd[] = [
  { name: "topics", sig: "topics", detail: "list topics" },
  { name: "groups", sig: "groups", detail: "list consumer groups" },
  { name: "brokers", sig: "brokers", detail: "list brokers" },
  { name: "describe", sig: "describe topic <topic> | describe group <group>", detail: "partitions, configs, members" },
  {
    name: "consume",
    sig: "consume <topic> [--from-beginning|--latest|--from-timestamp <ISO>|--offset <n>] [--partition <n>] [--limit <n>] [--key-contains <s>] [--value-contains <s>]",
    detail: "read messages",
  },
  { name: "produce", sig: "produce <topic> [key=<k>] [partition=<n>] [header.<k>=<v>]… value=<v>", detail: "send a message" },
  { name: "create", sig: "create topic <topic> [partitions=<n>] [replication=<n>]", detail: "create a topic" },
  { name: "delete", sig: "delete topic <topic>", detail: "delete a topic" },
];

export const CONSUME_FLAGS: { name: string; detail: string }[] = [
  { name: "--from-beginning", detail: "oldest first" },
  { name: "--latest", detail: "newest messages" },
  { name: "--from-timestamp", detail: "ISO-8601 time" },
  { name: "--offset", detail: "start offset" },
  { name: "--partition", detail: "one partition" },
  { name: "--limit", detail: "max messages" },
  { name: "--key-contains", detail: "key filter" },
  { name: "--value-contains", detail: "value filter" },
];

export const PRODUCE_FIELDS: { name: string; detail: string }[] = [
  { name: "key=", detail: "message key" },
  { name: "partition=", detail: "target partition" },
  { name: "header.", detail: "header.<name>=<value>" },
  { name: "value=", detail: "message value" },
];
