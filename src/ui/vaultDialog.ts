// Vault profiles manager: two panes (profiles + editor). Replacing a token = paste into the big field.
import { open } from "@tauri-apps/plugin-dialog";
import type { VaultProfile, VaultTokenSource } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { confirmDialog } from "./confirm";
import { createPmShell } from "./pmDialog";
import type { PmItem } from "./pmDialog";
import { store } from "./state";
import { CONN_COLORS } from "./sqlutil";
import { toast } from "./toast";
import { OIDC_REDIRECT_URI, fmtRemaining, isOidcCancel, statusText, statusTone, tracksToken, vaults } from "./vault";
import { openAssignDialog, usersOf } from "./vaultAssign";
import { tokenInput } from "./vaultChips";
import type { TokenInput } from "./vaultChips";

export interface VaultDialogOpts {
  /** Profile to select (otherwise the first). */
  select?: string;
  /** Start a new profile with this token already in the token field (global paste → "Create a profile"). */
  newWithToken?: string;
  onClose?: () => void;
}

const SOURCES: [VaultTokenSource, string][] = [
  ["keychain", "Paste token"],
  ["oidc", "OIDC"],
  ["file", "Token file"],
  ["env", "VAULT_TOKEN env"],
];

const blank = (): VaultProfile => ({ id: "", name: "", address: "", namespace: "", tokenSource: "keychain", tokenFile: "", caCertPath: "", skipTlsVerify: false, color: CONN_COLORS[3] });

