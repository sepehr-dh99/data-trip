// Cell value viewer (v0.16, board T), the pure part: which cells open the viewer, the default mode, a JSON
// parser that keeps numbers exactly as written (big ids survive), pretty lines with fold paths, hex rows and
// size labels. No DOM; node tests: node scripts/test-data-tools.mjs.
import type { Cell } from "../types";

export type ValueMode = "text" | "json" | "hex";

/** Characters rendered at most (the rest is cut with a note). */
export const VIEW_CAP = 2 * 1024 * 1024;
/** JSON lines rendered at most. */
export const JSON_LINE_CAP = 20000;
/** Bytes shown in hex at most. */
export const HEX_CAP = 64 * 1024;

const BINARY_TYPE = /^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|image|raw|long raw)\b/i;
const JSON_TYPE = /^(json|jsonb)\b/i;

export function isBinaryType(typeName: string): boolean {
  return BINARY_TYPE.test(typeName.trim());
}

export function isJsonType(typeName: string): boolean {
  return JSON_TYPE.test(typeName.trim());
}

/** Text of a cell as the viewer shows it (NULL → ""). */
export function cellText(v: Cell): string {
  if (v === null) return "";
  return typeof v === "string" ? v : String(v);
}

/** `{…}` / `[…]` that parses. */
export function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  const a = t[0];
  const b = t[t.length - 1];
  if (!((a === "{" && b === "}") || (a === "[" && b === "]"))) return false;
  return parseJson(t).ok;
}

/** A binary cell as sent by the backend: "0x" + hex (maybe cut with "…"). */
export function isHexBlob(s: string): boolean {
  return /^0x[0-9a-f]*…?$/i.test(s);
}

/**
 * Double-click opens the viewer instead of the inline editor for long, multi-line, JSON and binary values;
 * short plain values keep the inline edit.
 */
export function wantsViewer(typeName: string, v: Cell): boolean {
  if (v === null || typeof v !== "string") return false;
  if (isBinaryType(typeName) || isJsonType(typeName)) return true;
  if (v.length > 120 || v.includes("\n")) return true;
  const t = v.trimStart();
  if ((t.startsWith("{") || t.startsWith("[")) && v.length > 2 && looksLikeJson(v)) return true;
  return false;
}

export function defaultMode(typeName: string, v: Cell): ValueMode {
  if (isBinaryType(typeName) || (typeof v === "string" && isHexBlob(v) && v.length > 2)) return "hex";
  const s = cellText(v);
  if (isJsonType(typeName) || looksLikeJson(s)) return "json";
  return "text";
}

