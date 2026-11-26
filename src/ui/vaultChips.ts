// Always-visible Vault token chips (sidebar), the anchored "paste new token" popover and the
// global "paste a token anywhere" prompt. Replacing an expired token is one paste.
import { clear, errMsg, h, icon } from "./dom";
import { openVaultProfilesDialog } from "./vaultDialog";
import { fmtRemaining, isOidcCancel, statusText, statusTone, VAULT_TOKEN_RE, vaults } from "./vault";
import { toast } from "./toast";

// ------------------------------------------------------------------ token input

export interface TokenInputOpts {
  placeholder: string;
  label: string;
  /** Called with a pasted token (paste event) or the typed value (Enter). */
  onToken: (token: string) => void;
  large?: boolean;
  reveal?: boolean;
}

export interface TokenInput {
  el: HTMLElement;
  input: HTMLInputElement;
  setBusy(b: boolean): void;
}

/** Masked input that submits on paste and on Enter; optional Show toggle. */
export function tokenInput(o: TokenInputOpts): TokenInput {
  const input = h("input", {
    class: "input token-input" + (o.large ? " lg" : ""),
    type: "password",
    autocomplete: "off",
    spellcheck: false,
    placeholder: o.placeholder,
    "aria-label": o.label,
  });
  let busy = false;
  input.addEventListener("paste", (e) => {
    const t = (e.clipboardData?.getData("text/plain") ?? "").trim();
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    input.value = t;
    o.onToken(t);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim() && !busy) {
      e.preventDefault();
      e.stopPropagation();
      o.onToken(input.value.trim());
    }
  });
  const wrap = h("div", { class: "token-wrap" }, input);
  if (o.reveal) {
    const eye = h("button", { class: "token-eye", type: "button", "aria-pressed": "false", title: "Show / hide token" }, "Show");
    eye.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.textContent = show ? "Hide" : "Show";
      eye.setAttribute("aria-pressed", String(show));
      input.focus();
    });
    wrap.append(eye);
  }
  return {
    el: wrap,
    input,
    setBusy(b) {
      busy = b;
      input.readOnly = b;
      wrap.classList.toggle("busy", b);
    },
  };
}

// ------------------------------------------------------------------ chips

const dotTitle: Record<string, string> = { ok: "Token valid", warn: "Token expires soon", bad: "Token expired or invalid", idle: "Not checked yet" };

export class VaultChips {
  readonly el = h("div", { class: "vault-chips", role: "group", "aria-label": "Vault tokens" });

  constructor() {
    vaults.subscribe(() => this.render());
    this.render();
  }

  private chipText(id: string): string {
    const eff = vaults.effective(id);
    if (eff === "valid") {
      const r = vaults.remaining(id);
      return r === Infinity ? "no expiry" : fmtRemaining(r ?? 0);
    }
    return statusText(id);
  }

  render(): void {
    const list = vaults.tokenProfiles();
    this.el.hidden = list.length === 0;
    // Re-render in place only when the structure changed; otherwise update the labels (keeps focus + popover anchor).
    const ids = list.map((p) => p.id).join(",");
    if (this.el.dataset.ids !== ids) {
      this.el.dataset.ids = ids;
      clear(this.el);
      for (const p of list) {
        const b = h(
          "button",
          { class: "vchip", type: "button", "data-id": p.id, "aria-haspopup": "dialog" },
          h("span", { class: "vchip-dot", "aria-hidden": "true" }),
          h("span", { class: "vchip-name" }),
          h("span", { class: "vchip-time" }),
        );
        b.addEventListener("click", () => {
          const cur = vaults.get(p.id);
          const eff = vaults.effective(p.id);
          // OIDC: an expired / refused session goes straight to the browser sign-in.
          if (cur?.tokenSource === "oidc" && (eff === "expired" || eff === "invalid") && vaults.oidcPending !== p.id) void startOidcSignIn(p.id);
          else openTokenPopover(p.id, b);
        });
        this.el.appendChild(b);
      }
    }
    for (const p of list) {
      const b = this.el.querySelector<HTMLElement>(`.vchip[data-id="${CSS.escape(p.id)}"]`);
      if (!b) continue;
      const tone = statusTone(p.id);
      b.className = "vchip " + tone;
      b.style.setProperty("--pc", p.color ?? "#8e8e93");
      const oidc = p.tokenSource === "oidc";
      const eff = vaults.effective(p.id);
      b.classList.toggle("oidc", oidc);
      b.classList.toggle("pending", vaults.oidcPending === p.id);
      b.title = oidc
        ? `${p.name} — ${dotTitle[tone]} · ${eff === "expired" || eff === "invalid" ? "click to sign in with your browser" : "OIDC sign-in"}`
        : `${p.name} — ${dotTitle[tone]} · click to paste a new token`;
      b.querySelector(".vchip-name")!.textContent = p.name;
      b.querySelector(".vchip-time")!.textContent = this.chipText(p.id);
    }
  }
}