export function openVaultProfilesDialog(opts: VaultDialogOpts = {}): void {
  if (document.querySelector(".pm-dialog[aria-label='Vault profiles']")) return;
  const shell = createPmShell("Vault profiles", "key", "New profile", "Vault profiles");
  let draft: VaultProfile = blank();
  let pendingToken = opts.newWithToken ?? "";
  const unsub = vaults.subscribe(() => {
    renderList();
    renderStatus?.();
  });
  shell.onClosed = () => {
    unsub();
    opts.onClose?.();
  };
  let renderStatus: (() => void) | null = null;
  /** Last OIDC sign-in error (kept across editor re-renders). */
  let oidcErr = "";

  const items = (): PmItem[] => {
    const l: PmItem[] = vaults.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      sub: tracksToken(p) ? (p.tokenSource === "oidc" ? "OIDC · " : "") + statusText(p.id) : p.tokenSource === "file" ? "token file" : "VAULT_TOKEN env",
      tone: tracksToken(p) ? statusTone(p.id) : "idle",
    }));
    if (!draft.id) l.push({ id: "", name: draft.name || "New profile", color: draft.color, sub: "not saved yet", tone: "idle" });
    return l;
  };
  const renderList = (): void => shell.setList(items(), draft.id);

  const select = (id: string): void => {
    oidcErr = "";
    const p = id ? vaults.get(id) : undefined;
    draft = p ? { ...p } : blank();
    renderEditor();
    renderList();
  };
  shell.onSelect = select;
  shell.onNew = () => select("");

  const field = (label: string, input: HTMLElement): HTMLElement => h("label", { class: "field" }, h("span", { class: "field-label" }, label), input);

  function renderEditor(): void {
    const ed = shell.editor;
    clear(ed);
    clear(shell.footLeft);
    const d = draft;
    const isNew = !d.id;
    let source: VaultTokenSource = d.tokenSource ?? "keychain";
    let color = d.color ?? CONN_COLORS[3];

    const inName = h("input", { class: "input", type: "text", placeholder: "Prod Vault", value: d.name, spellcheck: false, "aria-label": "Profile name" });
    const inAddr = h("input", { class: "input", type: "text", placeholder: "https://vault.example.com:8200", value: d.address ?? "", spellcheck: false, "aria-label": "Vault address" });
    const inNs = h("input", { class: "input", type: "text", placeholder: "optional", value: d.namespace ?? "", spellcheck: false, "aria-label": "Namespace" });
    const inFile = h("input", { class: "input", type: "text", placeholder: "~/.vault-token", value: d.tokenFile ?? "", spellcheck: false, "aria-label": "Token file" });
    const inCa = h("input", { class: "input", type: "text", placeholder: "/path/to/ca.pem", value: d.caCertPath ?? "", spellcheck: false, "aria-label": "CA certificate" });
    const inMount = h("input", { class: "input mono", type: "text", placeholder: "oidc", value: d.oidcMount ?? "oidc", spellcheck: false, "aria-label": "OIDC mount path" });
    const inRole = h("input", { class: "input mono", type: "text", placeholder: "default role", value: d.oidcRole ?? "", spellcheck: false, "aria-label": "OIDC role" });
    const chkSkip = h("input", { type: "checkbox", checked: d.skipTlsVerify === true });
    const err = h("div", { class: "test-result", role: "alert" });
    const showErr = (m: string): void => {
      err.className = "test-result err";
      clear(err);
      err.append(icon("alert", 15), h("span", null, m));
    };
    const browse = (target: HTMLInputElement, title: string): HTMLElement =>
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            try {
              const p = await open({ multiple: false, directory: false, title });
              if (typeof p === "string") target.value = p;
            } catch (e) {
              showErr(errMsg(e));
            }
          },
        },
        icon("folder", 14),
        "Browse…",
      );

    // colour swatches
    const swatches = CONN_COLORS.map((c) => {
      const b = h("button", { type: "button", class: "swatch" + (c === color ? " on" : ""), title: c, "aria-label": "Color " + c, style: `--c:${c}` });
      b.addEventListener("click", () => {
        color = c;
        draft.color = c;
        swatches.forEach((s) => s.classList.toggle("on", s === b));
        renderList();
      });
      return b;
    });

    const collect = (): VaultProfile => ({
      id: d.id,
      name: inName.value.trim(),
      address: inAddr.value.trim() || null,
      namespace: inNs.value.trim() || null,
      tokenSource: source,
      tokenFile: source === "file" ? inFile.value.trim() || null : null,
      caCertPath: inCa.value.trim() || null,
      skipTlsVerify: chkSkip.checked,
      color,
      oidcMount: inMount.value.trim().replace(/^\/+|\/+$/g, "") || "oidc",
      oidcRole: inRole.value.trim() || null,
    });
    const problem = (p: VaultProfile): string | null => (!p.name ? "Give the profile a name." : !p.address ? "Enter the Vault address." : source === "file" && !p.tokenFile ? "Choose the token file." : null);
    inName.addEventListener("input", () => {
      draft.name = inName.value;
      renderList();
    });

    // ----- token source
    const segBtns = SOURCES.map(([v, label]) => {
      const b = h("button", { class: "seg-btn", type: "button", role: "radio" }, label);
      b.addEventListener("click", () => {
        source = v;
        syncSource();
      });
      b.dataset.v = v;
      return b;
    });
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Sign-in method" }, segBtns);

    // paste pane
    const statusCard = h("div", { class: "vstat", "aria-live": "polite" });
    let ti!: TokenInput;
    const savePasted = async (token: string): Promise<void> => {
      const p = collect();
      const bad = problem(p);
      if (bad) {
        showErr(bad + " Then paste the token again.");
        return;
      }
      err.className = "test-result";
      clear(err);
      ti.setBusy(true);
      showCard("busy", "Saving and checking with Vault…");
      try {
        const saved = await vaults.save({ ...p, tokenSource: "keychain" }, token);
        draft = { ...saved };
        d.id = saved.id;
        await vaults.lookup(saved.id);
        ti.input.value = "";
        selectedAfterSave(saved);
      } catch (e) {
        showCard("err", errMsg(e));
      } finally {
        ti.setBusy(false);
      }
    };
    ti = tokenInput({ placeholder: "Paste the Vault token here — it is saved the moment you paste", label: "Vault token", onToken: (t) => void savePasted(t), large: true, reveal: true });
    if (pendingToken) {
      ti.input.value = pendingToken;
      pendingToken = "";
    }
    const pastePane = h("div", { class: "vault-stack" }, ti.el, h("span", { class: "vault-hint" }, "Paste (or press Enter) to save it in the system keychain and check it with Vault. Tokens expire — paste a new one anytime, here or from the chip in the sidebar."));
    const filePane = h("div", { class: "vault-stack" }, h("div", { class: "row2 tight" }, inFile, browse(inFile, "Choose Vault token file")), h("span", { class: "vault-hint" }, "Re-read on every connection — keep your script writing the file."));
    const envPane = h("div", { class: "vault-note" }, "Reads VAULT_TOKEN from the environment DataTrip was started in.");

    // OIDC pane: mount + role, the redirect URI note and the sign-in state box (idle / waiting / signed in / expired).
    const oidcBox = h("div", { class: "oidc-box", "aria-live": "polite" });
    const oidcPane = h(
      "div",
      { class: "vault-stack" },
      h("div", { class: "row2" }, field("Mount path", inMount), field("Role (optional)", inRole)),
      h("span", { class: "vault-hint" }, "Redirect URI ", h("span", { class: "mono oidc-uri" }, OIDC_REDIRECT_URI), " must be in the role’s allowed_redirect_uris (same as the vault CLI)."),
      oidcBox,
    );
    const signIn = async (): Promise<void> => {
      const p = collect();
      const bad = problem(p);
      if (bad) {
        showErr(bad);
        return;
      }
      err.className = "test-result";
      clear(err);
      oidcErr = "";
      try {
        // The backend signs in a saved profile (it reads address / mount from it): save first when needed.
        const cur = d.id ? vaults.get(d.id) : undefined;
        const changed = !cur || JSON.stringify({ ...cur, ...p }) !== JSON.stringify(cur);
        let id = d.id;
        if (changed) {
          const saved = await vaults.save({ ...p, tokenSource: "oidc" }, null);
          id = saved.id;
          selectedAfterSave(saved);
        }
        await vaults.oidcLogin(id);
        toast(`Signed in to ${vaults.get(id)?.name ?? "Vault"}`, "ok");
      } catch (e) {
        if (!isOidcCancel(e)) {
          oidcErr = errMsg(e);
          renderStatus?.();
        }
      }
    };
    const renderOidc = (): void => {
      clear(oidcBox);
      const saved = d.id ? vaults.get(d.id) : undefined;
      const isOidcSaved = saved?.tokenSource === "oidc";
      const pending = !!d.id && vaults.oidcPending === d.id;
      const eff = isOidcSaved ? vaults.effective(d.id) : "unknown";
      const st = d.id ? vaults.state(d.id) : null;
      const btn = (label: string, cls: string, onclick: () => void): HTMLButtonElement => h("button", { class: "btn " + cls, type: "button", onclick }, label);
      const errLine = oidcErr ? h("div", { class: "oidc-err" }, icon("alert", 13), h("span", null, oidcErr)) : null;
      if (pending) {
        oidcBox.className = "oidc-box waiting";
        oidcBox.append(
          h("div", { class: "oidc-state" }, h("span", { class: "spinner oidc-spin", "aria-hidden": "true" }), h("div", null, h("div", { class: "oidc-title" }, "Waiting for sign-in…"), h("div", { class: "oidc-sub" }, "Finish signing in in the DataTrip sign-in window. Closing it cancels."))),
          h("div", { class: "oidc-actions" }, btn("Cancel", "sm", () => void vaults.cancelOidc())),
        );
        return;
      }
      if (eff === "valid" && st?.info) {
        const info = st.info;
        const r = vaults.remaining(d.id);
        const ttl = r === Infinity ? "Token never expires" : "Token valid for " + fmtRemaining(r ?? 0);
        oidcBox.className = "oidc-box signed";
        oidcBox.append(
          h(
            "div",
            { class: "oidc-state" },
            h("span", { class: "oidc-badge ok", "aria-hidden": "true" }, "✓"),
            h("div", null, h("div", { class: "oidc-title" }, info.displayName ? `Signed in as ${info.displayName}` : "Signed in"), info.policies.length ? h("div", { class: "oidc-sub" }, "Policies: " + info.policies.join(", ")) : null),
          ),
          h("div", { class: "oidc-ttl " + statusTone(d.id) }, h("span", { class: "oidc-dot", "aria-hidden": "true" }), ttl + (r === Infinity ? "" : info.renewable ? " · renewed automatically while DataTrip is open" : " · sign in again when it expires")),
          h("div", { class: "oidc-actions" }, btn("Sign out", "sm", () => void vaults.signOut(d.id).catch((e) => showErr(errMsg(e))))),
        );
        return;
      }
      if (eff === "loading") {
        oidcBox.className = "oidc-box";
        oidcBox.append(h("div", { class: "oidc-state" }, h("span", { class: "spinner oidc-spin", "aria-hidden": "true" }), h("div", { class: "oidc-title" }, "Checking the session…")));
        return;
      }
      const noToken = /no token|not set|missing|not found/i.test(st?.error ?? "");
      if (isOidcSaved && (eff === "expired" || (eff === "invalid" && !noToken))) {
        oidcBox.className = "oidc-box expired";
        oidcBox.append(
          h("div", { class: "oidc-state" }, h("span", { class: "oidc-badge bad", "aria-hidden": "true" }, "!"), h("div", null, h("div", { class: "oidc-title" }, "Session expired"), h("div", { class: "oidc-sub" }, st?.error ? st.error : "Queries on connections using this profile wait until you sign in again."))),
          btn("Sign in again", "primary oidc-main", () => void signIn()),
        );
        if (errLine) oidcBox.append(errLine);
        return;
      }
      oidcBox.className = "oidc-box idle";
      oidcBox.append(btn("Sign in", "primary oidc-main", () => void signIn()), h("div", { class: "oidc-sub center" }, "Opens your company sign-in page in a DataTrip window. No token to copy."));
      if (errLine) oidcBox.append(errLine);
    };

    const showCard = (kind: "ok" | "warn" | "err" | "busy" | "idle", text: string, extra?: HTMLElement | null): void => {
      statusCard.className = "vstat " + kind;
      clear(statusCard);
      statusCard.append(icon(kind === "ok" ? "check" : kind === "busy" ? "refresh" : kind === "idle" ? "key" : "alert", 15), h("span", { class: "vstat-text" }, text));
      if (extra) statusCard.append(extra);
    };
    const check = async (): Promise<void> => {
      if (!d.id) return;
      showCard("busy", "Checking with Vault…");
      await vaults.lookup(d.id);
    };
    renderStatus = (): void => {
      if (source === "oidc") {
        renderOidc();
        return;
      }
      if (!d.id) {
        showCard("idle", source === "keychain" ? "Paste a token to save this profile." : "Fill in the fields and press Save.");
        return;
      }
      const st = vaults.state(d.id);
      const eff = vaults.effective(d.id);
      const checkBtn = h("button", { class: "btn ghost sm", type: "button", onclick: () => void check() }, icon("refresh", 13), "Check");
      if (eff === "valid" && st.info) {
        const r = vaults.remaining(d.id);
        const pol = st.info.policies.length > 4 ? st.info.policies.slice(0, 4).join(", ") + ` +${st.info.policies.length - 4}` : st.info.policies.join(", ");
        const parts = ["Valid", st.info.displayName, pol, r === Infinity ? "never expires" : "expires in " + fmtRemaining(r ?? 0)].filter(Boolean);
        const renew = st.info.renewable
          ? h(
              "button",
              {
                class: "btn sm",
                type: "button",
                onclick: async (ev: Event) => {
                  const b = ev.currentTarget as HTMLButtonElement;
                  b.disabled = true;
                  try {
                    await vaults.renew(d.id);
                    toast("Token renewed", "ok");
                  } catch (e) {
                    showCard("err", errMsg(e), checkBtn);
                  }
                },
              },
              icon("refresh", 13),
              "Renew",
            )
          : null;
        showCard(statusTone(d.id) === "warn" ? "warn" : "ok", parts.join(" · "), h("span", { class: "vstat-actions" }, renew, checkBtn));
      } else if (eff === "expired") showCard("err", "Expired or not allowed — paste a new token above." + (st.error ? " (" + st.error + ")" : ""), checkBtn);
      else if (eff === "invalid") showCard("err", (st.error ?? "Vault rejected the token.") + "", checkBtn);
      else if (eff === "loading") showCard("busy", "Checking with Vault…");
      else showCard("idle", "Token not checked yet.", checkBtn);
    };

    const syncSource = (): void => {
      segBtns.forEach((b) => {
        const on = b.dataset.v === source;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      });
      pastePane.style.display = source === "keychain" ? "" : "none";
      filePane.style.display = source === "file" ? "" : "none";
      envPane.style.display = source === "env" ? "" : "none";
      oidcPane.style.display = source === "oidc" ? "" : "none";
      statusCard.style.display = source === "oidc" ? "none" : "";
      renderStatus?.();
    };

    // ----- used by
    const users = d.id ? usersOf(d.id) : [];
    const usedBy = h(
      "div",
      { class: "pm-used" },
      icon("database", 15),
      h("span", { class: "pm-used-text" }, d.id ? `Used by ${users.length} connection${users.length === 1 ? "" : "s"}` : "Used by 0 connections"),
      users.length ? h("span", { class: "pm-used-names", title: users.map((u) => u.name).join(", ") }, users.slice(0, 3).map((u) => u.name).join(", ") + (users.length > 3 ? ` +${users.length - 3}` : "")) : null,
      h("div", { class: "spacer" }),
      h("button", { class: "btn sm", type: "button", disabled: isNew || store.list().length === 0, onclick: () => openAssignDialog(d.id, () => renderEditor()) }, "Assign to…"),
    );

    // ----- footer
    if (!isNew) {
      const del = h("button", { class: "btn ghost danger-text", type: "button" }, icon("trash", 14), "Delete");
      del.onclick = async () => {
        const ok = await confirmDialog("Delete Vault profile?", `“${d.name}” and its stored token will be removed.`, "Delete", true);
        if (!ok) return;
        try {
          await vaults.remove(d.id);
          select(vaults.profiles[0]?.id ?? "");
        } catch (e) {
          showErr(errMsg(e));
        }
      };
      shell.footLeft.append(del);
    }
    shell.btnSave.textContent = isNew ? "Create profile" : "Save";
    shell.btnSave.onclick = async () => {
      const p = collect();
      const bad = problem(p);
      if (bad) return showErr(bad);
      shell.btnSave.disabled = true;
      try {
        const saved = await vaults.save(p, ti.input.value.trim() && source === "keychain" ? ti.input.value.trim() : null);
        if (ti.input.value.trim() && source === "keychain") ti.input.value = "";
        toast(`Saved “${saved.name}”`, "ok");
        selectedAfterSave(saved);
        void vaults.lookup(saved.id);
      } catch (e) {
        showErr(errMsg(e));
      } finally {
        shell.btnSave.disabled = false;
      }
    };

    ed.append(
      h("div", { class: "row2" }, field("Name", inName), field("Color", h("div", { class: "swatches" }, swatches))),
      h("div", { class: "row2" }, field("Address", inAddr), field("Namespace", inNs)),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Sign-in method"), h("div", { class: "vault-stack" }, seg, pastePane, oidcPane, filePane, envPane, statusCard)),
      h(
        "details",
        { class: "vault-adv", open: !!(d.caCertPath || d.skipTlsVerify) },
        h("summary", null, icon("chevron", 12), "TLS"),
        h(
          "div",
          { class: "vault-adv-body" },
          field("CA certificate", h("div", { class: "row2 tight" }, inCa, browse(inCa, "Choose CA certificate (PEM)"))),
          h("label", { class: "check" }, chkSkip, h("span", null, "Skip TLS verification")),
          h("div", { class: "vault-warn" }, icon("alert", 13), "Insecure: the Vault server's identity is not checked. Use a CA certificate instead when you can."),
        ),
      ),
      usedBy,
      err,
    );
    syncSource();
    if (isNew) window.setTimeout(() => inName.focus(), 30);
    else if (source === "keychain") window.setTimeout(() => ti.input.focus(), 30);
  }

  function selectedAfterSave(saved: VaultProfile): void {
    draft = { ...saved };
    renderEditor();
    renderList();
  }

  void (async () => {
    await vaults.ensureLoaded();
    renderList();
    if (opts.newWithToken) select("");
    else select(opts.select && vaults.get(opts.select) ? opts.select : vaults.profiles[0]?.id ?? "");
    void Promise.all(vaults.profiles.map((p) => (vaults.state(p.id).status === "unknown" ? vaults.lookup(p.id) : undefined)));
  })();
}
