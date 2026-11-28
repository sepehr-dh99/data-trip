// SSH configurations: cached list, manager dialog (two panes), host-key trust dialogs and "Test SSH".
import { open } from "../platform";
import { api } from "../api";
import type { SshCheck, SshProfile } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { confirmDialog } from "./confirm";
import { createPmShell } from "./pmDialog";
import { toast } from "./toast";

type Listener = () => void;

class SshStore {
  profiles: SshProfile[] = [];
  private listeners = new Set<Listener>();
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  get(id: string): SshProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }
  async load(): Promise<SshProfile[]> {
    try {
      this.profiles = await api.listSshProfiles();
    } catch {
      this.profiles = [];
    }
    for (const l of this.listeners) l();
    return this.profiles;
  }
  async save(p: SshProfile, secret: string | null): Promise<SshProfile> {
    const saved = await api.saveSshProfile(p, secret);
    const i = this.profiles.findIndex((x) => x.id === saved.id);
    if (i >= 0) this.profiles[i] = saved;
    else this.profiles.push(saved);
    for (const l of this.listeners) l();
    return saved;
  }
  async remove(id: string): Promise<void> {
    await api.deleteSshProfile(id);
    this.profiles = this.profiles.filter((p) => p.id !== id);
    for (const l of this.listeners) l();
  }
}
export const sshStore = new SshStore();

export const sshLabel = (p: SshProfile): string => `${p.user}@${p.host}${p.port && p.port !== 22 ? ":" + p.port : ""}`;

// ------------------------------------------------------------------ host key dialog

export interface HostKeyInfo {
  host: string;
  port: number;
  fingerprint: string;
  keyType?: string | null;
  /** The server presented a different key than the one trusted before. */
  changed: boolean;
}

/** "Trust host …?" (new key) or the red man-in-the-middle warning (changed key). Resolves true when trusted. */
export function hostKeyDialog(k: HostKeyInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "overlay" });
    let ack: HTMLInputElement | null = null;
    const done = (v: boolean): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(v);
    };
    const ok = h("button", { class: "btn " + (k.changed ? "danger-solid" : "primary"), type: "button", onclick: () => done(true) }, k.changed ? "I understand, trust new key" : "Trust host");
    if (k.changed) {
      ok.disabled = true;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter" && !ok.disabled && !k.changed) done(true);
    };
    const target = k.port === 22 ? k.host : `${k.host}:${k.port}`;
    const fp = h("div", { class: "hk-fp" }, h("span", { class: "hk-fp-type" }, k.keyType ?? "host key"), h("code", null, k.fingerprint));
    const body = k.changed
      ? [
          h("div", { class: "hk-warn" }, icon("alert", 18), h("div", null, h("b", null, "The host key of " + target + " has changed."))),
          h("p", { class: "confirm-text" }, "This can mean someone is intercepting your connection (a man-in-the-middle attack), or that the server was reinstalled or its keys were rotated. Do not continue unless you know why the key changed — ask whoever runs the bastion."),
          fp,
          (() => {
            ack = h("input", { type: "checkbox" });
            ack.addEventListener("change", () => (ok.disabled = !ack!.checked));
            return h("label", { class: "check hk-ack" }, ack, h("span", null, "I have verified the new fingerprint with the server's owner"));
          })(),
        ]
      : [
          h("p", { class: "confirm-text" }, `Trust host ${target}?`),
          fp,
          h("p", { class: "confirm-text sub" }, "DataTrip has not connected to this server before. Compare the fingerprint with the one your administrator gave you, then trust it to continue."),
        ];
    overlay.appendChild(
      h(
        "div",
        { class: "dialog small hostkey" + (k.changed ? " changed" : ""), role: "alertdialog", "aria-modal": "true" },
        h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon(k.changed ? "alert" : "key", 18), k.changed ? "Host key changed" : "Trust SSH host?")),
        h("div", { class: "dialog-body" }, body),
        h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: () => done(false) }, "Cancel"), ok),
      ),
    );
    document.body.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    (k.changed ? ack ?? ok : ok).focus();
  });
}

/**
 * Parses `SSH_HOST_UNKNOWN:<host>:<port>:<fingerprint>:<keytype>` / `SSH_HOST_CHANGED:…`. The fingerprint itself
 * contains a colon ("SHA256:abc…"): it is everything between the port and the last colon; null for other messages.
 */
export function parseHostKeyError(msg: string): HostKeyInfo | null {
  const m = /^\s*SSH_HOST_(UNKNOWN|CHANGED):(\[[^\]]+\]|[^:\s]+):(\d+):(\S+)/.exec(msg);
  if (!m) return null;
  const rest = m[4];
  const i = rest.lastIndexOf(":");
  const fingerprint = i > 0 ? rest.slice(0, i) : rest;
  const keyType = i > 0 ? rest.slice(i + 1) : null;
  return { host: m[2].replace(/^\[|\]$/g, ""), port: Number(m[3]), fingerprint, keyType, changed: m[1] === "CHANGED" };
}

