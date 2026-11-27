// Help (v0.15, board S): the help center (F1 / ? in the sidebar / Help menu / ⌘K) with search, topics and
// articles; compact article popovers for errors ("What does this mean?") and the small ? hints next to tricky
// dialog fields. Content: src/help/articles.ts, rendered by a tiny Markdown-subset renderer that only builds DOM
// nodes (never innerHTML of text).
import { ARTICLES, ERROR_HELP, TOPICS } from "../help/articles";
import type { HelpArticle, HelpTopic, TopicId } from "../help/articles";
import { clear, copyText, h, icon } from "./dom";
import { ACTIONS, bindingOf, formatBinding, shortcutLabel } from "./keymap";
import type { ActionId } from "./keymap";
import { toast } from "./toast";
import "../styles/help.css";

/** What "Try it" buttons need from the shell. */
export interface HelpHost {
  runCommand(id: string): void;
  /** Opens a new console on the current data source with `sql` (none → asks to add a connection). */
  newConsoleWith(sql: string): void;
}

let host: HelpHost | null = null;

export function initHelp(h0: HelpHost): void {
  host = h0;
}

const IS_MAC = /Mac/.test(navigator.userAgent);
const byId = new Map(ARTICLES.map((a) => [a.id, a]));
const topicOf = (id: TopicId): HelpTopic => TOPICS.find((t) => t.id === id) ?? TOPICS[0];

export function article(id: string): HelpArticle | undefined {
  return byId.get(id);
}

// ---------------------------------------------------------------- rendering

const SQL_KW =
  /^(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AND|OR|ORDER|BY|GROUP|LIMIT|OFFSET|AS|COUNT|SUM|AVG|MIN|MAX|DESC|ASC|INSERT|INTO|VALUES|UPDATE|SET|DELETE|WITH|IN|NOT|NULL|IS|HAVING|DISTINCT|CREATE|TABLE|VIEW|INDEX|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|CASE|WHEN|THEN|ELSE|END|UNION|ALL|EXISTS|BETWEEN|LIKE|FETCH|NEXT|ROWS|ONLY|TOP|PRIMARY|KEY|REFERENCES)$/i;

/** One line of SQL as colored spans (comments, strings, numbers, keywords). */
function sqlLine(line: string): HTMLElement {
  const out = h("div", { class: "hc-code-line" });
  const re = /(--.*$)|('(?:[^']|'')*'?)|("(?:[^"])*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const t = m[0];
    let cls = "";
    if (m[1]) cls = "hl-c";
    else if (m[2]) cls = "hl-s";
    else if (m[4]) cls = "hl-n";
    else if (m[5] && SQL_KW.test(m[5])) cls = "hl-k";
    else if (m[7]) cls = "hl-p";
    out.appendChild(cls ? h("span", { class: cls }, t) : document.createTextNode(t));
  }
  if (!line) out.appendChild(document.createTextNode("​"));
  return out;
}

function keyLabel(id: string): string {
  if (!ACTIONS.some((a) => a.id === id)) return id;
  return shortcutLabel(id as ActionId) || "(no shortcut)";
}

