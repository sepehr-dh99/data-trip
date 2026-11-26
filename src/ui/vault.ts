// Shared Vault profiles: cached list, per-profile token status with a live countdown, and the
// one-step "replace token" operation used by chips, the paste prompt, the manager and error recovery.
import { api } from "../api";
import type { VaultProfile, VaultTokenInfo } from "../types";

export type TokStatus = "unknown" | "loading" | "valid" | "expired" | "invalid";

export interface TokState {
  status: TokStatus;
  info: VaultTokenInfo | null;
  /** performance.now() when `info` was looked up. */
  at: number;
  /** Vault / transport error from the last lookup. */
  error: string | null;
}

/** Matches Vault service / batch / recovery tokens and legacy `s.` / `b.` tokens. */
export const VAULT_TOKEN_RE = /^(hvs|hvb|hvr|s|b)\.[A-Za-z0-9_\-.]{20,}$/;

/** "7h 12m", "42m", "8m 05s", "< 1m". */
export function fmtRemaining(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    return d + "d" + (hh ? " " + hh + "h" : "");
  }
  if (s >= 3600) {
    const m = Math.floor((s % 3600) / 60);
    return Math.floor(s / 3600) + "h" + (m ? " " + m + "m" : "");
  }
  if (s >= 600) return Math.floor(s / 60) + "m";
  if (s >= 60) return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  return s > 0 ? "< 1m" : "0m";
}

type Listener = () => void;

