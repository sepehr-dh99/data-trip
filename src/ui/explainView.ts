// Explain plan view in the console's result area (v0.16, board U): ANALYZE warning, header (Plan · info · ANALYZE /
// BUFFERS switches · Tree / Raw · Copy plan), hint line with "Copy CREATE INDEX", the node tree (rows est → actual with
// misestimate flags, self-time / cost-share bars, cost; the slowest node marked) and the selected node's details.
import { copyText, h } from "./dom";
import { fmtRows, misestimate } from "./explainPlan";
import type { Plan, PlanNode } from "./explainPlan";
import { toast } from "./toast";
import "../styles/ops.css";

export interface PlanViewOptions {
  /** Whether the dialect can ANALYZE (switches disabled otherwise). */
  analyzeSupported: boolean;
  /** BUFFERS exists (PostgreSQL). */
  buffersSupported: boolean;
  analyze: boolean;
  buffers: boolean;
  /** The explained statement is a write (ANALYZE ran it inside BEGIN … ROLLBACK). */
  write: boolean;
  /** Statement kind for the warning ("SELECT", "UPDATE"…). */
  kind: string;
  /** "14:06:12". */
  at: string;
  /** Re-explain with other switches. */
  onToggle(analyze: boolean, buffers: boolean): void;
}

const fmtMs = (ms: number): string => (ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : ms >= 100 ? ms.toFixed(0) + " ms" : ms.toFixed(1) + " ms");
const fmtCost = (v: number | null): string => (v === null ? "" : v >= 1e6 ? v.toExponential(2) : v.toFixed(2));

function sw(label: string, on: boolean, disabled: boolean, title: string, toggle: () => void): HTMLElement {
  const b = h("button", { class: "sw sm" + (on ? " on" : ""), type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, disabled }, "");
  const wrap = h("label", { class: "pv-switch" + (disabled ? " off" : ""), title }, b, label);
  b.addEventListener("click", () => {
    if (!disabled) toggle();
  });
  return wrap;
}

