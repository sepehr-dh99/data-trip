// Pure DataGrip data-source parser (no DOM except DOMParser). Never handles passwords.
import type { ConnectionConfig, Driver } from "../types";

export interface ImportCandidate {
  config: ConnectionConfig | null;
  sourceName: string;
  status: "ok" | "warning" | "unsupported";
  message?: string;
  /** The DataGrip source tunnels through SSH (`<ssh-properties><enabled>true`). */
  usesSsh?: boolean;
}

interface RawSsl {
  enabled: string;
  mode: string;
  ca: string;
  cert: string;
  key: string;
}

interface RawSource {
  name: string;
  uuid: string;
  jdbcUrl: string;
  userName: string;
  driverRef: string;
  dbms: string;
  product: string;
  readOnly: boolean;
  sshEnabled: boolean;
  ssl: RawSsl | null;
}

function childText(el: Element, tag: string): string {
  for (const c of Array.from(el.children)) {
    if (c.tagName === tag) return (c.textContent ?? "").trim();
  }
  return "";
}

function parseXmlFragment(xml: string): Element | null {
  const p = new DOMParser();
  let doc = p.parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    doc = p.parseFromString(`<root>${xml}</root>`, "application/xml");
  }
  if (doc.getElementsByTagName("parsererror").length > 0) {
    // Tolerate hand-edited text with bare ampersands.
    const fixed = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
    doc = p.parseFromString(`<root>${fixed}</root>`, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return null;
  }
  return doc.documentElement;
}

/** Finds every <data-source …>…</data-source> (or self-closing) element in arbitrary text. */
function extractRaw(text: string): RawSource[] {
  const out: RawSource[] = [];
  const re = /<data-source\b[^>]*?\/>|<data-source\b[\s\S]*?<\/data-source\s*>/g;
  const t = text.replace(/\r\n?/g, "\n");
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const root = parseXmlFragment(m[0]);
    if (!root) continue;
    const el = root.tagName === "data-source" ? root : root.getElementsByTagName("data-source")[0];
    if (!el) continue;
    const dbInfo = Array.from(el.children).find((c) => c.tagName === "database-info");
    const child = (tag: string): Element | undefined => Array.from(el.children).find((c) => c.tagName === tag);
    const sshEl = child("ssh-properties");
    const sslEl = child("ssl-config");
    out.push({
      sshEnabled: sshEl ? childText(sshEl, "enabled").toLowerCase() === "true" : false,
      ssl: sslEl
        ? { enabled: childText(sslEl, "enabled").toLowerCase(), mode: childText(sslEl, "mode").toUpperCase(), ca: childText(sslEl, "ca-cert"), cert: childText(sslEl, "client-cert"), key: childText(sslEl, "client-key") }
        : null,
      name: (el.getAttribute("name") ?? "").trim(),
      uuid: (el.getAttribute("uuid") ?? "").trim().toLowerCase(),
      jdbcUrl: childText(el, "jdbc-url"),
      userName: childText(el, "user-name"),
      driverRef: childText(el, "driver-ref"),
      dbms: (dbInfo?.getAttribute("dbms") ?? "").trim(),
      product: (dbInfo?.getAttribute("product") ?? "").trim(),
      readOnly: childText(el, "read-only").toLowerCase() === "true",
    });
  }
  return out;
}

function mergeLocal(main: RawSource[], local: RawSource[]): RawSource[] {
  const byId = new Map<string, RawSource>();
  for (const l of local) if (l.uuid) byId.set(l.uuid, l);
  const merged = main.map((m) => {
    const l = m.uuid ? byId.get(m.uuid) : undefined;
    if (!l) return m;
    return {
      ...m,
      userName: m.userName || l.userName,
      jdbcUrl: m.jdbcUrl || l.jdbcUrl,
      driverRef: m.driverRef || l.driverRef,
      dbms: m.dbms || l.dbms,
      product: m.product || l.product,
      readOnly: m.readOnly || l.readOnly,
      sshEnabled: m.sshEnabled || l.sshEnabled,
      ssl: m.ssl ?? l.ssl,
    };
  });
  return main.length === 0 ? local : merged;
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseParams(q: string, sep: RegExp): Record<string, string> {
  const o: Record<string, string> = {};
  for (const part of q.split(sep)) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    o[k] = i < 0 ? "" : dec(part.slice(i + 1).trim());
  }
  return o;
}

/** "host", "host:port", "[::1]:5432", or comma list (first taken). */
function splitHostPort(s: string): { host: string; port: number | null } {
  const first = s.split(",")[0].trim();
  let m = /^\[([^\]]+)\](?::(\d+))?$/.exec(first);
  if (m) return { host: m[1], port: m[2] ? Number(m[2]) : null };
  m = /^([^:]*):(\d+)$/.exec(first);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: first, port: null };
}

type Parsed = Omit<ImportCandidate, "sourceName"> & { baseWarn?: string };

