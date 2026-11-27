// Settings › Snippets (v0.16, board W): the snippet list and the editor of the selected one (abbreviation,
// description, body with placeholder chips, dialects), Expand with Tab / Enter / Space, Show in completion.
import { h } from "./dom";
import { getSettings, updateSettings } from "./settings";
import { BUILTIN_SNIPPETS, DIALECT_SHORT, SNIPPET_DIALECTS, dialectLabel, effectiveSnippets, snippetPreview, validAbbr } from "./snippets";
import type { ExpandKey, Snippet, SnippetDialect } from "./snippets";
import "../styles/ops.css";

export interface SnippetSettingsHost {
  row(title: string, desc: string, control: HTMLElement, extra?: string): { el: HTMLElement; text: string };
  toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement;
  onSync(f: () => void): void;
}

const PLACEHOLDERS: [string, string][] = [
  ["$CURSOR", "where the caret lands"],
  ["$TABLE", "a table placeholder, completed with table names"],
  ["$COLUMN", "a column placeholder, completed with column names"],
  ["$SELECTION", "the text you selected before typing the abbreviation"],
  ["$DATE", "today’s date"],
];

export function buildSnippetSettings(host: SnippetSettingsHost): { el: HTMLElement; text: string }[] {
  let sel = getSettings().snippets.user[0]?.abbr ?? BUILTIN_SNIPPETS[0].abbr;
  let shownAbbr = "";
  const list = h("div", { class: "sn-list", role: "listbox", "aria-label": "Snippets" });
  const inAbbr = h("input", { class: "st-input mono sn-abbr", type: "text", spellcheck: false, "aria-label": "Abbreviation", maxlength: 32 });
  const inName = h("input", { class: "st-input", type: "text", spellcheck: false, "aria-label": "Description" });
  const inBody = h("textarea", { class: "sn-body mono", spellcheck: false, "aria-label": "Snippet body", rows: 4 });
  const abbrErr = h("div", { class: "sn-err", hidden: true });
  const dialBtns = SNIPPET_DIALECTS.map((d) => h("button", { class: "sn-dial", type: "button", role: "checkbox" }, h("span", { class: "sn-box", "aria-hidden": "true" }), DIALECT_SHORT[d]));
  const delBtn = h("button", { class: "st-link sn-del", type: "button" });
  const resetHidden = h("button", { class: "st-link", type: "button" }, "Restore built-in snippets");

  const current = (): (Snippet & { builtin: boolean; edited: boolean }) | undefined => effectiveSnippets(getSettings().snippets).find((s) => s.abbr === sel);

  /** Writes a change of the selected snippet (a built-in's edit becomes a user copy with its abbreviation). */
  const write = (patch: Partial<Snippet>): void => {
    const abbr = sel;
    updateSettings((s) => {
      const eff = effectiveSnippets(s.snippets).find((x) => x.abbr === abbr);
      if (!eff) return;
      const next: Snippet = { abbr: eff.abbr, name: eff.name, body: eff.body, dialects: [...eff.dialects], ...patch };
      const i = s.snippets.user.findIndex((u) => u.abbr === abbr);
      if (patch.abbr !== undefined && patch.abbr !== abbr) {
        if (BUILTIN_SNIPPETS.some((b) => b.abbr === abbr) && !s.snippets.hidden.includes(abbr)) s.snippets.hidden.push(abbr);
        if (i >= 0) s.snippets.user.splice(i, 1);
        s.snippets.user.push(next);
      } else if (i >= 0) s.snippets.user[i] = next;
      else s.snippets.user.push(next);
    });
    if (patch.abbr !== undefined) sel = patch.abbr;
  };

  inAbbr.addEventListener("input", () => {
    const v = inAbbr.value.trim();
    const taken = v !== sel && effectiveSnippets(getSettings().snippets).some((s) => s.abbr === v);
    const msg = !validAbbr(v) ? "Letters, digits and _ only (start with a letter)" : taken ? `“${v}” is already used` : "";
    abbrErr.textContent = msg;
    abbrErr.hidden = !msg;
    if (!msg) {
      write({ abbr: v });
      shownAbbr = v;
    }
  });
  inName.addEventListener("input", () => write({ name: inName.value }));
  inBody.addEventListener("input", () => write({ body: inBody.value }));
  dialBtns.forEach((b, i) =>
    b.addEventListener("click", () => {
      const cur = current();
      if (!cur) return;
      const d = SNIPPET_DIALECTS[i];
      write({ dialects: cur.dialects.includes(d) ? cur.dialects.filter((x) => x !== d) : [...cur.dialects, d] });
    }),
  );
  delBtn.addEventListener("click", () => {
    const cur = current();
    if (!cur) return;
    updateSettings((s) => {
      const i = s.snippets.user.findIndex((u) => u.abbr === cur.abbr);
      if (i >= 0) s.snippets.user.splice(i, 1);
      // an unedited built-in is hidden; an edited one goes back to its built-in text
      if (cur.builtin && !cur.edited && !s.snippets.hidden.includes(cur.abbr)) s.snippets.hidden.push(cur.abbr);
    });
    if (!current()) sel = effectiveSnippets(getSettings().snippets)[0]?.abbr ?? "";
    shownAbbr = "";
  });
  resetHidden.addEventListener("click", () => updateSettings((s) => (s.snippets.hidden = [])));

  const addBtn = h("button", { class: "st-pill sn-add", type: "button" }, "+ Add snippet");
  addBtn.addEventListener("click", () => {
    const taken = new Set(effectiveSnippets(getSettings().snippets).map((s) => s.abbr));
    let n = 1;
    while (taken.has("new" + n)) n++;
    const abbr = "new" + n;
    updateSettings((s) => s.snippets.user.push({ abbr, name: "New snippet", body: "SELECT $CURSOR", dialects: [...SNIPPET_DIALECTS] }));
    sel = abbr;
    shownAbbr = "";
    window.setTimeout(() => inAbbr.focus(), 0);
  });

  const chips = PLACEHOLDERS.map(([p, tip]) => {
    const b = h("button", { class: "sn-ph mono", type: "button", title: tip }, p);
    b.addEventListener("click", () => {
      const a = inBody.selectionStart ?? inBody.value.length;
      const z = inBody.selectionEnd ?? a;
      const v = inBody.value;
      const pad = a > 0 && !/\s$/.test(v.slice(0, a)) && p !== "$CURSOR" ? " " : "";
      inBody.value = v.slice(0, a) + pad + p + v.slice(z);
      inBody.selectionStart = inBody.selectionEnd = a + pad.length + p.length;
      inBody.focus();
      write({ body: inBody.value });
    });
    return b;
  });

  const expand = h(
    "div",
    { class: "seg st-seg", role: "radiogroup", "aria-label": "Expand with" },
    (["tab", "enter", "space"] as ExpandKey[]).map((k) => {
      const b = h("button", { class: "seg-btn", type: "button", role: "radio", onclick: () => updateSettings((s) => (s.snippets.expandKey = k)) }, k === "tab" ? "Tab" : k === "enter" ? "Enter" : "Space");
      host.onSync(() => {
        b.classList.toggle("on", getSettings().snippets.expandKey === k);
        b.setAttribute("aria-checked", String(getSettings().snippets.expandKey === k));
      });
      return b;
    }),
  );

  const editor = h(
    "div",
    { class: "sn-editor" },
    h("div", { class: "sn-line" }, h("label", { class: "sn-field sn-f-abbr" }, h("span", null, "Abbreviation"), inAbbr), h("label", { class: "sn-field sn-f-name" }, h("span", null, "Description"), inName)),
    abbrErr,
    h("label", { class: "sn-field" }, h("span", null, "Body"), inBody),
    h("div", { class: "sn-phs" }, h("span", { class: "sn-k" }, "Insert"), chips),
    h("div", { class: "sn-help" }, "$CURSOR — where the caret lands · $TABLE / $COLUMN — placeholders you fill in with completion, Tab jumps to the next · $SELECTION — the selected text · $DATE — today"),
    h("div", { class: "sn-dials" }, h("span", { class: "sn-k" }, "Applies to"), dialBtns, h("div", { class: "spacer" }), delBtn),
  );

  const renderList = (): void => {
    const all = effectiveSnippets(getSettings().snippets);
    if (!all.some((s) => s.abbr === sel)) sel = all[0]?.abbr ?? "";
    list.replaceChildren(
      ...all.map((s) =>
        h(
          "button",
          {
            class: "sn-item" + (s.abbr === sel ? " on" : ""),
            type: "button",
            role: "option",
            "aria-selected": String(s.abbr === sel),
            onclick: () => {
              sel = s.abbr;
              shownAbbr = "";
              abbrErr.hidden = true;
              sync();
            },
          },
          h("span", { class: "sn-i-abbr mono" }, s.abbr),
          h("span", { class: "sn-i-name" }, s.name + (s.edited ? " · edited" : s.builtin ? "" : "")),
          h("span", { class: "sn-i-body mono" }, snippetPreview(s.body)),
          h("span", { class: "sn-i-dial" }, dialectLabel(s.dialects)),
        ),
      ),
    );
    resetHidden.hidden = getSettings().snippets.hidden.length === 0;
  };

  const sync = (): void => {
    renderList();
    const cur = current();
    editor.hidden = !cur;
    if (!cur) return;
    // don't overwrite what is being typed
    if (shownAbbr !== cur.abbr) {
      inAbbr.value = cur.abbr;
      inName.value = cur.name;
      inBody.value = cur.body;
      shownAbbr = cur.abbr;
    } else {
      if (document.activeElement !== inName) inName.value = cur.name;
      if (document.activeElement !== inBody) inBody.value = cur.body;
    }
    dialBtns.forEach((b, i) => {
      const on = cur.dialects.includes(SNIPPET_DIALECTS[i] as SnippetDialect);
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
    delBtn.textContent = cur.builtin ? (cur.edited ? "Reset to built-in" : "Hide this snippet") : "Delete snippet";
  };
  host.onSync(sync);

  const listBlock = h("div", { class: "sn-block" }, h("div", { class: "sn-top" }, h("span", { class: "sn-k" }, "Type an abbreviation in a console and press the expand key; snippets also show up in completion."), h("div", { class: "spacer" }), resetHidden, addBtn), list, editor);
  return [
    { el: listBlock, text: "snippets abbreviation body placeholder cursor table column selection date template live templates" },
    host.row("Expand with", "The key that turns an abbreviation into its snippet (only while completion isn't open).", expand, "tab enter space"),
    host.row("Show in completion", "Offer snippets next to keywords and tables in the completion list.", host.toggle("Show in completion", () => getSettings().snippets.inCompletion, (v) => updateSettings((s) => (s.snippets.inCompletion = v))), "autocomplete"),
  ];
}