class VaultStore {
  profiles: VaultProfile[] = [];
  private states = new Map<string, TokState>();
  private listeners = new Set<Listener>();
  private timer: number | undefined;
  private relookup: number | undefined;
  private loaded = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }

  get(id: string): VaultProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }
  /** Profiles whose token is pasted by the user (kept in the keychain). */
  keychainProfiles(): VaultProfile[] {
    return this.profiles.filter((p) => (p.tokenSource ?? "keychain") === "keychain");
  }
  /** Profiles with a token DataTrip keeps and tracks (pasted or from an OIDC sign-in): the ones that show chips. */
  tokenProfiles(): VaultProfile[] {
    return this.profiles.filter((p) => tracksToken(p));
  }
  /** Profile id of the browser sign-in that is waiting for its callback, or null. */
  oidcPending: string | null = null;
  /** Largest TTL seen per profile since the last sign-in / renewal: the "creation TTL" for auto-renewal. */
  private fullTtl = new Map<string, number>();
  private renewTimer: number | undefined;
  state(id: string): TokState {
    return this.states.get(id) ?? { status: "unknown", info: null, at: 0, error: null };
  }

  /** Seconds left (null = unknown, Infinity = never expires). */
  remaining(id: string): number | null {
    const s = this.state(id);
    if (s.status !== "valid" || !s.info) return null;
    if (s.info.ttlSecs === 0) return Infinity;
    return s.info.ttlSecs - (performance.now() - s.at) / 1000;
  }

  /** Effective status: a valid token whose countdown ran out is shown as expired. */
  effective(id: string): TokStatus {
    const s = this.state(id);
    if (s.status === "valid") {
      const r = this.remaining(id);
      if (r !== null && r <= 0) return "expired";
    }
    return s.status;
  }

  async load(lookup = true): Promise<void> {
    try {
      this.profiles = await api.listVaultProfiles();
      this.loaded = true;
    } catch {
      this.profiles = [];
    }
    for (const id of [...this.states.keys()]) if (!this.get(id)) this.states.delete(id);
    this.emit();
    if (lookup) await Promise.all(this.profiles.map((p) => this.lookup(p.id)));
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load(false);
  }

  /** Looks the stored token up (auth/token/lookup-self) and captures its TTL. Never throws. */
  async lookup(id: string, token: string | null = null): Promise<TokState> {
    const p = this.get(id);
    if (!p) return this.state(id);
    const prev = this.state(id);
    this.states.set(id, { ...prev, status: prev.status === "valid" ? "valid" : "loading" });
    this.emit();
    let next: TokState;
    try {
      const info = await api.vaultTokenInfo(p, token);
      next = { status: "valid", info, at: performance.now(), error: null };
      this.noteTtl(id, info, false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      next = { status: /expired|ttl/i.test(msg) ? "expired" : "invalid", info: null, at: performance.now(), error: msg };
    }
    this.states.set(id, next);
    this.emit();
    return next;
  }

  /** Saves the profile (token: null = keep, "" = clear) and refreshes the cache. */
  async save(profile: VaultProfile, token: string | null): Promise<VaultProfile> {
    const saved = await api.saveVaultProfile(profile, token);
    const i = this.profiles.findIndex((p) => p.id === saved.id);
    if (i >= 0) this.profiles[i] = saved;
    else this.profiles.push(saved);
    if (token !== null) this.states.delete(saved.id);
    this.emit();
    return saved;
  }

  async remove(id: string): Promise<void> {
    await api.deleteVaultProfile(id);
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.states.delete(id);
    this.emit();
  }

  /**
   * The seconds-long operation: store the pasted token, then look it up. Resolves with the token info;
   * rejects with Vault's error when the stored token does not verify.
   */
  async replaceToken(id: string, token: string): Promise<VaultTokenInfo> {
    await this.ensureLoaded();
    const p = this.get(id);
    if (!p) throw new Error("Vault profile not found");
    const clean = token.trim();
    if (!clean) throw new Error("The clipboard was empty");
    const candidate: VaultProfile = { ...p, tokenSource: "keychain" };
    // Verify BEFORE saving, so a wrong paste never overwrites a working token.
    let info: VaultTokenInfo | null = null;
    try {
      info = await api.vaultTokenInfo(candidate, clean);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const rejected = /VAULT_TOKEN_INVALID|permission denied|invalid token|\b403\b|expired/i.test(raw);
      if (rejected) {
        // Vault answered and said no: keep the stored token untouched.
        throw new Error(`Vault rejected this token — the saved one was kept. ${raw}`);
      }
      // Vault unreachable (VPN off, DNS…): save anyway so it is ready, and say it is unverified.
      await this.save(candidate, clean);
      this.states.set(id, { status: "invalid", info: null, at: performance.now(), error: `Saved, but couldn't reach Vault to check it: ${raw}` });
      this.emit();
      throw new Error(`Saved, but couldn't reach Vault to check it: ${raw}`);
    }
    await this.save(candidate, clean);
    this.states.set(id, { status: "valid", info, at: performance.now(), error: null });
    this.emit();
    return info;
  }

  async renew(id: string): Promise<VaultTokenInfo> {
    const info = await api.renewVaultToken(id);
    this.states.set(id, { status: "valid", info, at: performance.now(), error: null });
    this.noteTtl(id, info, true);
    this.emit();
    return info;
  }

  private noteTtl(id: string, info: VaultTokenInfo, reset: boolean): void {
    if (info.ttlSecs <= 0) {
      this.fullTtl.delete(id);
      return;
    }
    const prev = reset ? 0 : (this.fullTtl.get(id) ?? 0);
    this.fullTtl.set(id, Math.max(prev, info.ttlSecs));
  }

  /**
   * Browser sign-in (OIDC) for a saved profile: opens the browser, resolves when Vault's callback arrived and the
   * token was stored. Rejects with "OIDC_CANCELLED…" after cancelOidc().
   */
  async oidcLogin(id: string): Promise<VaultTokenInfo> {
    const p = this.get(id);
    if (!p) throw new Error("Vault profile not found");
    if (this.oidcPending && this.oidcPending !== id) await this.cancelOidc();
    this.oidcPending = id;
    this.emit();
    try {
      const info = await api.vaultOidcLogin(id, p.oidcRole?.trim() || null);
      this.states.set(id, { status: "valid", info, at: performance.now(), error: null });
      this.noteTtl(id, info, true);
      return info;
    } finally {
      if (this.oidcPending === id) this.oidcPending = null;
      this.emit();
    }
  }

  async cancelOidc(): Promise<void> {
    if (!this.oidcPending) return;
    await api.vaultOidcCancel().catch(() => undefined);
  }

  /** Signs an OIDC profile out: the stored token is cleared. */
  async signOut(id: string): Promise<void> {
    const p = this.get(id);
    if (!p) return;
    await this.save(p, "");
    this.fullTtl.delete(id);
    this.states.set(id, { status: "invalid", info: null, at: performance.now(), error: "no token" });
    this.emit();
  }

  /** OIDC tokens: renew a renewable token once less than a third of its TTL is left. */
  private async autoRenew(): Promise<void> {
    for (const p of this.profiles) {
      if (p.tokenSource !== "oidc" || this.effective(p.id) !== "valid") continue;
      const info = this.state(p.id).info;
      const left = this.remaining(p.id);
      const full = this.fullTtl.get(p.id) ?? 0;
      if (!info?.renewable || left === null || left === Infinity || full <= 0) continue;
      if (left < full / 3) await this.renew(p.id).catch(() => undefined);
    }
  }

  /** Starts the 30 s countdown tick, the 10 min re-lookup and the re-lookup on window focus. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setInterval(() => this.emit(), 30_000);
    this.relookup = window.setInterval(() => void this.refreshAll(), 10 * 60_000);
    this.renewTimer = window.setInterval(() => void this.autoRenew(), 5 * 60_000);
    window.addEventListener("focus", () => {
      for (const p of this.profiles) if (performance.now() - this.state(p.id).at > 60_000) void this.lookup(p.id);
    });
  }

  private async refreshAll(): Promise<void> {
    await Promise.all(this.profiles.map((p) => this.lookup(p.id)));
  }
}

export const vaults = new VaultStore();

/** True for profiles whose token DataTrip stores and tracks (pasted token or OIDC sign-in). */
export function tracksToken(p: VaultProfile): boolean {
  const src = p.tokenSource ?? "keychain";
  return src === "keychain" || src === "oidc";
}

export const OIDC_REDIRECT_URI = "http://localhost:8250/oidc/callback";

export function isOidcCancel(e: unknown): boolean {
  return /OIDC_CANCELLED/.test(e instanceof Error ? e.message : String(e));
}

/** One-line status used by lists and summaries ("expires in 2h 14m", "expired", "never expires"). */
export function statusText(id: string): string {
  if (vaults.oidcPending === id) return "signing in…";
  const eff = vaults.effective(id);
  const st = vaults.state(id);
  if (eff === "valid") {
    const r = vaults.remaining(id);
    return r === Infinity ? "never expires" : "expires in " + fmtRemaining(r ?? 0);
  }
  if (eff === "expired") return "expired";
  if (eff === "loading") return "checking…";
  if (eff === "invalid") return /no token|not set|missing/i.test(st.error ?? "") ? "no token" : "invalid";
  return "not checked";
}

/** green > 1 h, amber < 1 h, red when expired / invalid. */
export function statusTone(id: string): "ok" | "warn" | "bad" | "idle" {
  const eff = vaults.effective(id);
  if (eff === "expired" || eff === "invalid") return "bad";
  if (eff === "valid") {
    const r = vaults.remaining(id);
    return r !== null && r < 3600 ? "warn" : "ok";
  }
  return "idle";
}