/** UTF-8 byte length. */
export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function lineCount(s: string): number {
  if (s === "") return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// ------------------------------------------------------------------ hex

/** Bytes of a "0x…" cell (a trailing "…" — cut by the backend at 4096 bytes — is ignored). */
export function hexToBytes(s: string): Uint8Array | null {
  const m = /^0x([0-9a-f]*)(…)?$/i.exec(s.trim());
  if (!m || m[1].length % 2 !== 0) return null;
  const out = new Uint8Array(m[1].length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(m[1].slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export interface HexRow {
  off: string;
  hex: string;
  ascii: string;
}

export function hexRows(bytes: Uint8Array, maxBytes = HEX_CAP): HexRow[] {
  const out: HexRow[] = [];
  const n = Math.min(bytes.length, maxBytes);
  for (let o = 0; o < n; o += 16) {
    const hex: string[] = [];
    let ascii = "";
    for (let i = o; i < Math.min(o + 16, n); i++) {
      const b = bytes[i];
      hex.push(b.toString(16).padStart(2, "0"));
      ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    out.push({ off: o.toString(16).padStart(8, "0"), hex: hex.join(" ").padEnd(47, " "), ascii });
  }
  return out;
}

// ------------------------------------------------------------------ JSON (numbers kept as written)

export type JNode =
  | { t: "obj"; entries: [string, JNode][] }
  | { t: "arr"; items: JNode[] }
  | { t: "str"; v: string }
  | { t: "num"; raw: string }
  | { t: "bool"; v: boolean }
  | { t: "null" };

export type JsonParse = { ok: true; node: JNode } | { ok: false; message: string; pos: number; line: number; col: number };

/** A strict JSON parser keeping number text verbatim (no precision loss), with error positions. */
export function parseJson(text: string): JsonParse {
  let i = 0;
  const n = text.length;
  class Fail {
    message: string;
    pos: number;
    constructor(message: string, pos: number) {
      this.message = message;
      this.pos = pos;
    }
  }
  const fail = (m: string, at = i): never => {
    throw new Fail(m, at);
  };
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const str = (): string => {
    // at the opening quote
    i++;
    let out = "";
    let start = i;
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c === "\\") {
        out += text.slice(start, i);
        const e = text[i + 1];
        const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e === "u") {
          const hx = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hx)) fail("Bad \\u escape in a string");
          out += String.fromCharCode(parseInt(hx, 16));
          i += 6;
        } else if (e !== undefined && map[e] !== undefined) {
          out += map[e];
          i += 2;
        } else fail("Bad escape in a string");
        start = i;
        continue;
      }
      if (text.charCodeAt(i) < 0x20) fail("Control character in a string (escape line breaks as \\n)");
      i++;
    }
    return fail("Unterminated string", n);
  };
  const value = (): JNode => {
    ws();
    if (i >= n) fail("Unexpected end of JSON");
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: [string, JNode][] = [];
      ws();
      if (text[i] === "}") {
        i++;
        return { t: "obj", entries };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(i >= n ? "Unexpected end of JSON" : `Expected a "key" but found ${JSON.stringify(text[i])}`);
        const k = str();
        ws();
        if (text[i] !== ":") fail(`Expected ':' after the key "${k}"`);
        i++;
        entries.push([k, value()]);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return { t: "obj", entries };
        }
        fail(i >= n ? "Unexpected end of JSON (missing '}')" : `Expected ',' or '}' but found ${JSON.stringify(text[i])}`);
      }
    }
    if (c === "[") {
      i++;
      const items: JNode[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return { t: "arr", items };
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return { t: "arr", items };
        }
        fail(i >= n ? "Unexpected end of JSON (missing ']')" : `Expected ',' or ']' but found ${JSON.stringify(text[i])}`);
      }
    }
    if (c === '"') return { t: "str", v: str() };
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (m && m[0].length > 0 && (c === "-" || (c >= "0" && c <= "9"))) {
      i += m[0].length;
      return { t: "num", raw: m[0] };
    }
    if (text.startsWith("true", i)) {
      i += 4;
      return { t: "bool", v: true };
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return { t: "bool", v: false };
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return { t: "null" };
    }
    return fail(`Unexpected ${JSON.stringify(c)}`);
  };
  try {
    const node = value();
    ws();
    if (i < n) fail(`Unexpected ${JSON.stringify(text[i])} after the JSON value`);
    return { ok: true, node };
  } catch (e) {
    if (e instanceof Fail) {
      const before = text.slice(0, e.pos);
      const line = (before.match(/\n/g)?.length ?? 0) + 1;
      const col = e.pos - (before.lastIndexOf("\n") + 1) + 1;
      return { ok: false, message: e.message, pos: e.pos, line, col };
    }
    throw e;
  }
}

/** Compact JSON text of a node (numbers verbatim). */
export function compactJson(node: JNode): string {
  switch (node.t) {
    case "obj":
      return "{" + node.entries.map(([k, v]) => JSON.stringify(k) + ":" + compactJson(v)).join(",") + "}";
    case "arr":
      return "[" + node.items.map(compactJson).join(",") + "]";
    case "str":
      return JSON.stringify(node.v);
    case "num":
      return node.raw;
    case "bool":
      return node.v ? "true" : "false";
    case "null":
      return "null";
  }
}

