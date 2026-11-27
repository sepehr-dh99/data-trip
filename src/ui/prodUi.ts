// Production safety UI (v0.16, board W): the connection dialog's "Production data source" section, the thin colored
// "PRODUCTION · <name>" bar at the top of that source's consoles, and the write confirmation.
import type { ConnectionConfig, Driver, ProductionOptions, RowEdit } from "../types";
import { h } from "./dom";
import { opsConfirm } from "./opsDialogs";
import type { OpsConfirmRow } from "./opsDialogs";
import { PROD_COLORS, classifyKafkaCommand, classifyRedisCommand, classifyStatement, editCountsText, editStatements, kafkaActionText, prodOptions, statementListText, summarizeEdits } from "./prodSafety";
import type { CommandClass, KafkaAction, ProdFlags, StatementClass } from "./prodSafety";
import { store } from "./state";
import "../styles/ops.css";

// ---------------------------------------------------------------- connection dialog section

export interface ProdSection {
  el: HTMLElement;
  /** What to store in ConnectionConfig.production (null = never marked). */
  value(): ProductionOptions | null;
}

export function productionSection(initial: ProductionOptions | null | undefined, name: () => string): ProdSection {
  let enabled = initial?.enabled === true;
  let color = typeof initial?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(initial.color) ? initial.color : PROD_COLORS[0].hex;
  const chkConfirm = h("input", { type: "checkbox", checked: initial?.confirmWrites !== false });
  const chkType = h("input", { type: "checkbox", checked: initial?.typeNameForDrop !== false });
  const sw = h("button", { class: "sw", type: "button", role: "switch", "aria-label": "Production data source" });
  const swatches = PROD_COLORS.map((c) =>
    h("button", {
      class: "prod-swatch",
      type: "button",
      "aria-label": c.name,
      title: c.name,
      style: `--c:${c.hex}`,
      onclick: () => {
        color = c.hex;
        sync();
      },
    }),
  );
  const previewTag = h("span", { class: "prod-tag-preview" }, "PROD");
  const previewName = h("span", null, "");
  const body = h(
    "div",
    { class: "prod-body" },
    h("div", { class: "prod-colors" }, h("span", { class: "prod-label" }, "Color"), swatches),
    h("label", { class: "check prod-rule" }, chkConfirm, h("span", null, h("span", null, "Confirm before writes"), h("small", null, "SQL writes and DDL, grid edits, Redis write commands and Kafka changes show a summary first"))),
    h("label", { class: "check prod-rule" }, chkType, h("span", null, h("span", null, "Type the data source name for DROP / TRUNCATE"), h("small", null, "An extra step for DROP / TRUNCATE, FLUSHDB / FLUSHALL and deleting Kafka topics"))),
    h("div", { class: "prod-preview" }, h("span", { class: "prod-label" }, "In the explorer"), h("span", { class: "prod-preview-row" }, previewName, previewTag), h("small", null, "Its consoles get a colored PRODUCTION bar, AI is blocked for it (Settings › AI assistant) and ⌘K shows the tag.")),
  );
  const el = h(
    "div",
    { class: "prod-section" },
    h("div", { class: "prod-head" }, sw, h("span", { class: "prod-titles" }, h("span", { class: "prod-title" }, "Production data source"), h("small", null, "Colored bar in its consoles, safer writes"))),
    body,
  );
  const sync = (): void => {
    sw.classList.toggle("on", enabled);
    sw.setAttribute("aria-checked", String(enabled));
    body.classList.toggle("off", !enabled);
    for (const i of [chkConfirm, chkType]) i.disabled = !enabled;
    swatches.forEach((b, i) => b.classList.toggle("on", PROD_COLORS[i].hex.toLowerCase() === color.toLowerCase()));
    previewTag.style.setProperty("--c", color);
    previewName.textContent = name() || "This data source";
    el.style.setProperty("--prod", color);
  };
  sw.addEventListener("click", () => {
    enabled = !enabled;
    sync();
  });
  el.addEventListener("focusin", () => (previewName.textContent = name() || "This data source"));
  sync();
  return {
    el,
    value: (): ProductionOptions | null =>
      enabled || initial ? { enabled, color, confirmWrites: chkConfirm.checked, typeNameForDrop: chkType.checked } : null,
  };
}