/** Inline Markdown: `code`, **bold**, [text](#id), {key:action}, {bind:Mod-S}, {modkey}. */
function inline(text: string, nav: (id: string) => void): Node[] {
  const out: Node[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(#[a-z0-9-]+\))|(\{key:[A-Za-z]+\})|(\{bind:[A-Za-z0-9-]+\})|(\{modkey\})/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (m[1]) out.push(h("code", null, t.slice(1, -1)));
    else if (m[2]) out.push(h("b", null, t.slice(2, -2)));
    else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(#([a-z0-9-]+)\)$/.exec(t);
      const id = lm ? lm[2] : "";
      out.push(h("button", { class: "hc-link", type: "button", onclick: () => nav(id) }, lm ? lm[1] : t));
    } else if (m[4]) out.push(h("kbd", null, keyLabel(t.slice(5, -1))));
    else if (m[5]) out.push(h("kbd", null, formatBinding(t.slice(6, -1))));
    else if (m[6]) out.push(document.createTextNode(IS_MAC ? "⌘" : "Ctrl"));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** The generated "Keyboard shortcuts" list (current bindings). */
function shortcutsBlock(): HTMLElement {
  const rows: [string, string][] = ACTIONS.map((a) => [a.name, bindingOf(a.id) ? shortcutLabel(a.id) : "—"]);
  rows.push(["Query history", formatBinding("Mod-Shift-H")], ["Submit grid edits (grid focused)", formatBinding("Mod-S")], ["Export result (grid focused)", formatBinding("Mod-Shift-E")], ["Accept / reject an AI suggestion", "Tab / Esc"]);
  return h(
    "div",
    { class: "hc-keys", role: "table", "aria-label": "Keyboard shortcuts" },
    rows.map(([name, key]) => h("div", { class: "hc-key-row", role: "row" }, h("span", { role: "cell" }, name), h("span", { role: "cell" }, key === "—" ? h("span", { class: "hc-unbound" }, "not set") : h("kbd", null, key)))),
  );
}

/** Block Markdown → DOM. Returns the nodes and the first code block's text (Copy example). */
function renderBody(src: string, nav: (id: string) => void): { nodes: HTMLElement[]; code: string | null } {
  const nodes: HTMLElement[] = [];
  let firstCode: string | null = null;
  if (src.trim() === "{shortcuts}") return { nodes: [shortcutsBlock()], code: null };
  const lines = src.split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) nodes.push(h("p", null, inline(para.join(" "), nav)));
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith("```")) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      if (firstCode === null) firstCode = code.join("\n");
      nodes.push(h("div", { class: "hc-code mono" }, code.map(sqlLine)));
      continue;
    }
    if (!t) {
      flush();
      i++;
      continue;
    }
    if (t.startsWith("## ") || t.startsWith("### ")) {
      flush();
      nodes.push(h(t.startsWith("### ") ? "h4" : "h3", null, inline(t.replace(/^#+\s*/, ""), nav)));
      i++;
      continue;
    }
    if (t.startsWith("> ")) {
      flush();
      nodes.push(h("div", { class: "hc-tip" }, inline(t.slice(2), nav)));
      i++;
      continue;
    }
    if (/^- /.test(t)) {
      flush();
      const items: HTMLElement[] = [];
      while (i < lines.length && /^- /.test(lines[i].trim())) items.push(h("li", null, inline(lines[i++].trim().slice(2), nav)));
      nodes.push(h("ul", null, items));
      continue;
    }
    if (/^\d+\. /.test(t)) {
      flush();
      const steps: HTMLElement[] = [];
      let n = 0;
      while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
        n++;
        const text = lines[i++].trim().replace(/^\d+\.\s+/, "");
        steps.push(h("div", { class: "hc-step" }, h("span", { class: "hc-step-n", "aria-hidden": "true" }, String(n)), h("div", null, inline(text, nav))));
        // A list directly under a step belongs to it.
        if (i < lines.length && /^- /.test(lines[i].trim())) {
          const sub: HTMLElement[] = [];
          while (i < lines.length && /^- /.test(lines[i].trim())) sub.push(h("li", null, inline(lines[i++].trim().slice(2), nav)));
          steps.push(h("ul", { class: "hc-step-sub" }, sub));
        }
      }
      nodes.push(h("div", { class: "hc-steps" }, steps));
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  return { nodes, code: firstCode };
}

/** Plain text of an article for search (Markdown marks and placeholders dropped). */
function plain(a: HelpArticle): string {
  return `${a.title} ${a.lead} ${a.body} ${a.keywords ?? ""} ${topicOf(a.topic).name}`
    .replace(/\{key:([A-Za-z]+)\}/g, (_m, id: string) => ACTIONS.find((x) => x.id === id)?.name ?? "")
    .replace(/[`*#>{}[\]()]/g, " ")
    .toLowerCase();
}

const searchText = new Map<string, string>();

/** Articles matching every word of `q` (title hits first). */
export function searchHelp(q: string): HelpArticle[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { a: HelpArticle; s: number }[] = [];
  for (const a of ARTICLES) {
    let text = searchText.get(a.id);
    if (text === undefined) {
      text = plain(a);
      searchText.set(a.id, text);
    }
    if (!words.every((w) => text.includes(w))) continue;
    const title = a.title.toLowerCase();
    let s = 0;
    for (const w of words) {
      if (title.includes(w)) s += 10;
      if ((a.keywords ?? "").includes(w)) s += 4;
      if (a.lead.toLowerCase().includes(w)) s += 2;
    }
    scored.push({ a, s });
  }
  return scored.sort((x, y) => y.s - x.s).map((x) => x.a);
}

function runTry(a: HelpArticle, close: () => void): void {
  const t = a.tryIt;
  if (!t || !host) return;
  close();
  if (t.sql) host.newConsoleWith(t.sql);
  else if (t.command) host.runCommand(t.command);
}

// ---------------------------------------------------------------- help center

interface Center {
  overlay: HTMLElement;
  show(id: string): void;
}

let center: Center | null = null;

export function isHelpOpen(): boolean {
  return center !== null;
}

/** F1 / ? / Help menu: opens the help center (on `id`, else the last article / Getting started). */
export function openHelp(id?: string): void {
  if (center) {
    if (id) center.show(id);
    return;
  }
  let current = id && byId.has(id) ? id : lastArticle;
  const overlay = h("div", { class: "overlay help-overlay" });
  const search = h("input", { class: "hc-search-in", type: "search", placeholder: "Search help", "aria-label": "Search help", spellcheck: false, autocomplete: "off" });
  const list = h("div", { class: "hc-list", role: "navigation", "aria-label": "Help topics" });
  const art = h("article", { class: "hc-article", "aria-live": "polite" });
  const close = (): void => {
    window.removeEventListener("keydown", onKey, true);
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 160);
    center = null;
  };
  const onKey = (e: KeyboardEvent): void => {
    const open = document.querySelectorAll(".overlay:not(.leaving)");
    if (open[open.length - 1] !== overlay) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (search.value && document.activeElement === search) {
        search.value = "";
        renderList();
      } else close();
    } else if (e.key === "F1") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      search.focus();
      search.select();
    }
  };
  const show = (id: string): void => {
    if (!byId.has(id)) return;
    current = id;
    lastArticle = id;
    renderList();
    renderArticle();
    art.scrollTop = 0;
  };
  const renderList = (): void => {
    clear(list);
    const q = search.value.trim();
    if (q) {
      const hits = searchHelp(q);
      if (!hits.length) list.appendChild(h("div", { class: "hc-none" }, "Nothing found. Try other words — or the command palette (", h("kbd", null, shortcutLabel("commandPalette") || "⌘K"), ") for actions."));
      for (const a of hits) {
        const tp = topicOf(a.topic);
        list.appendChild(
          h(
            "button",
            { class: "hc-topic hc-hit" + (a.id === current ? " on" : ""), type: "button", onclick: () => show(a.id) },
            h("span", { class: "hc-glyph", style: `color:${tp.color}`, "aria-hidden": "true" }, tp.glyph),
            h("span", { class: "hc-hit-text" }, h("span", { class: "hc-hit-title" }, a.title), h("span", { class: "hc-hit-topic" }, tp.name)),
          ),
        );
      }
      return;
    }
    const cur = byId.get(current);
    for (const tp of TOPICS) {
      const arts = ARTICLES.filter((a) => a.topic === tp.id);
      if (!arts.length) continue;
      const on = cur?.topic === tp.id;
      list.appendChild(
        h(
          "button",
          { class: "hc-topic" + (on ? " on" : ""), type: "button", "aria-expanded": arts.length > 1 ? String(on) : undefined, onclick: () => show(on && cur ? cur.id : arts[0].id) },
          h("span", { class: "hc-glyph", style: `color:${tp.color}`, "aria-hidden": "true" }, tp.glyph),
          h("span", null, tp.name),
        ),
      );
      if (on && arts.length > 1) {
        for (const a of arts) list.appendChild(h("button", { class: "hc-sub" + (a.id === current ? " on" : ""), type: "button", onclick: () => show(a.id) }, a.title));
      }
    }
  };
  const renderArticle = (): void => {
    clear(art);
    const a = byId.get(current);
    if (!a) return;
    const tp = topicOf(a.topic);
    const body = renderBody(a.body, show);
    const actions: HTMLElement[] = [];
    if (a.tryIt) actions.push(h("button", { class: "btn primary", type: "button", onclick: () => runTry(a, close) }, a.tryIt.label));
    if (body.code !== null) {
      const code = body.code;
      actions.push(h("button", { class: "btn", type: "button", onclick: () => void copyText(code).then(() => toast("Example copied", "ok", 1600)) }, icon("copy", 14), "Copy example"));
    }
    const related = (a.related ?? []).map((id) => byId.get(id)).filter((x): x is HelpArticle => x !== undefined);
    art.append(
      h("div", { class: "hc-crumb" }, a.topic === "start" ? "Help" : `Help › ${tp.name}`),
      h("h2", { class: "hc-title" }, a.title),
      h("p", { class: "hc-lead" }, a.lead),
      ...body.nodes,
    );
    if (actions.length) art.appendChild(h("div", { class: "hc-actions" }, actions));
    if (related.length) art.appendChild(h("div", { class: "hc-related" }, "Related: ", related.map((r) => h("button", { class: "hc-link", type: "button", onclick: () => show(r.id) }, r.title))));
  };
  search.addEventListener("input", () => renderList());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = searchHelp(search.value.trim())[0];
      if (first) show(first.id);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list.querySelector<HTMLButtonElement>("button")?.focus();
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const btns = Array.from(list.querySelectorAll<HTMLButtonElement>("button"));
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && i === 0) search.focus();
    else btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  });
  overlay.appendChild(
    h(
      "div",
      { class: "dialog help-center", role: "dialog", "aria-modal": "true", "aria-label": "Help" },
      h(
        "nav",
        { class: "hc-nav" },
        h("label", { class: "hc-search" }, icon("search", 12), search),
        list,
        h("div", { class: "hc-foot" }, h("button", { class: "hc-link", type: "button", onclick: () => (close(), host?.runCommand("welcomeTour")) }, "Welcome tour"), h("span", { class: "hc-offline" }, "Works offline")),
      ),
      h("div", { class: "hc-main" }, h("button", { class: "icon-btn hc-close", type: "button", title: "Close (Esc)", "aria-label": "Close help", onclick: close }, icon("x", 14)), art),
    ),
  );
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  center = { overlay, show };
  show(current);
  search.focus();
}

let lastArticle = "start";

// ---------------------------------------------------------------- popovers, hints, errors

let pop: { el: HTMLElement; cleanup: () => void } | null = null;

export function closeHelpPopover(): void {
  const p = pop;
  pop = null;
  p?.cleanup();
  p?.el.remove();
}

/** A compact article next to `anchor` (errors, ? hints) with "Open the full article". */
export function openHelpPopover(anchor: HTMLElement, id: string, tip?: string): void {
  const a = byId.get(id);
  if (!a) return;
  closeHelpPopover();
  const tp = topicOf(a.topic);
  const body = renderBody(a.body, (rid) => {
    closeHelpPopover();
    openHelp(rid);
  });
  const el = h(
    "div",
    { class: "help-pop", role: "dialog", "aria-label": a.title },
    h("div", { class: "hp-crumb" }, `Help › ${tp.name}`),
    tip ? h("div", { class: "hp-tip" }, tip) : null,
    h("div", { class: "hp-title" }, a.title),
    h("div", { class: "hp-lead" }, a.lead),
    h("div", { class: "hp-body" }, body.nodes),
    h(
      "div",
      { class: "hp-foot" },
      h(
        "button",
        {
          class: "hc-link",
          type: "button",
          onclick: () => {
            closeHelpPopover();
            openHelp(id);
          },
        },
        "Open the full article ↗",
      ),
      a.related?.length ? h("span", { class: "hp-rel" }, " · Related: " + a.related.map((r) => byId.get(r)?.title ?? "").filter(Boolean).slice(0, 2).join(", ")) : null,
    ),
  );
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  const below = r.bottom + 8 + pr.height < window.innerHeight - 8;
  const top = below ? r.bottom + 8 : Math.max(8, r.top - 8 - pr.height);
  el.style.top = Math.max(8, top) + "px";
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 12)) + "px";
  const away = (e: Event): void => {
    if (e.target instanceof Node && (el.contains(e.target) || anchor.contains(e.target))) return;
    closeHelpPopover();
  };
  const keys = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeHelpPopover();
    }
  };
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", keys, true);
  pop = {
    el,
    cleanup: () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", keys, true);
    },
  };
}

/** The troubleshooting article for an error message, or null. */
export function helpForError(msg: string, ctx: { vault?: boolean } = {}): string | null {
  for (const m of ERROR_HELP) {
    if (m.vaultOnly && !ctx.vault) continue;
    if (m.re.test(msg)) return m.id;
  }
  return null;
}

/** "? What does this mean" for a known error (null when there is no article for it). */
export function errorHelpButton(msg: string, ctx: { vault?: boolean } = {}): HTMLButtonElement | null {
  const id = helpForError(msg, ctx);
  if (!id) return null;
  const b = h("button", { class: "btn sm help-err-btn", type: "button", title: "Open the matching help article" }, h("span", { class: "help-q", "aria-hidden": "true" }, "?"), "What does this mean?");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pop) closeHelpPopover();
    else openHelpPopover(b, id);
  });
  return b;
}

/** A small ? next to a dialog field label: one-line tooltip, click for the article. */
export function helpHint(id: string, tip: string): HTMLButtonElement {
  const b = h("button", { class: "help-hint", type: "button", title: tip, "aria-label": `Help: ${tip}`, tabindex: "-1" }, "?");
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openHelpPopover(b, id, tip);
  });
  return b;
}
