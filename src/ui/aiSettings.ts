// Settings › AI assistant (board N, "AI settings" scene): provider cards with live status, model / key / endpoint
// fields and the three privacy toggles. Built with the settings window's own row / toggle helpers.
import { api } from "../api";
import type { AiModel, AiModels, AiProviderId, AiProviderStatus } from "../types";
import { errMsg, h } from "./dom";
import { toast } from "./toast";
import { getSettings, updateSettings } from "./settings";
import { AI_PROVIDER_NAMES, loadProviders } from "./ai";

export interface SettingsItem {
  el: HTMLElement;
  /** Lower-case text the settings search matches against. */
  text: string;
}

/** The settings window's building blocks (see settingsDialog.ts). */
export interface SettingsKit {
  row(title: string, desc: string, control: HTMLElement, extra?: string): SettingsItem;
  toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement;
  textField(label: string, get: () => string, set: (v: string) => void, mono: boolean, width: number): HTMLInputElement;
  /** Registers a callback run whenever settings change (and on first render). */
  onSync(f: () => void): void;
}

const ORDER: AiProviderId[] = ["codex", "claude", "opencode", "openai", "ollama"];

const SUBS: Record<AiProviderId, string> = {
  codex: "Detected on your PATH · uses your ChatGPT sign-in, no API key",
  claude: "Uses the claude command and your Claude sign-in if installed",
  opencode: "Uses the opencode command with any provider you signed in to (opencode auth login)",
  openai: "OpenAI-compatible endpoint + key, stored in the keychain",
  ollama: "Runs on this computer; nothing leaves your machine",
};

function statusOf(p: AiProviderStatus | undefined, id: AiProviderId): { text: string; cls: string } {
  if (!p) return { text: "Checking…", cls: "" };
  if (id === "codex") return p.available ? (p.signedIn ? { text: "● Signed in", cls: "ok" } : { text: "Not signed in", cls: "warn" }) : { text: "Not found", cls: "" };
  if (id === "claude") return p.available ? { text: "● Installed", cls: "ok" } : { text: "Not found", cls: "" };
  if (id === "opencode") return p.available ? (p.signedIn ? { text: "● Signed in", cls: "ok" } : { text: "Installed", cls: "warn" }) : { text: "Not found", cls: "" };
  if (id === "openai") return p.available ? { text: "● Key set", cls: "ok" } : { text: "Not set", cls: "" };
  return p.available ? { text: "● Running", cls: "ok" } : { text: "Not running", cls: "" };
}

