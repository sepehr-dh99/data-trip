// Redis helpers shared by the explorer, key viewer, console and navigator. No DOM, no CodeMirror.
import { api } from "../api";
import type { DatabaseNode, RedisKey, SessionInfo } from "../types";
import { store } from "./state";

// ---------------------------------------------------------------- key types

export interface TypeInfo {
  /** Short chip text (STR, HASH, …). */
  chip: string;
  /** CSS modifier (kt-str …) that sets the muted type color. */
  cls: string;
  icon: string;
  label: string;
}

const TYPES: Record<string, TypeInfo> = {
  string: { chip: "STR", cls: "kt-str", icon: "kString", label: "string" },
  hash: { chip: "HASH", cls: "kt-hash", icon: "kHash", label: "hash" },
  list: { chip: "LIST", cls: "kt-list", icon: "kList", label: "list" },
  set: { chip: "SET", cls: "kt-set", icon: "kSet", label: "set" },
  zset: { chip: "ZSET", cls: "kt-zset", icon: "kZset", label: "sorted set" },
  stream: { chip: "STRM", cls: "kt-strm", icon: "kStream", label: "stream" },
  "ReJSON-RL": { chip: "JSON", cls: "kt-json", icon: "kJson", label: "JSON" },
};

export function typeInfo(t: string): TypeInfo {
  return TYPES[t] ?? { chip: t ? t.slice(0, 4).toUpperCase() : "KEY", cls: "kt-other", icon: "key", label: t || "key" };
}

// ---------------------------------------------------------------- TTL