/** Pretty JSON text (2-space indent, numbers verbatim). */
export function prettyJson(node: JNode, indent = 0): string {
  const pad = "  ".repeat(indent + 1);
  const end = "  ".repeat(indent);
  if (node.t === "obj") {
    if (node.entries.length === 0) return "{}";
    return "{\n" + node.entries.map(([k, v]) => pad + JSON.stringify(k) + ": " + prettyJson(v, indent + 1)).join(",\n") + "\n" + end + "}";
  }
  if (node.t === "arr") {
    if (node.items.length === 0) return "[]";
    return "[\n" + node.items.map((v) => pad + prettyJson(v, indent + 1)).join(",\n") + "\n" + end + "]";
  }
  return compactJson(node);
}

export type JsonSegKind = "key" | "str" | "num" | "bool" | "null" | "punct" | "fold" | "meta";

export interface JsonSeg {
  t: string;
  c: JsonSegKind;
}

export interface JsonLine {
  depth: number;
  /** Fold path of a container's opening line (null otherwise). */
  path: string | null;
  folded: boolean;
  segs: JsonSeg[];
}

/** Lines of the pretty-printed node with folded containers collapsed to `{ … }  N keys`. */
export function jsonLines(node: JNode, folded: ReadonlySet<string>, max = JSON_LINE_CAP): { lines: JsonLine[]; truncated: boolean } {
  const out: JsonLine[] = [];
  let truncated = false;
  const walk = (v: JNode, key: string | null, path: string, depth: number, comma: boolean): void => {
    if (out.length >= max) {
      truncated = true;
      return;
    }
    const kseg: JsonSeg[] = key !== null ? [{ t: JSON.stringify(key), c: "key" }, { t: ": ", c: "punct" }] : [];
    const cm: JsonSeg[] = comma ? [{ t: ",", c: "punct" }] : [];
    if (v.t !== "obj" && v.t !== "arr") {
      const c: JsonSegKind = v.t === "str" ? "str" : v.t === "num" ? "num" : v.t === "bool" ? "bool" : "null";
      out.push({ depth, path: null, folded: false, segs: [...kseg, { t: compactJson(v), c }, ...cm] });
      return;
    }
    const arr = v.t === "arr";
    const count = arr ? v.items.length : v.entries.length;
    const open = arr ? "[" : "{";
    const close = arr ? "]" : "}";
    if (count === 0) {
      out.push({ depth, path: null, folded: false, segs: [...kseg, { t: open + close, c: "punct" }, ...cm] });
      return;
    }
    if (folded.has(path)) {
      out.push({
        depth,
        path,
        folded: true,
        segs: [...kseg, { t: open, c: "punct" }, { t: " … ", c: "fold" }, { t: close, c: "punct" }, ...cm, { t: `   ${count} ${arr ? (count === 1 ? "item" : "items") : count === 1 ? "key" : "keys"}`, c: "meta" }],
      });
      return;
    }
    out.push({ depth, path, folded: false, segs: [...kseg, { t: open, c: "punct" }] });
    if (arr) v.items.forEach((x, j) => walk(x, null, `${path}[${j}]`, depth + 1, j < count - 1));
    else v.entries.forEach(([k, x], j) => walk(x, k, `${path}.${k}`, depth + 1, j < count - 1));
    if (out.length >= max) {
      truncated = true;
      return;
    }
    out.push({ depth, path: null, folded: false, segs: [{ t: close, c: "punct" }, ...cm] });
  };
  walk(node, null, "$", 0, false);
  return { lines: out, truncated };
}

/** Paths "Fold all" collapses: every container directly under the root. */
export function topLevelPaths(node: JNode): string[] {
  const isBox = (v: JNode): boolean => (v.t === "obj" && v.entries.length > 0) || (v.t === "arr" && v.items.length > 0);
  if (node.t === "obj") return node.entries.filter(([, v]) => isBox(v)).map(([k]) => `$.${k}`);
  if (node.t === "arr") return node.items.map((v, j) => (isBox(v) ? `$[${j}]` : "")).filter(Boolean);
  return [];
}

/**
 * The text "Save to grid" stores: valid JSON is kept as typed, except that an originally single-line value
 * stays single-line (compacted, numbers verbatim).
 */
export function jsonToStore(draft: string, original: string): string {
  const p = parseJson(draft);
  if (!p.ok) return draft;
  if (!original.includes("\n")) return compactJson(p.node);
  return draft;
}