// ------------------------------------------------------------------ popover

let closePop: (() => void) | null = null;
let lastPop = { id: "", t: 0 };

/** Runs paste → save → verify and reports into `status`; resolves true on success. */
async function applyToken(profileId: string, token: string, status: HTMLElement, ti?: TokenInput): Promise<boolean> {
  ti?.setBusy(true);
  status.className = "vpop-status busy";
  status.textContent = "Saving and checking with Vault…";
  try {
    const info = await vaults.replaceToken(profileId, token);
    status.className = "vpop-status ok";
    clear(status);
    status.append(icon("check", 14), h("span", null, info.ttlSecs === 0 ? "Saved · never expires" : "Saved · expires in " + fmtRemaining(info.ttlSecs)));
    return true;
  } catch (e) {
    status.className = "vpop-status err";
    clear(status);
    status.append(icon("alert", 14), h("span", null, errMsg(e)));
    return false;
  } finally {
    ti?.setBusy(false);
  }
}

export function openTokenPopover(profileId: string, anchor: HTMLElement): void {
  if (lastPop.id === profileId && performance.now() - lastPop.t < 250) return;
  closePop?.();
  const profile = vaults.get(profileId);
  if (!profile) return;
  const isOidc = profile.tokenSource === "oidc";
  const status = h("div", { class: "vpop-status", "aria-live": "polite" });
  const renewBtn = h("button", { class: "btn sm", type: "button" }, icon("refresh", 13), "Renew");
  const manage = h("button", { class: "btn ghost sm", type: "button" }, "Manage profiles…");
  let ti!: TokenInput;
  const close = (): void => {
    if (closePop !== close) return;
    closePop = null;
    lastPop = { id: profileId, t: performance.now() };
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", onKey, true);
    unsub();
    pop.remove();
    anchor.focus?.();
  };
  const away = (e: Event): void => {
    if (e.target instanceof Node && (pop.contains(e.target) || anchor.contains(e.target))) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  ti = tokenInput({
    placeholder: "Paste new token for " + profile.name,
    label: "Paste new token for " + profile.name,
    onToken: (t) =>
      void applyToken(profileId, t, status, ti).then((ok) => {
        if (ok) window.setTimeout(close, 1200);
      }),
  });
  const head = h(
    "div",
    { class: "vpop-head" },
    h("span", { class: "vpop-dot", style: `--pc:${profile.color ?? "#8e8e93"}` }),
    h("div", { class: "vpop-title" }, profile.name),
    h("div", { class: "vpop-state" }),
  );
  const syncHead = (): void => {
    const tone = statusTone(profileId);
    const st = head.querySelector<HTMLElement>(".vpop-state")!;
    st.className = "vpop-state " + tone;
    st.textContent = statusText(profileId);
    const info = vaults.state(profileId).info;
    renewBtn.style.display = info?.renewable && vaults.effective(profileId) === "valid" ? "" : "none";
    if (isOidc) signIn.textContent = vaults.effective(profileId) === "valid" ? "Sign in again" : "Sign in with browser";
  };
  const unsub = vaults.subscribe(syncHead);
  renewBtn.onclick = async () => {
    renewBtn.disabled = true;
    status.className = "vpop-status busy";
    status.textContent = "Renewing…";
    try {
      const info = await vaults.renew(profileId);
      status.className = "vpop-status ok";
      clear(status);
      status.append(icon("check", 14), h("span", null, "Renewed · expires in " + (info.ttlSecs === 0 ? "never" : fmtRemaining(info.ttlSecs))));
    } catch (e) {
      status.className = "vpop-status err";
      clear(status);
      status.append(icon("alert", 14), h("span", null, errMsg(e)));
    } finally {
      renewBtn.disabled = false;
    }
  };
  manage.onclick = () => {
    close();
    openVaultProfilesDialog({ select: profileId });
  };
  const signIn = h("button", { class: "btn primary sm oidc-signin", type: "button" }, "Sign in with browser");
  signIn.onclick = async () => {
    signIn.disabled = true;
    status.className = "vpop-status busy";
    status.textContent = "Waiting for browser sign-in…";
    const ok = await startOidcSignIn(profileId, status);
    signIn.disabled = false;
    if (ok) window.setTimeout(close, 1200);
  };
  const pop = h(
    "div",
    { class: "vault-pop", role: "dialog", "aria-label": (isOidc ? "Sign in to " : "Replace Vault token for ") + profile.name },
    head,
    isOidc ? signIn : ti.el,
    status,
    h("div", { class: "vpop-foot" }, renewBtn, h("div", { class: "spacer" }), manage),
  );
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw.width - 8)) + "px";
  pop.style.top = Math.min(r.bottom + 8, window.innerHeight - pw.height - 8) + "px";
  closePop = close;
  syncHead();
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", onKey, true);
  if (isOidc) signIn.focus();
  else ti.input.focus();
}