// ---------------------------------------------------------------- console bar

const bars = new Set<{ el: HTMLElement; connId: () => string }>();
let subscribed = false;

function paint(b: { el: HTMLElement; connId: () => string }): void {
  const cfg = store.conns.get(b.connId())?.config;
  const p = prodOptions(cfg);
  b.el.hidden = !p;
  if (!p || !cfg) return;
  b.el.style.setProperty("--prod", p.color);
  b.el.replaceChildren(
    h("span", { class: "prod-dot", "aria-hidden": "true" }),
    h("span", { class: "prod-bar-name" }, `PRODUCTION · ${cfg.name}`),
    h("div", { class: "spacer" }),
    h("span", { class: "prod-bar-note" }, p.confirmWrites ? "writes ask for confirmation" : p.typeNameForDrop ? (cfg.driver === "redis" ? "FLUSHDB / FLUSHALL ask for the name" : cfg.driver === "kafka" ? "delete topic asks for the name" : "DROP / TRUNCATE ask for the name") : "no write confirmation"),
  );
}

/** The bar for a console (hidden unless its data source is marked production); kept in sync with the store. */
export function prodBar(connId: () => string): { el: HTMLElement; refresh: () => void; dispose: () => void } {
  const el = h("div", { class: "prod-bar", role: "note", hidden: true });
  const b = { el, connId };
  bars.add(b);
  if (!subscribed) {
    subscribed = true;
    store.subscribe(() => {
      for (const x of bars) paint(x);
    });
  }
  paint(b);
  return { el, refresh: () => paint(b), dispose: () => bars.delete(b) };
}

// ---------------------------------------------------------------- write confirmation

export interface ProdConfirmInput {
  config: ConnectionConfig;
  database: string | null;
  driver: Driver;
  /** Statements about to run (the writes among them are confirmed). */
  stmts: string[];
  /** Estimated rows for a single write (null = no estimate). */
  estimate?: (c: StatementClass, sql: string) => Promise<string | null>;
}

/**
 * Asks before writes on a production data source (Confirm before writes; DROP / TRUNCATE with the typed name when
 * that option is on). True = run. Statements that don't need confirmation pass.
 */