function unsupported(message: string): Parsed {
  return { config: null, status: "unsupported", message };
}

function parseJdbc(url: string, raw: RawSource, base: ConnectionConfig): Parsed {
  const u = url.trim();
  const lower = u.toLowerCase();

  if (lower.startsWith("jdbc:redshift:")) return unsupported("Amazon Redshift is not supported");

  // Redis: jdbc:redis://[user[:pass]@]host[:port][/db] and jdbc:redis:ssl://… (Sentinel / Cluster are not supported)
  if (/^jdbc:redis:(?:sentinel|cluster)/i.test(u)) {
    return unsupported(/sentinel/i.test(u.slice(0, 20)) ? "Redis Sentinel isn't supported" : "Redis Cluster isn't supported");
  }
  let m = /^jdbc:redis(:ssl)?:\/\/(?:([^@/?]*)@)?([^/?]*)(?:\/(\d*))?(?:\?(.*))?$/i.exec(u);
  if (m) {
    const { host, port } = splitHostPort(m[3]);
    const params = parseParams(m[5] ?? "", /&/);
    const tls = !!m[1] || params["ssl"] === "true" || params["tls"] === "true";
    // "user:pass@": keep the user, drop the password (secrets are never imported).
    const ui = m[2] ?? "";
    const colon = ui.indexOf(":");
    const urlUser = dec(colon < 0 ? ui : ui.slice(0, colon));
    const hadPassword = colon >= 0 && ui.slice(colon + 1) !== "";
    const cfg: ConnectionConfig = {
      ...base,
      driver: "redis",
      host: host || "localhost",
      port: port ?? 6379,
      database: m[4] ? String(Number(m[4])) : "0",
      username: base.username || urlUser || null,
      sslMode: tls ? "require" : "disable",
    };
    return hadPassword ? { config: cfg, status: "warning", message: "password in URL ignored" } : { config: cfg, status: "ok" };
  }

  // PostgreSQL
  m = /^jdbc:postgresql:(?:\/\/)?([^/?]*)(?:\/([^?]*))?(?:\?(.*))?$/i.exec(u);
  if (m) {
    const { host, port } = splitHostPort(m[1]);
    const params = parseParams(m[3] ?? "", /&/);
    const ssl = (params["sslmode"] ?? "").toLowerCase();
    const sslMode = ssl === "verify-ca" || ssl === "verify-full" ? ssl : ssl === "require" ? "require" : ssl === "disable" ? "disable" : "prefer";
    const cfg: ConnectionConfig = {
      ...base,
      driver: "postgres",
      host: host || "localhost",
      port: port ?? 5432,
      database: dec(m[2] ?? "") || params["dbname"] || null,
      sslMode,
      sslCaPath: params["sslrootcert"] || null,
      sslCertPath: params["sslcert"] || null,
      sslKeyPath: params["sslkey"] || null,
    };
    return { config: cfg, status: "ok" };
  }

  // MySQL / MariaDB (incl. loadbalance / replication / aws variants)
  m = /^jdbc:(?:mysql|mariadb)(?::[a-z]+)*:\/\/(?:[^@/?]*@)?([^/?]*)(?:\/([^?]*))?(?:\?(.*))?$/i.exec(u);
  if (m) {
    const hostPart = m[1].replace(/^\(.*?\)/, "").trim();
    const { host, port } = splitHostPort(hostPart);
    const params = parseParams(m[3] ?? "", /&/);
    const req = params["usessl"] === "true" || (params["sslmode"] ?? "").toLowerCase() === "required" || (params["sslmode"] ?? "").toLowerCase() === "require";
    const cfg: ConnectionConfig = {
      ...base,
      driver: "mysql",
      host: host || "localhost",
      port: port ?? 3306,
      database: dec(m[2] ?? "") || null,
      sslMode: req ? "require" : "prefer",
    };
    return { config: cfg, status: "ok" };
  }

  // SQLite
  m = /^jdbc:sqlite:(.*)$/i.exec(u);
  if (m) {
    let p = m[1].trim();
    if (p.split("?")[0] === ":memory:" || p === "" || p.toLowerCase().startsWith("file::memory:")) {
      return unsupported("In-memory SQLite databases can't be imported");
    }
    if (p.startsWith("//")) p = p.slice(2);
    p = p.split("?")[0];
    const cfg: ConnectionConfig = { ...base, driver: "sqlite", host: null, port: null, database: null, filePath: p, sslMode: null };
    if (/\$(PROJECT_DIR|ProjectFileDir|USER_HOME|MODULE_DIR|APPLICATION_CONFIG_DIR)\$/i.test(p) || /\$[A-Za-z_]+\$/.test(p)) {
      return { config: cfg, status: "warning", message: "contains a DataGrip path macro — fix the file path after import" };
    }
    return { config: cfg, status: "ok" };
  }

  // SQL Server (Microsoft driver and jTDS)
  m = /^jdbc:(?:jtds:)?sqlserver:\/\/([^;/?]*)(?:\/([^;?]*))?(?:[;?](.*))?$/i.exec(u);
  if (m) {
    const jtds = /^jdbc:jtds:/i.test(u);
    let hostPart = m[1];
    let instance = "";
    const bs = hostPart.indexOf("\\");
    if (bs >= 0) {
      instance = hostPart.slice(bs + 1);
      hostPart = hostPart.slice(0, bs);
    }
    const { host, port } = splitHostPort(hostPart);
    const params = parseParams(m[3] ?? "", /[;&]/);
    let database = dec(m[2] ?? "") || params["databasename"] || params["database"] || null;
    if (jtds && !database) database = null;
    const enc = (params["encrypt"] ?? "").toLowerCase();
    const cfg: ConnectionConfig = {
      ...base,
      driver: "mssql",
      host: host || "localhost",
      port: port ?? 1433,
      database,
      sslMode: enc === "true" || enc === "strict" || (params["ssl"] ?? "").toLowerCase() === "require" ? "require" : "prefer",
      trustServerCertificate: (params["trustservercertificate"] ?? "").toLowerCase() === "true",
    };
    if (instance && port === null) {
      return { config: cfg, status: "warning", message: `named instance “${instance}” — port assumed 1433, adjust it after import` };
    }
    return { config: cfg, status: "ok" };
  }

  const scheme = /^jdbc:([a-z0-9_]+)/i.exec(u)?.[1] ?? u.split(":")[0];
  const label = raw.product || raw.dbms || scheme;
  return unsupported(`${label} isn't supported`);
}

