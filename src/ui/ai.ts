// AI assistant: provider status, production detection and the schema context sent with a request.
// No UI here (see aiPanel.ts / aiEditor.ts / aiSettings.ts). The backend side is src-tauri/src/ai.rs.
import { api } from "../api";
import type { AiProviderId, AiProviderStatus, ConnectionConfig, Driver } from "../types";
import { getSettings } from "./settings";
import type { AppSettings } from "./settings";
import { prodOptions } from "./prodSafety";

export const AI_PROVIDER_NAMES: Record<AiProviderId, string> = {
  codex: "Codex CLI",
  claude: "Claude Code CLI",
  opencode: "OpenCode CLI",
  openai: "API key",
  ollama: "Ollama (local)",
};

/** Drivers the assistant writes for (Redis / Kafka consoles get no AI). */
export const AI_DRIVERS: ReadonlySet<Driver> = new Set<Driver>(["postgres", "mysql", "sqlite", "mssql"]);

// Pure schema-context helpers live in aiContext.ts (node-testable); re-exported here for the UI modules.
export { DIALECT_NAMES, SAMPLE_ROWS, SAMPLE_TABLES, buildSchemaContext, displayName, renderSamples, sampleSql } from "./aiContext";
export type { ContextInput, PickedTable, SchemaContext } from "./aiContext";

// ---------------------------------------------------------------- production data sources

/** "prod" / "production" as a word of the name or folder ("Prod PG", "eu-prod", "prod_db", folder "Production"). */
const PROD = /(?:^|[^a-z0-9])prod(?:uction)?(?:[^a-z0-9]|$)/i;

/**
 * A data source is treated as production when it is marked so in its connection dialog (v0.16, the primary signal),
 * else (fallback heuristic) when it is read-only or its name / folder says "prod".
 */
export function isProdConnection(c: ConnectionConfig | null | undefined): boolean {
  if (!c) return false;
  if (prodOptions(c)) return true;
  return c.readOnly === true || PROD.test(c.name) || PROD.test(c.folder ?? "");
}

/** Why AI is refused for this data source (Settings › Block AI for production), or null. */
export function aiBlockedReason(c: ConnectionConfig | null | undefined, s: AppSettings = getSettings()): string | null {
  if (!c || !s.ai.blockProd || !isProdConnection(c)) return null;
  const why = prodOptions(c) ? "is marked as a production data source" : c.readOnly ? "is read-only" : "looks like production";
  return `AI is off for “${c.name}”: it ${why} and “Block AI for production data sources” is on (Settings › AI assistant).`;
}

/** Sample rows may be sent: the setting is on and the data source is neither read-only nor production. */
export function samplesAllowed(c: ConnectionConfig | null | undefined, s: AppSettings = getSettings()): boolean {
  return !!c && s.ai.samples && !isProdConnection(c);
}

// ---------------------------------------------------------------- providers

let providerCache: { at: number; list: Promise<AiProviderStatus[]> } | null = null;

/** Provider status (cached 30 s; `force` re-detects). Never rejects: a failure yields []. */
export function loadProviders(force = false): Promise<AiProviderStatus[]> {
  const now = Date.now();
  if (!force && providerCache && now - providerCache.at < 30_000) return providerCache.list;
  const list = api.aiProviders().catch(() => [] as AiProviderStatus[]);
  providerCache = { at: now, list };
  return list;
}

/** Short label of the configured provider and its model for the prompt box chip ("Codex · gpt-6.2-sol"). */
export function providerChip(s: AppSettings, status: AiProviderStatus | undefined): string {
  const a = s.ai;
  switch (a.provider) {
    case "codex":
      return a.model ? `Codex · ${a.model}` : status?.signedIn ? "Codex · default model · ChatGPT sign-in" : "Codex · default model";
    case "claude":
      return `Claude Code · ${a.model || "default model"}`;
    case "opencode":
      return `OpenCode · ${a.model || "default model"}`;
    case "openai":
      return `API · ${a.model || "gpt-4o-mini"}`;
    case "ollama":
      return `Ollama · ${a.ollamaModel || status?.models[0] || "local"}`;
  }
}

/** Short provider name for result bars ("Codex · 2.1 s"). */
export function providerShort(id: AiProviderId): string {
  return id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : id === "opencode" ? "OpenCode" : id === "openai" ? "API" : "Ollama";
}

/** Model to send for the configured provider (null = provider default). */
export function modelFor(s: AppSettings): string | null {
  const m = s.ai.provider === "ollama" ? s.ai.ollamaModel : s.ai.model;
  return m.trim() ? m.trim() : null;
}