export async function confirmProdWrites(i: ProdConfirmInput): Promise<boolean> {
  const p = prodOptions(i.config);
  if (!p) return true;
  const writes = i.stmts.map((sql) => ({ sql, c: classifyStatement(sql, i.driver) })).filter((x) => x.c.write);
  const ask = writes.filter((x) => p.confirmWrites || (p.typeNameForDrop && x.c.destructive));
  if (!ask.length) return true;
  const needName = p.typeNameForDrop && ask.some((x) => x.c.destructive);
  const source = `${i.config.name}${i.database ? " · " + i.database : ""}`;
  if (ask.length === 1) {
    const { sql, c } = ask[0];
    const rows: OpsConfirmRow[] = [
      { k: "Data source", v: source, tone: "accent" },
      { k: "Statement", v: c.kind },
    ];
    if (c.table) rows.push({ k: "Table", v: c.table });
    if (c.kind === "UPDATE" || c.kind === "DELETE") rows.push({ k: "Filter", v: c.where ?? "(no WHERE clause)", tone: c.noWhere ? "danger" : undefined });
    const warn = c.noWhere
      ? `No WHERE clause: every row in ${c.table ?? "the table"} will be ${c.kind === "UPDATE" ? "updated" : "deleted"}.`
      : c.destructive
        ? "This removes data permanently and cannot be undone after commit."
        : "";
    const one = sql.trim();
    return opsConfirm({
      title: `Run ${c.kind} on production?`,
      rows,
      lateRow: i.estimate ? { k: "Affects", value: i.estimate(c, sql), tone: "warn" } : undefined,
      warn: warn || undefined,
      sql: one.length > 1200 ? one.slice(0, 1200) + "…" : one,
      typeName: needName ? i.config.name : undefined,
      okLabel: `Run ${c.kind}`,
      color: p.color,
    });
  }
  const noWhere = ask.filter((x) => x.c.noWhere);
  const destructive = ask.filter((x) => x.c.destructive);
  const rows: OpsConfirmRow[] = [{ k: "Data source", v: source, tone: "accent" }];
  ask.slice(0, 6).forEach((x, n) => rows.push({ k: n === 0 ? "Statements" : "", v: `${x.c.kind}${x.c.table ? " " + x.c.table : ""}${x.c.kind === "UPDATE" || x.c.kind === "DELETE" ? (x.c.noWhere ? " — no WHERE" : " — WHERE " + (x.c.where ?? "")) : ""}`, tone: x.c.noWhere || x.c.destructive ? "danger" : undefined }));
  if (ask.length > 6) rows.push({ k: "", v: `… and ${ask.length - 6} more` });
  const warn = [noWhere.length ? `${noWhere.length} without a WHERE clause (every row is changed).` : "", destructive.length ? `${destructive.length} remove${destructive.length === 1 ? "s" : ""} data permanently.` : ""].filter(Boolean).join(" ");
  return opsConfirm({
    title: `Run ${ask.length} write statements on production?`,
    rows,
    warn: warn || undefined,
    typeName: needName ? i.config.name : undefined,
    okLabel: `Run ${ask.length} statements`,
    color: p.color,
  });
}

// ---------------------------------------------------------------- v0.17: grid edits, Redis, Kafka

/** Whether a production source asks for a change: Confirm before writes, or a destructive one with the typed name. */
function prodAsks(config: ConnectionConfig | null | undefined, destructive: boolean): { p: ProdFlags; needName: boolean } | null {
  const p = prodOptions(config);
  if (!p) return null;
  if (!p.confirmWrites && !(p.typeNameForDrop && destructive)) return null;
  return { p, needName: p.typeNameForDrop && destructive };
}

/**
 * Pending result-grid changes (apply_edits) on a production source with Confirm before writes: counts per kind, the
 * target table and the statements. True = submit (also when no confirmation applies); Cancel keeps the changes pending.
 */
export async function confirmProdEdits(i: { config: ConnectionConfig | null | undefined; database: string | null; driver: Driver; edits: RowEdit[] }): Promise<boolean> {
  const cfg = i.config;
  const ask = prodAsks(cfg, false);
  if (!ask || !cfg || !i.edits.length) return true;
  const s = summarizeEdits(i.edits);
  const n = i.edits.length;
  const rows: OpsConfirmRow[] = [
    { k: "Data source", v: `${cfg.name}${i.database ? " · " + i.database : ""}`, tone: "accent" },
    { k: "Changes", v: editCountsText(s), tone: s.deletes ? "danger" : undefined },
    { k: s.tables.length > 1 ? "Tables" : "Table", v: s.tables.join(", ") },
  ];
  return opsConfirm({
    title: `Write ${n} grid change${n === 1 ? "" : "s"} to production?`,
    rows,
    warn: s.deletes ? `${s.deletes} row${s.deletes === 1 ? " is" : "s are"} deleted — this can't be undone after commit.` : undefined,
    sql: statementListText(editStatements(i.edits, i.driver)),
    okLabel: `Submit ${n} change${n === 1 ? "" : "s"}`,
    color: ask.p.color,
  });
}

function commandWarn(c: CommandClass, driver: "redis" | "kafka", where: string | null): string {
  if (driver === "kafka") return c.destructive ? `Deletes topic ${c.target ?? ""} and every message in it permanently.` : "";
  if (c.kind === "FLUSHDB") return `Every key in ${where ?? "this database"} is deleted permanently.`;
  if (c.kind === "FLUSHALL") return "Every key in every database of this server is deleted permanently.";
  if (c.kind === "SWAPDB") return "Swaps two whole databases for every client of this server.";
  if (c.kind === "SHUTDOWN") return "Stops the Redis server.";
  if (c.destructive) return "Removes server-side scripts / functions for every client.";
  if (c.keys > 1) return `Deletes ${c.keys} keys permanently.`;
  return "";
}

