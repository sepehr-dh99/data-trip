// Inline recovery from backend errors: an expired / refused Vault token (paste a new one, then retry the
// failed action) and unknown / changed SSH host keys (trust dialog, then retry).
import { clear, errMsg, h, icon } from "./dom";
import { parseHostKeyError, trustHostFlow } from "./sshDialog";
import { toastNode } from "./toast";
import { fmtRemaining, vaults } from "./vault";
import { startOidcSignIn, tokenInput } from "./vaultChips";
import type { TokenInput } from "./vaultChips";

export type Retry = () => unknown;

const VAULT_RE = /^\s*VAULT_TOKEN_INVALID:([^:]*):\s*([\s\S]*)$/;

export function parseVaultError(msg: string): { profileId: string; text: string } | null {
  const m = VAULT_RE.exec(msg);
  return m ? { profileId: m[1], text: m[2].trim() } : null;
}

/** True when `err` is one this module can recover from (so the caller can skip its own generic toast). */
export function isRecoverable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return VAULT_RE.test(m) || parseHostKeyError(m) !== null;
}

/**
 * Shows the recovery UI for a recoverable error and, once fixed, runs `retry`.
 * Returns false (and does nothing) for any other error.
 */
export function handleActionError(err: unknown, retry?: Retry): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const v = parseVaultError(msg);
  if (v) {
    void vaultRecovery(v.profileId, v.text, retry);
    return true;
  }
  const k = parseHostKeyError(msg);
  if (k) {
    void (async () => {
      if (await trustHostFlow(k)) await retry?.();
    })();
    return true;
  }
  return false;
}

const active = new Map<string, () => void>();

async function vaultRecovery(profileId: string, text: string, retry?: Retry): Promise<void> {
  await vaults.ensureLoaded();
  active.get(profileId)?.();
  const name = vaults.get(profileId)?.name ?? "Vault";
  const status = h("div", { class: "rec-status", "aria-live": "polite" });
  let dismiss = (): void => undefined;
  if (vaults.get(profileId)?.tokenSource === "oidc") {
    oidcRecovery(profileId, name, text, retry);
    return;
  }
  let ti!: TokenInput;
  ti = tokenInput({
    placeholder: "Paste new token",
    label: "Paste new token for " + name,
    onToken: async (t) => {
      ti.setBusy(true);
      status.className = "rec-status busy";
      status.textContent = "Saving and checking…";
      try {
        const info = await vaults.replaceToken(profileId, t);
        status.className = "rec-status ok";
        clear(status);
        status.append(icon("check", 13), h("span", null, `Token saved · ${info.ttlSecs === 0 ? "never expires" : "expires in " + fmtRemaining(info.ttlSecs)}${retry ? " — retrying…" : ""}`));
        window.setTimeout(dismiss, 1400);
        await retry?.();
      } catch (e) {
        status.className = "rec-status err";
        clear(status);
        status.append(icon("alert", 13), h("span", null, errMsg(e)));
        ti.setBusy(false);
      }
    },
  });
  const close = h("button", { class: "rec-x", type: "button", title: "Dismiss", "aria-label": "Dismiss", onclick: () => dismiss() }, icon("x", 12));
  const node = h(
    "div",
    { class: "rec" },
    h("div", { class: "rec-head" }, h("b", null, `Vault token for ${name}: expired or not allowed`), close),
    h("div", { class: "rec-text" }, text || "Vault refused the request (403). If the token expired, paste a new one."),
    ti.el,
    status,
  );
  const d = toastNode(node, "error");
  dismiss = (): void => {
    d();
    active.delete(profileId);
  };
  active.set(profileId, dismiss);
  window.setTimeout(() => ti.input.focus(), 50);
}

/** OIDC profiles: "Sign in again" (browser) instead of pasting a token, then the failed action is retried. */
function oidcRecovery(profileId: string, name: string, text: string, retry?: Retry): void {
  const status = h("div", { class: "rec-status", "aria-live": "polite" });
  let dismiss = (): void => undefined;
  const btn = h("button", { class: "btn primary sm", type: "button" }, "Sign in again");
  const cancel = h("button", { class: "btn ghost sm", type: "button", hidden: true }, "Cancel");
  cancel.onclick = () => void vaults.cancelOidc();
  btn.onclick = async () => {
    btn.disabled = true;
    cancel.hidden = false;
    status.className = "rec-status busy";
    status.textContent = "Waiting for sign-in…";
    const ok = await startOidcSignIn(profileId, status);
    cancel.hidden = true;
    btn.disabled = false;
    if (ok) {
      status.className = "rec-status ok";
      clear(status);
      status.append(icon("check", 13), h("span", null, `Signed in${retry ? " — retrying…" : ""}`));
      window.setTimeout(dismiss, 1400);
      await retry?.();
    }
  };
  const close = h("button", { class: "rec-x", type: "button", title: "Dismiss", "aria-label": "Dismiss", onclick: () => dismiss() }, icon("x", 12));
  const node = h(
    "div",
    { class: "rec" },
    h("div", { class: "rec-head" }, h("b", null, `${name}: session expired`), close),
    h("div", { class: "rec-text" }, text || "Vault refused the request (403). Sign in again; the action is retried afterwards."),
    h("div", { class: "rec-actions" }, btn, cancel),
    status,
  );
  const d = toastNode(node, "error");
  dismiss = (): void => {
    d();
    active.delete(profileId);
  };
  active.set(profileId, dismiss);
  window.setTimeout(() => btn.focus(), 50);
}