// ------------------------------------------------------------------ OIDC sign-in

/**
 * Starts the browser sign-in of an OIDC profile. Progress / errors go to `status` when given, else to toasts.
 * Resolves true once signed in (false on error or cancel).
 */
export async function startOidcSignIn(profileId: string, status?: HTMLElement): Promise<boolean> {
  const p = vaults.get(profileId);
  if (!p) return false;
  if (!status) toast(`Finish signing in to ${p.name} in your browser…`, "info", 6000);
  try {
    const info = await vaults.oidcLogin(profileId);
    const who = info.displayName ? ` as ${info.displayName}` : "";
    const ttl = info.ttlSecs === 0 ? "never expires" : "valid for " + fmtRemaining(info.ttlSecs);
    if (status) {
      status.className = "vpop-status ok";
      clear(status);
      status.append(icon("check", 14), h("span", null, `Signed in${who} · ${ttl}`));
    } else toast(`Signed in to ${p.name}${who} · ${ttl}`, "ok");
    return true;
  } catch (e) {
    const cancelled = isOidcCancel(e);
    if (status) {
      status.className = "vpop-status" + (cancelled ? "" : " err");
      clear(status);
      if (!cancelled) status.append(icon("alert", 14), h("span", null, errMsg(e)));
    } else if (!cancelled) toast(`Sign-in to ${p.name} failed: ${errMsg(e)}`, "error");
    return false;
  }
}

// ------------------------------------------------------------------ global paste prompt

let closePrompt: (() => void) | null = null;

/** "Use this Vault token for: [Prod] [Stage]" — shown when a token is pasted outside any input. */
export function showTokenPastePrompt(token: string): void {
  closePrompt?.();
  const status = h("div", { class: "vpop-status", "aria-live": "polite" });
  const profiles = vaults.keychainProfiles();
  const done = (delay = 0): void => {
    window.setTimeout(() => closePrompt?.(), delay);
  };
  const btns = profiles.map((p) => {
    const b = h("button", { class: "btn sm vp-choice", type: "button", style: `--pc:${p.color ?? "#8e8e93"}` }, h("span", { class: "vchip-dot" }), p.name);
    b.addEventListener("click", async () => {
      for (const x of btns) x.disabled = true;
      const ok = await applyToken(p.id, token, status);
      if (ok) done(1400);
      else for (const x of btns) x.disabled = false;
    });
    return b;
  });
  const empty =
    profiles.length === 0
      ? h(
          "button",
          {
            class: "btn sm",
            type: "button",
            onclick: () => {
              done();
              openVaultProfilesDialog({ newWithToken: token });
            },
          },
          icon("plus", 13),
          "Create a Vault profile…",
        )
      : null;
  const cancel = h("button", { class: "btn ghost sm", type: "button", onclick: () => done() }, "Cancel");
  const el = h(
    "div",
    { class: "vault-paste", role: "dialog", "aria-label": "Use pasted Vault token" },
    h("div", { class: "vp-head" }, icon("key", 15), h("span", null, profiles.length ? "Use this Vault token for" : "That looks like a Vault token")),
    h("div", { class: "vp-row" }, btns, empty, cancel),
    status,
  );
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") done();
  };
  closePrompt = (): void => {
    closePrompt = null;
    window.removeEventListener("keydown", onKey, true);
    el.classList.add("leaving");
    window.setTimeout(() => el.remove(), 160);
  };
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(el);
  btns[0]?.focus();
}

export { VAULT_TOKEN_RE };