/**
 * Redis / Kafka console lines on a production source: writes (SET, DEL, EXPIRE, HSET…; produce, create topic) ask
 * first when Confirm before writes is on; FLUSHDB / FLUSHALL / SWAPDB / SHUTDOWN and delete topic also need the typed
 * data source name when that option is on. True = run.
 */
export async function confirmProdCommands(i: { config: ConnectionConfig | null | undefined; where: string | null; driver: "redis" | "kafka"; lines: string[] }): Promise<boolean> {
  const cfg = i.config;
  const p = prodOptions(cfg);
  if (!p || !cfg) return true;
  const classify = i.driver === "redis" ? classifyRedisCommand : classifyKafkaCommand;
  // one entry may hold several lines (the Kafka backend runs each line): classify every command line
  const lines = i.lines.flatMap((l) => l.split("\n")).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("//") && !l.startsWith("--"));
  const ask = lines.map((line) => ({ line, c: classify(line) })).filter((x) => x.c.write && (p.confirmWrites || (p.typeNameForDrop && x.c.destructive)));
  if (!ask.length) return true;
  const needName = p.typeNameForDrop && ask.some((x) => x.c.destructive);
  const source = `${cfg.name}${i.where ? " · " + i.where : ""}`;
  const targetK = i.driver === "redis" ? "Key" : "Topic";
  if (ask.length === 1) {
    const { line, c } = ask[0];
    const rows: OpsConfirmRow[] = [
      { k: "Data source", v: source, tone: "accent" },
      { k: "Command", v: c.kind, tone: c.destructive ? "danger" : undefined },
    ];
    if (c.target) rows.push({ k: c.keys > 1 ? "Keys" : targetK, v: c.keys > 1 ? `${c.keys} keys (${c.target}, …)` : c.target });
    const warn = commandWarn(c, i.driver, i.where);
    return opsConfirm({
      title: `Run ${c.kind} on production?`,
      rows,
      warn: warn || undefined,
      sql: line.length > 1200 ? line.slice(0, 1200) + "…" : line,
      typeName: needName ? cfg.name : undefined,
      okLabel: `Run ${c.kind}`,
      color: p.color,
    });
  }
  const rows: OpsConfirmRow[] = [{ k: "Data source", v: source, tone: "accent" }];
  ask.slice(0, 6).forEach((x, n) => rows.push({ k: n === 0 ? "Commands" : "", v: `${x.c.kind}${x.c.target ? " " + x.c.target : ""}`, tone: x.c.destructive ? "danger" : undefined }));
  if (ask.length > 6) rows.push({ k: "", v: `… and ${ask.length - 6} more` });
  const destructive = ask.filter((x) => x.c.destructive);
  return opsConfirm({
    title: `Run ${ask.length} write commands on production?`,
    rows,
    warn: destructive.length ? `${destructive.map((x) => x.c.kind).join(", ")} ${destructive.length === 1 ? "removes" : "remove"} data permanently.` : undefined,
    sql: statementListText(ask.map((x) => x.line), 8, 1600, ""),
    typeName: needName ? cfg.name : undefined,
    okLabel: `Run ${ask.length} commands`,
    color: p.color,
  });
}

/**
 * A Redis pane action (key tab / explorer: Set TTL, Delete key, Delete the keys under a folder) on a production
 * source. null = no production confirmation applies (the caller keeps its own flow); true / false = the answer.
 * `bulk` (several keys at once) needs the typed data source name like DROP / TRUNCATE.
 */