/** The plan view element. */
export function renderPlanView(plan: Plan, o: PlanViewOptions): HTMLElement {
  let view: "tree" | "raw" = "tree";
  let sel = plan.slowest >= 0 ? plan.slowest : 0;
  const root = h("div", { class: "pv" });

  if (plan.analyze || o.analyze) {
    const text = o.write
      ? ` to measure it. This ${o.kind} ran inside BEGIN … ROLLBACK, so its changes were rolled back (triggers still fired, locks were taken while it ran).`
      : ` to measure it. This one is a ${o.kind || "SELECT"}, so it only reads. For UPDATE / DELETE / INSERT DataTrip asks first and runs it inside BEGIN … ROLLBACK (triggers still fire, locks are still taken).`;
    root.append(h("div", { class: "pv-warn", role: "note" }, h("span", { class: "pv-warn-ic", "aria-hidden": "true" }, "!"), h("span", null, h("b", null, "ANALYZE executes the statement"), text)));
  }

  const info: string[] = [];
  if (plan.analyze) {
    info.push(plan.format === "pg-json" ? `EXPLAIN ANALYZE${o.buffers ? ", BUFFERS" : ""}` : "EXPLAIN ANALYZE");
    if (plan.executionMs !== null) info.push(`${fmtMs(plan.executionMs)} execution`);
    if (plan.planningMs !== null) info.push(`${fmtMs(plan.planningMs)} planning`);
  } else {
    info.push(plan.format === "sqlite" ? "EXPLAIN QUERY PLAN" : plan.format === "mssql-xml" ? "Estimated plan (SHOWPLAN_XML)" : "EXPLAIN · estimates only, not executed");
    if (plan.planningMs !== null) info.push(`${fmtMs(plan.planningMs)} planning`);
  }
  info.push(o.at);

  const body = h("div", { class: "pv-body" });
  const seg = h("div", { class: "seg pv-seg", role: "radiogroup", "aria-label": "Plan view" });
  const segBtn = (v: "tree" | "raw", label: string): HTMLButtonElement =>
    h("button", {
      class: "seg-btn",
      type: "button",
      role: "radio",
      onclick: () => {
        view = v;
        render();
      },
    }, label);
  const bTree = segBtn("tree", "Tree");
  const bRaw = segBtn("raw", "Raw");
  seg.append(bTree, bRaw);
  const copyBtn = h("button", { class: "btn sm pv-copy", type: "button" }, "Copy plan");
  copyBtn.addEventListener("click", () => {
    void copyText(plan.raw).then(() => {
      copyBtn.textContent = "Copied ✓";
      window.setTimeout(() => (copyBtn.textContent = "Copy plan"), 1500);
    });
  });
  const anTitle = o.analyzeSupported ? "Run the statement to measure real row counts and timings" : "This data source has no EXPLAIN ANALYZE (MySQL needs 8.0.18+)";
  root.append(
    h(
      "div",
      { class: "pv-head" },
      h("span", { class: "pv-pill" }, "Plan"),
      h("span", { class: "pv-info" }, info.join(" · ")),
      h("div", { class: "spacer" }),
      sw("ANALYZE", o.analyze && o.analyzeSupported, !o.analyzeSupported, anTitle, () => o.onToggle(!o.analyze, o.analyze ? false : o.buffers)),
      o.buffersSupported ? sw("BUFFERS", o.buffers && o.analyze, !o.analyze, o.analyze ? "Add shared / temp block I/O per node" : "Needs ANALYZE", () => o.onToggle(o.analyze, !o.buffers)) : null,
      seg,
      copyBtn,
    ),
  );

  if (plan.hint) {
    const hint = plan.hint;
    const idx = hint.createIndex
      ? h("button", { class: "btn sm pv-idx", type: "button", title: hint.createIndex }, "Copy CREATE INDEX")
      : null;
    idx?.addEventListener("click", () => {
      void copyText(hint.createIndex as string).then(() => {
        idx.textContent = "Copied ✓";
        toast("CREATE INDEX copied — review it before running it", "ok");
      });
    });
    root.append(h("div", { class: "pv-hint" }, h("span", { class: "pv-hint-ic", "aria-hidden": "true" }, "i"), h("span", { class: "pv-hint-text" }, hint.text), idx));
  }
  root.append(body);

  const hasTime = plan.analyze && plan.nodes.some((n) => n.selfMs !== null);
  const hasNumbers = plan.share.length > 0;

  function detailOf(n: PlanNode): { stats: string; lines: string } {
    const st: string[] = [];
    if (n.estRows !== null) st.push(`est ${fmtRows(n.estRows)} rows`);
    if (n.actRows !== null) st.push(`actual ${fmtRows(n.actRows)}`);
    if (n.selfMs !== null) st.push(`self ${fmtMs(n.selfMs)}`);
    if (n.totalMs !== null) st.push(`total ${fmtMs(n.totalMs)}`);
    if (n.loops !== null) st.push(`loops ${n.loops}`);
    if (n.totalCost !== null) st.push(`cost ${n.startupCost !== null ? fmtCost(n.startupCost) + ".." : ""}${fmtCost(n.totalCost)}`);
    const lines = [...n.extras, ...(n.buffers ? [n.buffers] : [])].join("   ");
    return { stats: st.join(" · "), lines: lines || "No extra details" };
  }

  function renderTree(): HTMLElement {
    const grid = h("div", { class: "pv-tree", role: "tree", "aria-label": "Plan nodes" });
    grid.append(
      h(
        "div",
        { class: "pv-row pv-th" },
        h("span", null, "Node"),
        h("span", null, "Rows est → actual"),
        h("span", null, hasTime ? "Self time" : "Share of cost"),
        h("span", null, "Cost"),
      ),
    );
    plan.nodes.forEach((n, i) => {
      const share = plan.share[i] ?? 0;
      const ratio = misestimate(n);
      const off = ratio !== null && ratio >= 10 ? `×${Math.round(ratio)} ${(n.actRows ?? 0) > (n.estRows ?? 0) ? "under" : "over"}` : "";
      const slow = i === plan.slowest && hasNumbers;
      const bar = h("span", { class: "pv-bar" }, h("span", { class: "pv-fill" + (slow ? " slow" : share > 0.02 ? " warm" : ""), style: `width:${Math.max(1.5, share * 100).toFixed(1)}%` }));
      const t = hasTime ? (n.selfMs !== null ? fmtMs(n.selfMs) : "") : hasNumbers ? (share * 100).toFixed(1) + "%" : "";
      const row = h(
        "button",
        {
          class: "pv-row pv-node" + (slow ? " slow" : "") + (i === sel ? " on" : ""),
          type: "button",
          role: "treeitem",
          "aria-level": String(n.depth + 1),
          "aria-selected": String(i === sel),
          onclick: () => {
            sel = i;
            render();
          },
        },
        h(
          "span",
          { class: "pv-name" },
          h("span", { class: "pv-indent", style: `width:${n.depth * 16}px` }),
          n.depth ? h("span", { class: "pv-arrow", "aria-hidden": "true" }, "└") : null,
          h(
            "span",
            { class: "pv-name-col" },
            h("span", { class: "pv-name-line" }, h("span", { class: "pv-name-text" }, n.name), slow ? h("span", { class: "pv-slow" }, hasTime ? `slowest · ${Math.round(share * 100)}%` : "most expensive") : null),
            n.detail ? h("span", { class: "pv-det mono", title: n.detail }, n.detail) : null,
          ),
        ),
        h("span", { class: "pv-rows mono" }, h("span", { class: "pv-est" }, fmtRows(n.estRows)), h("span", { class: "pv-to" }, "→"), h("span", { class: "pv-act" }, plan.analyze ? fmtRows(n.actRows) : "—"), off ? h("span", { class: "pv-off", title: "Estimate vs actual rows differ a lot — statistics may be stale (ANALYZE the table)" }, off) : null),
        h("span", { class: "pv-time" }, hasNumbers ? bar : null, h("span", { class: "pv-t mono" + (slow ? " slow" : "") }, t)),
        h("span", { class: "pv-cost mono" }, n.totalCost !== null ? (n.startupCost !== null ? `${fmtCost(n.startupCost)}..${fmtCost(n.totalCost)}` : fmtCost(n.totalCost)) : ""),
      );
      grid.append(row);
    });
    const n = plan.nodes[sel];
    const d = n ? detailOf(n) : { stats: "", lines: "" };
    const foot = h(
      "div",
      { class: "pv-sel" },
      h("div", { class: "pv-sel-head" }, h("b", null, n?.name ?? ""), h("span", { class: "pv-sel-stats" }, d.stats)),
      h("div", { class: "pv-sel-lines mono", title: d.lines }, d.lines),
    );
    return h("div", { class: "pv-treewrap" }, h("div", { class: "pv-scroll" }, grid), foot);
  }

  function render(): void {
    body.replaceChildren(view === "tree" ? renderTree() : h("pre", { class: "pv-raw mono" }, plan.raw));
    bTree.classList.toggle("on", view === "tree");
    bRaw.classList.toggle("on", view === "raw");
    bTree.setAttribute("aria-checked", String(view === "tree"));
    bRaw.setAttribute("aria-checked", String(view === "raw"));
  }
  render();
  return root;
}