/** Compact TTL for tree rows: "45s", "12m", "3h", "5d"; "" when the key never expires. */
export function ttlShort(ttl: number | null | undefined): string {
  if (ttl === null || ttl === undefined || ttl < 0) return "";
  if (ttl < 60) return `${Math.max(0, Math.round(ttl))}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

/** Longer TTL for the key header: "2h 5m", "12m 3s". */
export function ttlLong(ttl: number | null | undefined): string {
  if (ttl === null || ttl === undefined || ttl < 0) return "no expiry";
  const d = Math.floor(ttl / 86400);
  const hr = Math.floor((ttl % 86400) / 3600);
  const m = Math.floor((ttl % 3600) / 60);
  const s = Math.floor(ttl % 60);
  const parts = d ? [`${d}d`, hr ? `${hr}h` : ""] : hr ? [`${hr}h`, m ? `${m}m` : ""] : m ? [`${m}m`, s ? `${s}s` : ""] : [`${s}s`];
  return parts.filter(Boolean).join(" ");
}

/** "90", "5m", "2h", "1d", "1w" → seconds; "persist" / "none" / "-1" / "∞" → null; invalid → undefined. */
export function parseTtlInput(text: string): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (t === "persist" || t === "none" || t === "never" || t === "-1" || t === "∞") return null;
  const m = /^(\d+)\s*(s|m|h|d|w)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] ?? "s") as "s"];
  const secs = n * mult;
  return secs >= 1 && Number.isSafeInteger(secs) ? secs : undefined;
}

// ---------------------------------------------------------------- databases

export const dbLabel = (name: string | null | undefined): string => `db${name ?? "0"}`;

/** Key count from a DatabaseNode comment ("12 keys"); null when unknown. */
export function redisKeyCount(d: DatabaseNode): number | null {
  const m = /^\s*([\d,]+)\s+keys?\b/i.exec(d.comment ?? "");
  return m ? Number(m[1].replace(/,/g, "")) : /^\s*empty\b/i.test(d.comment ?? "") ? 0 : null;
}

export function redisDbMeta(d: DatabaseNode): string {
  const n = redisKeyCount(d);
  if (n === 0) return "empty";
  return d.comment ?? "";
}

/** The explorer-side session for (connection, database): opens it on demand. */
export async function redisSession(connId: string, db: string | null): Promise<SessionInfo> {
  const e = store.conns.get(connId);
  if (!e || e.status !== "connected" || !e.session) throw new Error("Not connected");
  const name = db ?? e.defaultDb ?? "0";
  if (name === e.defaultDb) return e.session;
  await store.ensureDb(connId, name);
  const s = e.dbs.get(name)?.session;
  if (!s) throw new Error(e.dbs.get(name)?.error ?? `Could not open database ${name}`);
  return s;
}

/** Scans for keys whose name contains `query` (case-sensitive glob). Stops after `limit` hits. */
export async function searchKeys(sessionId: string, query: string, limit: number, isStale: () => boolean): Promise<{ keys: RedisKey[]; complete: boolean }> {
  const hits: RedisKey[] = [];
  const seen = new Set<string>();
  let cursor = "0";
  for (let step = 0; step < 40; step++) {
    const r = await api.redisScan(sessionId, `*${query}*`, cursor, 500, null);
    if (isStale()) return { keys: hits, complete: false };
    for (const k of r.keys) {
      if (seen.has(k.key)) continue;
      seen.add(k.key);
      hits.push(k);
    }
    if (r.done || hits.length >= limit) return { keys: hits.slice(0, limit), complete: r.done && hits.length <= limit };
    cursor = r.cursor;
  }
  return { keys: hits.slice(0, limit), complete: false };
}

// ---------------------------------------------------------------- namespace trie

export interface TNode {
  name: string;
  /** Prefix including the trailing ":" ("user:1001:"); "" for the root. */
  path: string;
  children: Map<string, TNode>;
  leaves: RedisKey[];
  /** Loaded keys at or below this node. */
  count: number;
  cache?: { folders: TNode[]; leaves: RedisKey[] };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const node = (name: string, path: string): TNode => ({ name, path, children: new Map(), leaves: [], count: 0 });

/** Last ":" segment of a key. */
export const leafName = (key: string): string => key.slice(key.lastIndexOf(":") + 1);

/** Incrementally built ":" namespace tree: adding a batch is O(batch · depth). */
export class KeyTrie {
  root: TNode = node("", "");
  private seen = new Map<string, RedisKey>();

  get size(): number {
    return this.seen.size;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  get(key: string): RedisKey | undefined {
    return this.seen.get(key);
  }

  /** Adds keys that are not in the tree yet; returns how many were new. */
  add(batch: RedisKey[]): number {
    let added = 0;
    for (const k of batch) {
      if (this.seen.has(k.key)) continue;
      this.seen.set(k.key, k);
      added++;
      const parts = k.key.split(":");
      parts.pop();
      let n = this.root;
      n.count++;
      n.cache = undefined;
      for (const seg of parts) {
        let c = n.children.get(seg);
        if (!c) {
          c = node(seg, n.path + seg + ":");
          n.children.set(seg, c);
        }
        c.count++;
        c.cache = undefined;
        n = c;
      }
      n.leaves.push(k);
    }
    return added;
  }

  /** Drops keys (rebuilds the tree from what remains). */
  remove(keys: Iterable<string>): void {
    const gone = new Set(keys);
    const rest = [...this.seen.values()].filter((k) => !gone.has(k.key));
    this.root = node("", "");
    this.seen = new Map();
    this.add(rest);
  }

  /** Sorted folders then sorted leaves of a node (cached until the node changes). */
  childrenOf(n: TNode): { folders: TNode[]; leaves: RedisKey[] } {
    if (!n.cache) {
      n.cache = {
        folders: [...n.children.values()].sort((a, b) => collator.compare(a.name, b.name)),
        leaves: n.leaves.slice().sort((a, b) => collator.compare(a.key, b.key)),
      };
    }
    return n.cache;
  }

  /** Every loaded key at or below a node. */
  collect(n: TNode): string[] {
    const out: string[] = [];
    const walk = (x: TNode): void => {
      for (const k of x.leaves) out.push(k.key);
      for (const c of x.children.values()) walk(c);
    };
    walk(n);
    return out;
  }

  /** Namespace folders at or below `n` (depth-limited), for auto-expansion. */
  folders(n: TNode, maxDepth: number, maxCount: number, out: TNode[] = [], depth = 1): TNode[] {
    if (depth > maxDepth) return out;
    for (const c of n.children.values()) {
      if (c.count <= maxCount) {
        out.push(c);
        this.folders(c, maxDepth, maxCount, out, depth + 1);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- console: line splitting

export interface RedisLine {
  text: string;
  from: number;
  to: number;
}

/** Splits console text into runnable lines: non-empty, not `#` / `//` comment lines. */
export function splitRedisLines(text: string): RedisLine[] {
  const out: RedisLine[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    const from = pos;
    pos += raw.length + 1;
    const t = raw.replace(/\r$/, "");
    const trimmed = t.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const lead = t.length - t.trimStart().length;
    out.push({ text: trimmed, from: from + lead, to: from + lead + trimmed.length });
  }
  return out;
}

/** The runnable line(s) for a cursor / selection (from, to are document offsets). */
export function redisLinesAt(text: string, from: number, to: number): RedisLine[] {
  const lines = splitRedisLines(text);
  if (from === to) {
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const nl = text.indexOf("\n", from);
    const lineEnd = nl < 0 ? text.length : nl;
    return lines.filter((l) => l.from >= lineStart && l.to <= lineEnd);
  }
  return lines.filter((l) => l.to > from && l.from < to);
}

// ---------------------------------------------------------------- console: command catalog

export interface RedisCommand {
  name: string;
  group: string;
  sig: string;
}

const CATALOG = `
# string
APPEND key value
DECR key
DECRBY key decrement
GET key
GETDEL key
GETEX key [EX seconds | PX ms | EXAT ts | PXAT ts | PERSIST]
GETRANGE key start end
GETSET key value
INCR key
INCRBY key increment
INCRBYFLOAT key increment
LCS key1 key2 [LEN] [IDX] [MINMATCHLEN n] [WITHMATCHLEN]
MGET key [key ...]
MSET key value [key value ...]
MSETNX key value [key value ...]
PSETEX key ms value
SET key value [NX | XX] [GET] [EX s | PX ms | EXAT ts | PXAT ts | KEEPTTL]
SETEX key seconds value
SETNX key value
SETRANGE key offset value
STRLEN key
SUBSTR key start end
# hash
HDEL key field [field ...]
HEXISTS key field
HEXPIRE key seconds FIELDS n field [field ...]
HGET key field
HGETALL key
HINCRBY key field increment
HINCRBYFLOAT key field increment
HKEYS key
HLEN key
HMGET key field [field ...]
HMSET key field value [field value ...]
HRANDFIELD key [count [WITHVALUES]]
HSCAN key cursor [MATCH pattern] [COUNT count]
HSET key field value [field value ...]
HSETNX key field value
HSTRLEN key field
HTTL key FIELDS n field [field ...]
HVALS key
# list
BLMOVE source destination LEFT|RIGHT LEFT|RIGHT timeout
BLMPOP timeout numkeys key [key ...] LEFT|RIGHT [COUNT n]
BLPOP key [key ...] timeout
BRPOP key [key ...] timeout
BRPOPLPUSH source destination timeout
LINDEX key index
LINSERT key BEFORE|AFTER pivot element
LLEN key
LMOVE source destination LEFT|RIGHT LEFT|RIGHT
LMPOP numkeys key [key ...] LEFT|RIGHT [COUNT n]
LPOP key [count]
LPOS key element [RANK r] [COUNT c] [MAXLEN m]
LPUSH key element [element ...]
LPUSHX key element [element ...]
LRANGE key start stop
LREM key count element
LSET key index element
LTRIM key start stop
RPOP key [count]
RPOPLPUSH source destination
RPUSH key element [element ...]
RPUSHX key element [element ...]
# set
SADD key member [member ...]
SCARD key
SDIFF key [key ...]
SDIFFSTORE destination key [key ...]
SINTER key [key ...]
SINTERCARD numkeys key [key ...] [LIMIT n]
SINTERSTORE destination key [key ...]
SISMEMBER key member
SMEMBERS key
SMISMEMBER key member [member ...]
SMOVE source destination member
SPOP key [count]
SRANDMEMBER key [count]
SREM key member [member ...]
SSCAN key cursor [MATCH pattern] [COUNT count]
SUNION key [key ...]
SUNIONSTORE destination key [key ...]
# zset
BZPOPMAX key [key ...] timeout
BZPOPMIN key [key ...] timeout
ZADD key [NX | XX] [GT | LT] [CH] [INCR] score member [score member ...]
ZCARD key
ZCOUNT key min max
ZDIFF numkeys key [key ...] [WITHSCORES]
ZINCRBY key increment member
ZINTER numkeys key [key ...] [WITHSCORES]
ZINTERSTORE destination numkeys key [key ...]
ZLEXCOUNT key min max
ZMSCORE key member [member ...]
ZPOPMAX key [count]
ZPOPMIN key [count]
ZRANDMEMBER key [count [WITHSCORES]]
ZRANGE key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]
ZRANGEBYLEX key min max [LIMIT offset count]
ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]
ZRANGESTORE dst src min max [BYSCORE | BYLEX] [REV] [LIMIT offset count]
ZRANK key member [WITHSCORE]
ZREM key member [member ...]
ZREMRANGEBYLEX key min max
ZREMRANGEBYRANK key start stop
ZREMRANGEBYSCORE key min max
ZREVRANGE key start stop [WITHSCORES]
ZREVRANGEBYSCORE key max min [WITHSCORES] [LIMIT offset count]
ZREVRANK key member [WITHSCORE]
ZSCAN key cursor [MATCH pattern] [COUNT count]
ZSCORE key member
ZUNION numkeys key [key ...] [WITHSCORES]
ZUNIONSTORE destination numkeys key [key ...]
# stream
XACK key group id [id ...]
XADD key [NOMKSTREAM] [MAXLEN | MINID [= | ~] threshold] * | id field value [field value ...]
XAUTOCLAIM key group consumer min-idle-time start [COUNT n]
XCLAIM key group consumer min-idle-time id [id ...]
XDEL key id [id ...]
XGROUP CREATE key group id | $ [MKSTREAM]
XINFO STREAM | GROUPS | CONSUMERS key [group]
XLEN key
XPENDING key group [[IDLE ms] start end count [consumer]]
XRANGE key start end [COUNT n]
XREAD [COUNT n] [BLOCK ms] STREAMS key [key ...] id [id ...]
XREADGROUP GROUP group consumer [COUNT n] [BLOCK ms] [NOACK] STREAMS key [key ...] id [id ...]
XREVRANGE key end start [COUNT n]
XSETID key last-id
XTRIM key MAXLEN | MINID [= | ~] threshold [LIMIT n]
# keys
COPY source destination [DB n] [REPLACE]
DEL key [key ...]
DUMP key
EXISTS key [key ...]
EXPIRE key seconds [NX | XX | GT | LT]
EXPIREAT key unix-seconds [NX | XX | GT | LT]
EXPIRETIME key
KEYS pattern
MOVE key db
OBJECT ENCODING | FREQ | IDLETIME | REFCOUNT key
PERSIST key
PEXPIRE key ms [NX | XX | GT | LT]
PEXPIREAT key unix-ms [NX | XX | GT | LT]
PEXPIRETIME key
PTTL key
RANDOMKEY
RENAME key newkey
RENAMENX key newkey
RESTORE key ttl serialized-value [REPLACE] [ABSTTL]
SCAN cursor [MATCH pattern] [COUNT count] [TYPE type]
SORT key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC | DESC] [ALPHA] [STORE destination]
TOUCH key [key ...]
TTL key
TYPE key
UNLINK key [key ...]
WAIT numreplicas timeout
# bit / geo
BITCOUNT key [start end [BYTE | BIT]]
BITFIELD key [GET type offset] [SET type offset value] [INCRBY type offset increment]
BITOP AND | OR | XOR | NOT destkey key [key ...]
BITPOS key bit [start [end [BYTE | BIT]]]
GETBIT key offset
SETBIT key offset value
PFADD key element [element ...]
PFCOUNT key [key ...]
PFMERGE destkey sourcekey [sourcekey ...]
GEOADD key [NX | XX] [CH] longitude latitude member [...]
GEODIST key member1 member2 [M | KM | FT | MI]
GEOHASH key member [member ...]
GEOPOS key member [member ...]
GEOSEARCH key FROMMEMBER member | FROMLONLAT lon lat BYRADIUS r unit | BYBOX w h unit [ASC | DESC] [COUNT n] [WITHCOORD] [WITHDIST]
GEOSEARCHSTORE destination source FROMMEMBER member | FROMLONLAT lon lat BYRADIUS r unit [STOREDIST]
# server
ACL LIST | WHOAMI | USERS | GETUSER user | SETUSER user rule ... | DELUSER user | CAT [category] | LOG [count]
BGREWRITEAOF
BGSAVE [SCHEDULE]
CLIENT ID | INFO | LIST | GETNAME | SETNAME name | KILL ... | PAUSE ms | UNPAUSE
COMMAND [COUNT | INFO name ... | DOCS | LIST]
CONFIG GET pattern | SET parameter value | REWRITE | RESETSTAT
DBSIZE
FLUSHALL [ASYNC | SYNC]
FLUSHDB [ASYNC | SYNC]
INFO [section]
LASTSAVE
LATENCY LATEST | HISTORY event | RESET
MEMORY USAGE key [SAMPLES n] | STATS | DOCTOR | PURGE
MODULE LIST
PING [message]
ROLE
SAVE
SELECT index
SLOWLOG GET [count] | LEN | RESET
SWAPDB index1 index2
TIME
ECHO message
AUTH [username] password
HELLO [protover [AUTH username password]]
RESET
# script
EVAL script numkeys [key ...] [arg ...]
EVAL_RO script numkeys [key ...] [arg ...]
EVALSHA sha1 numkeys [key ...] [arg ...]
EVALSHA_RO sha1 numkeys [key ...] [arg ...]
FCALL function numkeys [key ...] [arg ...]
FCALL_RO function numkeys [key ...] [arg ...]
FUNCTION LIST | LOAD code | DELETE library | FLUSH | STATS
SCRIPT EXISTS sha1 ... | FLUSH | LOAD script
PUBLISH channel message
PUBSUB CHANNELS [pattern] | NUMSUB [channel ...] | NUMPAT
SPUBLISH shardchannel message
# json
JSON.ARRAPPEND key path value [value ...]
JSON.ARRINDEX key path value [start [stop]]
JSON.ARRINSERT key path index value [value ...]
JSON.ARRLEN key [path]
JSON.ARRPOP key [path [index]]
JSON.ARRTRIM key path start stop
JSON.CLEAR key [path]
JSON.DEL key [path]
JSON.GET key [path ...]
JSON.MGET key [key ...] path
JSON.MSET key path value [key path value ...]
JSON.NUMINCRBY key path value
JSON.OBJKEYS key [path]
JSON.OBJLEN key [path]
JSON.SET key path value [NX | XX]
JSON.STRAPPEND key [path] value
JSON.STRLEN key [path]
JSON.TOGGLE key path
JSON.TYPE key [path]
# search
FT._LIST
FT.AGGREGATE index query [...]
FT.CREATE index [ON HASH | JSON] [PREFIX n prefix ...] SCHEMA field type [...]
FT.DROPINDEX index [DD]
FT.INFO index
FT.SEARCH index query [LIMIT offset num] [...]
`;

export const REDIS_COMMANDS: RedisCommand[] = (() => {
  const out: RedisCommand[] = [];
  let group = "";
  for (const raw of CATALOG.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      group = line.slice(2);
      continue;
    }
    const sp = line.indexOf(" ");
    const name = sp < 0 ? line : line.slice(0, sp);
    out.push({ name, group, sig: line });
  }
  return out;
})();