export async function confirmProdRedisAction(i: { config: ConnectionConfig | null | undefined; where: string | null; title: string; command: string; keys: string[]; args?: string[]; bulk?: boolean; note?: string; okLabel: string }): Promise<boolean | null> {
  const cfg = i.config;
  const ask = prodAsks(cfg, i.bulk === true);
  if (!ask || !cfg) return null;
  const rows: OpsConfirmRow[] = [
    { k: "Data source", v: `${cfg.name}${i.where ? " · " + i.where : ""}`, tone: "accent" },
    { k: "Command", v: i.command, tone: i.bulk ? "danger" : undefined },
    { k: i.keys.length > 1 ? "Keys" : "Key", v: i.keys.length > 1 ? `${i.keys.length.toLocaleString("en-US")} keys` : i.keys[0] ?? "" },
  ];
  const shown = i.keys.slice(0, 8).map((k) => (/^[^\s"']+$/.test(k) ? k : JSON.stringify(k)));
  const code = `${i.command} ${shown.join(" ")}${i.keys.length > shown.length ? ` … (+${(i.keys.length - shown.length).toLocaleString("en-US")} more)` : ""}${i.args?.length ? " " + i.args.join(" ") : ""}`;
  return opsConfirm({
    title: i.title,
    text: i.note,
    rows,
    warn: i.command === "DEL" ? (i.keys.length > 1 ? `Deletes ${i.keys.length.toLocaleString("en-US")} keys permanently.` : "Deletes the key permanently.") : undefined,
    sql: code.length > 1600 ? code.slice(0, 1600) + "…" : code,
    typeName: ask.needName ? cfg.name : undefined,
    okLabel: i.okLabel,
    color: ask.p.color,
  });
}

/**
 * A Kafka pane action (produce, create topic, delete topic, reset offsets) on a production source. null = no
 * production confirmation applies. Deleting a topic always needs a typed name: the data source name with "Type the
 * data source name for DROP / TRUNCATE" on, else the topic name (as outside production).
 */
export async function confirmProdKafka(config: ConnectionConfig | null | undefined, a: KafkaAction): Promise<boolean | null> {
  const destructive = a.kind === "delete topic";
  const ask = prodAsks(config, destructive);
  if (!ask || !config) return null;
  const rows: OpsConfirmRow[] = [
    { k: "Data source", v: config.name, tone: "accent" },
    { k: "Action", v: a.kind === "produce" ? "Produce message" : a.kind === "create topic" ? "Create topic" : a.kind === "delete topic" ? "Delete topic" : "Reset offsets", tone: destructive ? "danger" : undefined },
  ];
  if (a.kind === "reset offsets") rows.push({ k: "Group", v: a.group });
  rows.push({ k: "Topic", v: a.topic });
  if (a.kind === "produce") rows.push({ k: "Partition", v: a.partition === null ? "auto" : String(a.partition) });
  if (a.kind === "create topic") rows.push({ k: "Partitions", v: `${a.partitions} · replication ${a.replication}` });
  if (a.kind === "reset offsets") rows.push({ k: "To", v: `${a.to}${a.value !== null ? " " + a.value : ""} · ${a.partitions} partition${a.partitions === 1 ? "" : "s"}`, tone: "warn" });
  const warn =
    a.kind === "delete topic"
      ? "Deletes the topic and every message in it permanently."
      : a.kind === "reset offsets"
        ? "Consumers of this group re-read or skip the messages between the old and new positions."
        : undefined;
  const typeName = destructive ? (ask.needName ? config.name : a.topic) : undefined;
  return opsConfirm({
    title: a.kind === "produce" ? `Produce to ${a.topic} on production?` : a.kind === "create topic" ? "Create a topic on production?" : a.kind === "delete topic" ? `Delete topic ${a.topic} on production?` : "Reset offsets on production?",
    rows,
    warn,
    sql: kafkaActionText(a),
    typeName,
    typeLabel: typeName && typeName !== config.name ? "Type the topic name" : undefined,
    okLabel: a.kind === "produce" ? "Send" : a.kind === "create topic" ? "Create topic" : a.kind === "delete topic" ? "Delete topic" : "Reset offsets",
    color: ask.p.color,
  });
}