export function buildAiSettings(kit: SettingsKit): SettingsItem[] {
  const S = getSettings;
  let status: AiProviderStatus[] | null = null;
  const cards = new Map<AiProviderId, { btn: HTMLButtonElement; st: HTMLElement; sub: HTMLElement }>();
  const recheck = h("button", { class: "st-link", type: "button", onclick: () => void refresh(true) }, "Check again");
  const grid = h("div", { class: "ai-cards", role: "radiogroup", "aria-label": "AI provider" });
  for (const id of ORDER) {
    const st = h("span", { class: "ai-card-st" });
    const sub = h("span", { class: "ai-card-sub" }, SUBS[id]);
    const btn = h(
      "button",
      { class: "ai-card", type: "button", role: "radio", onclick: () => updateSettings((s) => (s.ai.provider = id)) },
      h("span", { class: "ai-card-head" }, h("span", { class: "ai-card-name" }, AI_PROVIDER_NAMES[id]), h("span", { class: "spacer" }), st),
      sub,
    );
    cards.set(id, { btn, st, sub });
    grid.appendChild(btn);
  }
  const paint = (): void => {
    for (const id of ORDER) {
      const c = cards.get(id);
      if (!c) continue;
      const p = status?.find((x) => x.id === id);
      const on = S().ai.provider === id;
      c.btn.classList.toggle("on", on);
      c.btn.setAttribute("aria-checked", String(on));
      const s = statusOf(status ? p : undefined, id);
      c.st.textContent = status && !p ? "Unknown" : s.text;
      c.st.className = "ai-card-st " + s.cls;
      c.sub.textContent = p && (p.available || id === "codex" || id === "claude") ? p.detail : SUBS[id];
    }
    ollamaList();
  };
  const refresh = async (force: boolean): Promise<void> => {
    recheck.textContent = "Checking…";
    status = await loadProviders(force);
    recheck.textContent = "Check again";
    paint();
  };
  kit.onSync(paint);
  void refresh(true);

  const providers: SettingsItem = {
    el: h("div", { class: "st-row col ai-provider-row" }, h("div", { class: "ai-provhead" }, h("div", { class: "st-row-title" }, "Provider"), h("span", { class: "spacer" }), recheck), grid),
    text: "ai assistant provider codex chatgpt claude code opencode openai api key ollama local model",
  };

  // model (Codex / Claude Code / OpenCode / API): a searchable picker over the provider's catalog
  // (`ai_models`, v0.15) with "Default" and any typed custom value.
  const model = kit.textField("Model", () => S().ai.model, (v) => updateSettings((s) => (s.ai.model = v)), true, 240);
  const picker = modelPicker(model, () => {
    const p = S().ai.provider;
    return { provider: p, baseUrl: p === "openai" && S().ai.baseUrl ? S().ai.baseUrl : null };
  });
  kit.onSync(() => {
    const p = S().ai.provider;
    model.placeholder = p === "openai" ? "gpt-4o-mini" : "Default";
    picker.sync();
  });
  const modelRow = kit.row(
    "Model",
    "Pick from the provider’s models or type any id · empty = the provider’s default · OpenCode: provider/model",
    picker.el,
    "model gpt codex claude opencode sonnet opus haiku",
  );

  // API key (write-only)
  const keyInput = h("input", { class: "st-input mono", type: "password", spellcheck: false, autocomplete: "off", "aria-label": "API key", placeholder: "sk-…", style: "width:220px" });
  const saveKey = h("button", { class: "st-pill", type: "button" }, "Save");
  const clearKey = h("button", { class: "st-pill", type: "button" }, "Clear");
  saveKey.addEventListener("click", () => {
    const k = keyInput.value.trim();
    if (!k) {
      keyInput.focus();
      return;
    }
    void api
      .aiSetApiKey(k)
      .then(() => {
        keyInput.value = "";
        toast("API key saved in the keychain", "ok");
        return refresh(true);
      })
      .catch((e: unknown) => toast(`Couldn't save the key: ${errMsg(e)}`, "error"));
  });
  clearKey.addEventListener("click", () => {
    void api
      .aiSetApiKey(null)
      .then(() => {
        toast("API key removed", "ok");
        return refresh(true);
      })
      .catch((e: unknown) => toast(`Couldn't remove the key: ${errMsg(e)}`, "error"));
  });
  keyInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") saveKey.click();
  });
  const keyRow = kit.row("API key", "Stored in the system keychain; DataTrip never shows it again", h("div", { class: "st-ctl" }, keyInput, saveKey, clearKey), "openai key secret token");
  const base = kit.textField("Base URL", () => S().ai.baseUrl, (v) => updateSettings((s) => (s.ai.baseUrl = v)), true, 260);
  base.placeholder = "https://api.openai.com/v1";
  const baseRow = kit.row("Base URL", "Any OpenAI-compatible /chat/completions endpoint", base, "endpoint url openai compatible azure");

  // Ollama model
  const om = kit.textField("Ollama model", () => S().ai.ollamaModel, (v) => updateSettings((s) => (s.ai.ollamaModel = v)), true, 200);
  om.placeholder = "first installed model";
  const omList = h("span", { class: "ai-models" });
  const ollamaList = (): void => {
    const models = status?.find((x) => x.id === "ollama")?.models ?? [];
    omList.replaceChildren(
      ...models.slice(0, 8).map((m) => {
        const b = h("button", { class: "st-chipbtn", type: "button", onclick: () => updateSettings((s) => (s.ai.ollamaModel = m)) }, m);
        b.classList.toggle("on", S().ai.ollamaModel === m);
        return b;
      }),
    );
  };
  const omRow = kit.row("Ollama model", "A model you pulled with `ollama pull`", h("div", { class: "st-ctl ai-om" }, omList, om), "ollama llama local model");

  kit.onSync(() => {
    const p = S().ai.provider;
    // a class, not `hidden`: the settings search owns `hidden`
    modelRow.el.classList.toggle("ai-off", p === "ollama");
    keyRow.el.classList.toggle("ai-off", p !== "openai");
    baseRow.el.classList.toggle("ai-off", p !== "openai");
    omRow.el.classList.toggle("ai-off", p !== "ollama");
  });

  const auto = kit.row(
    "Pick tables from my question",
    "Sends only the tables your question is about (plus their foreign keys), not the whole database",
    kit.toggle("Pick tables from my question", () => S().ai.autoTables, (v) => updateSettings((s) => (s.ai.autoTables = v))),
    "schema context tables",
  );
  const samples = kit.row(
    "Include 20 sample rows",
    "Helps with values like status codes. Off by default; never for data sources marked read-only or Prod",
    kit.toggle("Include 20 sample rows", () => S().ai.samples, (v) => updateSettings((s) => (s.ai.samples = v))),
    "data privacy rows",
  );
  const block = kit.row(
    "Block AI for production data sources",
    "Prod-tagged data sources (read-only, or “prod” / “production” in the name or folder) get no AI help at all",
    kit.toggle("Block AI for production data sources", () => S().ai.blockProd, (v) => updateSettings((s) => (s.ai.blockProd = v))),
    "privacy production prod safety",
  );
  return [providers, modelRow, keyRow, baseRow, omRow, auto, samples, block];
}