function warn(c: ImportCandidate, msg: string): void {
  if (c.status === "ok") c.status = "warning";
  c.message = c.message ? `${c.message}; ${msg}` : msg;
}

/** `<ssl-config>`: mode REQUIRE / VERIFY_CA / VERIFY_FULL and the PEM paths (secrets are never involved). */
function applySsl(c: ImportCandidate, ssl: RawSsl | null): void {
  const cfg = c.config;
  if (!cfg || !ssl || ssl.enabled === "false") return;
  const mode = ssl.mode === "VERIFY_FULL" ? "verify-full" : ssl.mode === "VERIFY_CA" ? "verify-ca" : ssl.mode === "REQUIRE" ? "require" : null;
  if (mode) cfg.sslMode = mode;
  else if (ssl.enabled === "true" && (!cfg.sslMode || cfg.sslMode === "prefer")) cfg.sslMode = "require";
  if (ssl.ca) cfg.sslCaPath = ssl.ca;
  if (ssl.cert) cfg.sslCertPath = ssl.cert;
  if (ssl.key) cfg.sslKeyPath = ssl.key;
  if ([ssl.ca, ssl.cert, ssl.key].some((p) => /\$[A-Za-z_]+\$/.test(p))) warn(c, "SSL file paths contain a DataGrip macro — fix them after import");
}

function toCandidate(raw: RawSource): ImportCandidate {
  const sourceName = raw.name || raw.uuid || "Unnamed data source";
  if (/kafka/i.test(`${raw.jdbcUrl} ${raw.driverRef} ${raw.product} ${raw.dbms}`)) {
    return { config: null, sourceName, status: "unsupported", message: "Kafka connections aren't stored in dataSources.xml — add it manually" };
  }
  if (!raw.jdbcUrl) {
    return { config: null, sourceName, status: "unsupported", message: "no JDBC URL (probably a non-local data source)" };
  }
  const base: ConnectionConfig = {
    id: raw.uuid,
    name: raw.name || sourceName,
    driver: "postgres" as Driver,
    username: raw.userName || null,
    authMethod: "password",
  };
  if (raw.readOnly) base.readOnly = true;
  const r = parseJdbc(raw.jdbcUrl, raw, base);
  if (r.config && r.config.driver === "sqlite") r.config.username = null;
  const out: ImportCandidate = { config: r.config, sourceName, status: r.status, message: r.message };
  if (r.config && (r.config.driver === "postgres" || r.config.driver === "mysql")) applySsl(out, raw.ssl);
  if (r.config && raw.sshEnabled) {
    out.usesSsh = true;
    warn(out, "uses an SSH tunnel — choose an SSH configuration after import");
  }
  return out;
}

/**
 * Parse DataGrip "Copy Settings" clipboard text, a bare <data-source> element, or a whole
 * `.idea/dataSources.xml`. `localText` is the optional companion `dataSources.local.xml`.
 */
export function parseDataGrip(text: string, localText?: string): ImportCandidate[] {
  const main = extractRaw(text ?? "");
  const local = localText ? extractRaw(localText) : [];
  const all = mergeLocal(main, local);
  const seen = new Set<string>();
  const out: ImportCandidate[] = [];
  for (const r of all) {
    if (r.uuid) {
      if (seen.has(r.uuid)) continue;
      seen.add(r.uuid);
    }
    out.push(toCandidate(r));
  }
  return out;
}