/** Trust flow shared by "Test SSH" and error recovery. Resolves true when the host is now trusted. */
export async function trustHostFlow(k: HostKeyInfo): Promise<boolean> {
  if (!(await hostKeyDialog(k))) return false;
  try {
    await api.trustSshHost(k.host, k.port, k.fingerprint);
    return true;
  } catch (e) {
    toast("Could not store the host key: " + errMsg(e), "error");
    return false;
  }
}

// ------------------------------------------------------------------ manager

export interface SshDialogOpts {
  select?: string;
  /** Open on a blank new configuration. */
  create?: boolean;
  /** Called when a configuration was saved (with it), e.g. to select it in the connection dialog. */
  onSaved?: (p: SshProfile) => void;
  onClose?: () => void;
}

const AUTHS: ["key" | "password" | "agent", string][] = [
  ["key", "Key"],
  ["password", "Password"],
  ["agent", "Agent (coming soon)"],
];

const blank = (): SshProfile => ({ id: "", name: "", host: "", port: 22, user: "", authMethod: "key", privateKeyPath: "~/.ssh/id_ed25519", keepaliveSecs: 30 });

export function openSshProfilesDialog(opts: SshDialogOpts = {}): void {
  if (document.querySelector(".pm-dialog[aria-label='SSH configurations']")) return;
  const shell = createPmShell("SSH configurations", "server", "New configuration", "SSH configurations");
  let draft: SshProfile = blank();
  shell.onClosed = () => opts.onClose?.();

  const renderList = (): void => {
    const l = sshStore.profiles.map((p) => ({ id: p.id, name: p.name, sub: sshLabel(p), tone: "idle" as const, color: "#8fb4ff" }));
    if (!draft.id) l.push({ id: "", name: draft.name || "New configuration", sub: "not saved yet", tone: "idle", color: "#8fb4ff" });
    shell.setList(l, draft.id);
  };
  const select = (id: string): void => {
    const p = id ? sshStore.get(id) : undefined;
    draft = p ? { ...p } : blank();
    renderEditor();
    renderList();
  };
  shell.onSelect = select;
  shell.onNew = () => select("");
  const field = (label: string, input: HTMLElement, cls = ""): HTMLElement => h("label", { class: "field " + cls }, h("span", { class: "field-label" }, label), input);

  function renderEditor(): void {
    const ed = shell.editor;
    clear(ed);
    clear(shell.footLeft);
    const d = draft;
    const isNew = !d.id;
    let auth: "key" | "password" | "agent" = d.authMethod === "password" ? "password" : "key";
    const inName = h("input", { class: "input", type: "text", placeholder: "Prod bastion", value: d.name, spellcheck: false, "aria-label": "Name" });
    const inHost = h("input", { class: "input", type: "text", placeholder: "bastion.example.com", value: d.host, spellcheck: false, "aria-label": "Host" });
    const inPort = h("input", { class: "input", type: "number", min: "1", max: "65535", value: String(d.port ?? 22), "aria-label": "Port" });
    const inUser = h("input", { class: "input", type: "text", placeholder: "deploy", value: d.user, autocomplete: "off", spellcheck: false, "aria-label": "User" });
    const inKey = h("input", { class: "input", type: "text", placeholder: "~/.ssh/id_ed25519", value: d.privateKeyPath ?? "", spellcheck: false, "aria-label": "Private key path" });
    const inSecret = h("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: isNew ? "" : "Leave blank to keep the saved secret", "aria-label": "Passphrase or password" });
    const inKeep = h("input", { class: "input", type: "number", min: "0", max: "3600", value: String(d.keepaliveSecs ?? 30), "aria-label": "Keep-alive seconds" });
    const result = h("div", { class: "test-result", "aria-live": "polite" });
    const show = (kind: "ok" | "err" | "busy", msg: string): void => {
      result.className = "test-result " + kind;
      clear(result);
      result.append(icon(kind === "ok" ? "check" : kind === "busy" ? "refresh" : "alert", 15), h("span", null, msg));
    };
    inName.addEventListener("input", () => {
      draft.name = inName.value;
      renderList();
    });
    const btns = AUTHS.map(([v, l]) => {
      const b = h("button", { class: "seg-btn", type: "button", role: "radio", disabled: v === "agent", title: v === "agent" ? "SSH agent authentication isn't supported yet" : undefined }, l);
      b.dataset.v = v;
      b.addEventListener("click", () => {
        auth = v;
        sync();
      });
      return b;
    });
    const keyField = field(
      "Private key",
      h(
        "div",
        { class: "vault-stack" },
        h(
          "div",
          { class: "row2 tight" },
          inKey,
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async () => {
                try {
                  const p = await open({ multiple: false, directory: false, title: "Choose SSH private key", defaultPath: "~/.ssh", purpose: "material" });
                  if (typeof p === "string") inKey.value = p;
                } catch (e) {
                  show("err", errMsg(e));
                }
              },
            },
            icon("folder", 14),
            "Browse…",
          ),
        ),
        h("span", { class: "vault-hint" }, "Type a path if the file dialog can't show hidden folders (⌘⇧. in the macOS dialog reveals ~/.ssh)."),
      ),
    );
    const secretLabel = h("span", { class: "field-label" }, "Key passphrase");
    const secretField = h("label", { class: "field" }, secretLabel, inSecret);
    const agentNote = h("div", { class: "vault-note" }, "SSH agent authentication is not supported yet — use a key or a password.");
    const sync = (): void => {
      btns.forEach((b) => {
        const on = b.dataset.v === auth;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      });
      keyField.style.display = auth === "key" ? "" : "none";
      secretField.style.display = auth === "agent" ? "none" : "";
      agentNote.style.display = auth === "agent" ? "" : "none";
      secretLabel.textContent = auth === "key" ? "Key passphrase (optional)" : "Password";
    };
    const collect = (): SshProfile => ({
      id: d.id,
      name: inName.value.trim(),
      host: inHost.value.trim(),
      port: Number(inPort.value) || 22,
      user: inUser.value.trim(),
      authMethod: auth,
      privateKeyPath: auth === "key" ? inKey.value.trim() || "~/.ssh/id_ed25519" : null,
      keepaliveSecs: inKeep.value.trim() === "" ? null : Number(inKeep.value),
    });
    const secretArg = (): string | null => (auth === "agent" ? null : inSecret.value === "" ? null : inSecret.value);
    const problem = (p: SshProfile): string | null => (!p.name ? "Give the configuration a name." : !p.host ? "Enter the SSH host." : !p.user ? "Enter the SSH user." : null);

    const btnTest = h("button", { class: "btn", type: "button" }, icon("plug", 14), "Test SSH");
    const runTest = async (): Promise<void> => {
      const p = collect();
      const bad = problem(p) && !p.host ? "Enter the SSH host." : !p.user ? "Enter the SSH user." : null;
      if (bad) return show("err", bad);
      btnTest.disabled = true;
      show("busy", "Connecting to " + p.host + "…");
      try {
        let r: SshCheck = await api.testSshProfile(p, secretArg());
        if (r.hostKeyStatus !== "trusted") {
          const trusted = await trustHostFlow({ host: p.host, port: p.port ?? 22, fingerprint: r.fingerprint, keyType: r.keyType, changed: r.hostKeyStatus === "changed" });
          if (!trusted) {
            show("err", r.hostKeyStatus === "changed" ? "Host key not trusted — connection refused." : "Host key not trusted yet.");
            return;
          }
          show("busy", "Host trusted — authenticating…");
          r = await api.testSshProfile(p, secretArg());
        }
        if (r.hostKeyStatus === "trusted" && r.authenticated) show("ok", `Connected as ${p.user} · ${r.keyType} ${r.fingerprint}`);
        else if (r.hostKeyStatus === "trusted") show("err", "Host key is trusted, but authentication failed. Check the user, key and passphrase.");
        else show("err", "Host key still not trusted.");
      } catch (e) {
        show("err", errMsg(e));
      } finally {
        btnTest.disabled = false;
      }
    };
    btnTest.onclick = () => void runTest();

    if (!isNew) {
      const del = h("button", { class: "btn ghost danger-text", type: "button" }, icon("trash", 14), "Delete");
      del.onclick = async () => {
        if (!(await confirmDialog("Delete SSH configuration?", `“${d.name}” and its saved secret will be removed.`, "Delete", true))) return;
        try {
          await sshStore.remove(d.id);
          select(sshStore.profiles[0]?.id ?? "");
        } catch (e) {
          show("err", errMsg(e));
        }
      };
      shell.footLeft.append(del);
    }
    shell.btnSave.textContent = isNew ? "Create" : "Save";
    shell.btnSave.onclick = async () => {
      const p = collect();
      const bad = problem(p);
      if (bad) return show("err", bad);
      shell.btnSave.disabled = true;
      try {
        const saved = await sshStore.save(p, secretArg());
        toast(`Saved “${saved.name}”`, "ok");
        draft = { ...saved };
        renderEditor();
        renderList();
        opts.onSaved?.(saved);
      } catch (e) {
        show("err", errMsg(e));
      } finally {
        shell.btnSave.disabled = false;
      }
    };

    ed.append(
      h("div", { class: "row2" }, field("Name", inName)),
      h("div", { class: "row2" }, field("Host", inHost), field("Port", inPort, "port")),
      field("User", inUser),
      field("Authentication", h("div", { class: "seg", role: "radiogroup", "aria-label": "SSH authentication" }, btns)),
      keyField,
      secretField,
      agentNote,
      h("details", { class: "vault-adv" }, h("summary", null, icon("chevron", 12), "Advanced"), h("div", { class: "vault-adv-body" }, field("Keep-alive (seconds)", h("div", { class: "vault-stack" }, inKeep, h("span", { class: "vault-hint" }, "Sends a keep-alive this often so idle tunnels aren't dropped. 0 disables it.", ))))),
      h("div", { class: "vault-test" }, btnTest, result),
    );
    sync();
    window.setTimeout(() => (isNew ? inName : inHost).focus(), 30);
  }

  void (async () => {
    await sshStore.load();
    if (opts.create || sshStore.profiles.length === 0) select("");
    else select(opts.select && sshStore.get(opts.select) ? opts.select : sshStore.profiles[0].id);
  })();
}
