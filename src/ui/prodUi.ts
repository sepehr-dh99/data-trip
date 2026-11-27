// Production safety UI (v0.16, board W): the connection dialog's "Production data source" section, the thin colored
// "PRODUCTION · <name>" bar at the top of that source's consoles, and the write confirmation.
import type { ConnectionConfig, Driver, ProductionOptions } from "../types";
import { h } from "./dom";
import { opsConfirm } from "./opsDialogs";
import type { OpsConfirmRow } from "./opsDialogs";
import { PROD_COLORS, classifyStatement, prodOptions } from "./prodSafety";
import type { StatementClass } from "./prodSafety";
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
    h("label", { class: "check prod-rule" }, chkConfirm, h("span", null, h("span", null, "Confirm before writes"), h("small", null, "INSERT, UPDATE, DELETE, MERGE and DDL show a summary first"))),
    h("label", { class: "check prod-rule" }, chkType, h("span", null, h("span", null, "Type the data source name for DROP / TRUNCATE"), h("small", null, "An extra step for statements that remove whole tables or all rows"))),
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
    h("span", { class: "prod-bar-note" }, p.confirmWrites ? "writes ask for confirmation" : p.typeNameForDrop ? "DROP / TRUNCATE ask for the name" : "no write confirmation"),
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
