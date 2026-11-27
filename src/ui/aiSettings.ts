// Settings › AI assistant (board N, "AI settings" scene): provider cards with live status, model / key / endpoint
// fields and the three privacy toggles. Built with the settings window's own row / toggle helpers.
import { api } from "../api";
import type { AiProviderId, AiProviderStatus } from "../types";
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

const ORDER: AiProviderId[] = ["codex", "claude", "openai", "ollama"];

const SUBS: Record<AiProviderId, string> = {
  codex: "Detected on your PATH · uses your ChatGPT sign-in, no API key",
  claude: "Uses the claude command and your Claude sign-in if installed",
  openai: "OpenAI-compatible endpoint + key, stored in the keychain",
  ollama: "Runs on this computer; nothing leaves your machine",
};

function statusOf(p: AiProviderStatus | undefined, id: AiProviderId): { text: string; cls: string } {
  if (!p) return { text: "Checking…", cls: "" };
  if (id === "codex") return p.available ? (p.signedIn ? { text: "● Signed in", cls: "ok" } : { text: "Not signed in", cls: "warn" }) : { text: "Not found", cls: "" };
  if (id === "claude") return p.available ? { text: "● Installed", cls: "ok" } : { text: "Not found", cls: "" };
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
    text: "ai assistant provider codex chatgpt claude code openai api key ollama local model",
  };

  // model (Codex / Claude Code / API)
  const model = kit.textField("Model", () => S().ai.model, (v) => updateSettings((s) => (s.ai.model = v)), true, 220);
  kit.onSync(() => {
    const p = S().ai.provider;
    model.placeholder = p === "codex" ? "default (Codex config)" : p === "claude" ? "default" : "gpt-4o-mini";
  });
  const modelRow = kit.row("Model", "Leave empty for the provider’s default", model, "model gpt");

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