// ---------------------------------------------------------------- model picker (v0.15)

interface ModelPicker {
  el: HTMLElement;
  /** Settings changed (provider / base URL): reload the catalog when it is another one. */
  sync(): void;
}

/** "anthropic/claude-sonnet-4-5" → "anthropic" (OpenCode groups); "" without a provider prefix. */
function groupOf(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(0, i) : "";
}

/**
 * Searchable model picker around the settings text field: typing filters the list (and any typed value is kept
 * as a custom model), "Default" clears it, ↻ reloads the catalog, the line below says where the list came from.
 */
function modelPicker(input: HTMLInputElement, target: () => { provider: AiProviderId; baseUrl: string | null }): ModelPicker {
  let key = "";
  let data: AiModels | null = null;
  let loading = false;
  let open = false;
  let filterText = "";
  let sel = -1;
  let items: { id: string; el: HTMLElement }[] = [];
  const list = h("div", { class: "ai-mp-list", role: "listbox", "aria-label": "Models", hidden: true });
  const caret = h("button", { class: "ai-mp-caret", type: "button", tabindex: "-1", "aria-label": "Show models", title: "Show models" }, "▾");
  const refreshBtn = h("button", { class: "st-pill ai-mp-refresh", type: "button", title: "Reload the model list" }, "↻");
  const srcLine = h("div", { class: "ai-mp-src" });
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const box = h("div", { class: "ai-mp-box" }, input, caret, list);
  const el = h("div", { class: "ai-mp" }, h("div", { class: "st-ctl" }, box, refreshBtn), srcLine);

  const paintSource = (): void => {
    if (loading) {
      srcLine.textContent = "Loading models…";
      srcLine.className = "ai-mp-src";
      return;
    }
    if (!data) {
      srcLine.textContent = "";
      return;
    }
    const n = data.models.length;
    const from = data.source ? `from ${data.source}` : "";
    srcLine.className = "ai-mp-src" + (data.error ? " warn" : "");
    srcLine.textContent = [n ? `${n} model${n === 1 ? "" : "s"}` : "", from, data.error ?? ""].filter(Boolean).join(" · ");
  };

  const load = async (force: boolean): Promise<void> => {
    const t = target();
    const k = `${t.provider}|${t.baseUrl ?? ""}`;
    if (!force && k === key && (data || loading)) return;
    key = k;
    loading = true;
    paintSource();
    let res: AiModels;
    try {
      res = await api.aiModels(t.provider, t.baseUrl, force);
    } catch (e) {
      res = { models: [], source: "", error: errMsg(e) };
    }
    if (key !== k) return; // the provider changed meanwhile
    data = res;
    loading = false;
    paintSource();
    if (open) render();
  };

  const choose = (id: string): void => {
    input.value = id;
    updateSettings((s) => (s.ai.model = id));
    close();
    input.focus();
  };

  const render = (): void => {
    const q = filterText.trim().toLowerCase();
    const models: AiModel[] = (data?.models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || (m.label ?? "").toLowerCase().includes(q));
    const cur = getSettings().ai.model;
    const rows: HTMLElement[] = [];
    items = [];
    const item = (id: string, main: string, note: string | null): void => {
      const row = h(
        "div",
        { class: "ai-mp-item" + (id === cur ? " on" : ""), role: "option", "aria-selected": String(id === cur) },
        h("span", { class: "ai-mp-id" + (id ? " mono" : "") }, main),
        note ? h("span", { class: "ai-mp-note" }, note) : null,
      );
      // mousedown: keep the input's focus
      row.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault());
      row.addEventListener("click", () => choose(id));
      items.push({ id, el: row });
      rows.push(row);
    };
    if (!q) item("", "Default", "the provider’s own choice");
    let group: string | null = null;
    for (const m of models.slice(0, 400)) {
      const g = groupOf(m.id);
      if (g !== group) {
        group = g;
        if (g) rows.push(h("div", { class: "ai-mp-group" }, g));
      }
      const label = m.label && m.label !== m.id ? `${m.id}  ·  ${m.label}` : m.id;
      item(m.id, label, m.note ?? null);
    }
    if (models.length > 400) rows.push(h("div", { class: "ai-mp-more" }, `… ${models.length - 400} more — type to filter`));
    if (q && !models.some((m) => m.id === filterText.trim())) {
      item(filterText.trim(), `Use “${filterText.trim()}”`, "custom");
    }
    if (loading && !data) rows.push(h("div", { class: "ai-mp-more" }, "Loading models…"));
    else if (!models.length && data?.error) rows.push(h("div", { class: "ai-mp-more" }, data.error));
    list.replaceChildren(...rows);
    sel = Math.min(sel, items.length - 1);
    paintSel();
  };

  const paintSel = (): void => {
    items.forEach((it, i) => it.el.classList.toggle("sel", i === sel));
    items[sel]?.el.scrollIntoView({ block: "nearest" });
  };

  const show = (filter: string): void => {
    filterText = filter;
    open = true;
    sel = -1;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    void load(false);
    render();
  };

  function close(): void {
    open = false;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  input.addEventListener("focus", () => show(""));
  input.addEventListener("input", () => show(input.value));
  input.addEventListener("blur", () => window.setTimeout(close, 120));
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) show("");
      if (!items.length) return;
      sel = e.key === "ArrowDown" ? (sel + 1) % items.length : (sel - 1 + items.length) % items.length;
      paintSel();
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (sel >= 0 && items[sel]) choose(items[sel].id);
      else close();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  caret.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault());
  caret.addEventListener("click", () => {
    if (open) close();
    else {
      input.focus();
      show("");
    }
  });
  refreshBtn.addEventListener("click", () => void load(true));

  return {
    el,
    sync: () => {
      const t = target();
      if (`${t.provider}|${t.baseUrl ?? ""}` !== key && t.provider !== "ollama") void load(false);
    },
  };
}
