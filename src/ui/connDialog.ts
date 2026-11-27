// Connection create/edit dialog.
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { DEFAULT_PORTS, DRIVER_LABELS } from "../types";
import type { AuthMethod, ConnectionConfig, Driver, KafkaConfig, RedisMode, RedisOptions, RedisReadFrom, VaultCheck, VaultConfig, VaultTokenSource } from "../types";
import { handleActionError } from "./recovery";
import { openSshProfilesDialog, sshLabel, sshStore } from "./sshDialog";
import { statusText, statusTone, vaults } from "./vault";
import { openTokenPopover, startOidcSignIn } from "./vaultChips";
import { openVaultProfilesDialog } from "./vaultDialog";
import { clear, errMsg, h, icon } from "./dom";
import { CONN_COLORS, DRIVER_COLORS } from "./sqlutil";
import { DRIVER_ABBR, fillBadge, hasIcon } from "./icons";
import { closeLookPicker, openLookPicker } from "./lookPicker";
import { folderNames } from "./scope";

function fmtLease(secs: number): string {
  if (secs >= 86400 && secs % 86400 === 0) return secs / 86400 + "d";
  if (secs >= 3600) {
    const m = Math.round((secs % 3600) / 60);
    return Math.floor(secs / 3600) + "h" + (m ? " " + m + "m" : "");
  }
  if (secs >= 60) return Math.round(secs / 60) + "m";
  return secs + "s";
}

/** Sentinel address "host", "host:port" or "[v6]:port" → "host:port" (default port 26379); null when invalid. */
export function normSentinel(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  let host: string;
  let port: string | null = null;
  const m6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (m6) {
    host = m6[1];
    port = m6[2] ?? null;
  } else if ((t.match(/:/g) ?? []).length > 1) {
    host = t; // bare IPv6 address
  } else {
    const i = t.lastIndexOf(":");
    host = i >= 0 ? t.slice(0, i) : t;
    port = i >= 0 ? t.slice(i + 1) : null;
  }
  if (!host || /[\s/@?#[\]]/.test(host)) return null;
  if (port !== null && !/^\d+$/.test(port)) return null;
  const n = port === null ? 26379 : Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return (host.includes(":") ? `[${host}]` : host) + ":" + n;
}

const DRIVERS: Driver[] = ["postgres", "mysql", "sqlite", "mssql", "redis", "kafka"];
const KAFKA_PROTOCOLS: [string, string][] = [["plaintext", "PLAINTEXT"], ["ssl", "SSL"], ["sasl_plaintext", "SASL_PLAINTEXT"], ["sasl_ssl", "SASL_SSL"]];
const SASL_MECHANISMS = ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"];

export function openConnectionDialog(existing: ConnectionConfig | null, onSaved: (c: ConnectionConfig) => void): void {
  const editing = existing !== null;
  const cfg: ConnectionConfig = existing
    ? { ...existing }
    : { id: "", name: "", driver: "postgres", host: "localhost", port: 5432, database: "", username: "", sslMode: "prefer", color: CONN_COLORS[0], readOnly: false };
  let driver: Driver = cfg.driver;
  let color: string | null = cfg.color ?? CONN_COLORS[0];
  let iconName: string | null = hasIcon(cfg.icon) ? cfg.icon : null;
  let nameTouched = editing;
  let colorTouched = editing;

  const field = (label: string, input: HTMLElement, cls = ""): HTMLElement =>
    h("label", { class: "field " + cls }, h("span", { class: "field-label" }, label), input);

  const inName = h("input", { class: "input", type: "text", placeholder: "My database", value: cfg.name, oninput: () => (nameTouched = true) });
  const folderList = h("datalist", { id: "dt-folder-options" }, folderNames().map((f) => h("option", { value: f })));
  const inFolder = h("input", { class: "input", type: "text", placeholder: "None", value: cfg.folder ?? "", autocomplete: "off", spellcheck: false, "aria-label": "Folder" });
  inFolder.setAttribute("list", "dt-folder-options");
  const inHost = h("input", { class: "input", type: "text", placeholder: "localhost", value: cfg.host ?? "", spellcheck: false });
  const inPort = h("input", { class: "input", type: "number", min: "1", max: "65535", value: cfg.port != null ? String(cfg.port) : "" });
  const inDb = h("input", { class: "input", type: "text", value: cfg.driver === "redis" ? "" : (cfg.database ?? ""), spellcheck: false });
  const inDbIdx = h("input", { class: "input", type: "number", min: "0", max: "15", step: "1", placeholder: "0", value: cfg.driver === "redis" ? (cfg.database ?? "0") : "0", "aria-label": "Database index" });
  const chkTls = h("input", { type: "checkbox", checked: cfg.driver === "redis" && cfg.sslMode === "require" });
  const inUser = h("input", { class: "input", type: "text", value: cfg.username ?? "", autocomplete: "off", spellcheck: false });
  const inPass = h("input", {
    class: "input",
    type: "password",
    autocomplete: "new-password",
    placeholder: editing ? "Leave blank to keep saved password" : "",
  });
  const chkClear = h("input", { type: "checkbox" });
  const inFile = h("input", { class: "input", type: "text", value: cfg.filePath ?? "", placeholder: "/path/to/database.sqlite", spellcheck: false });
  const SSL_BASIC: [string, string][] = [["disable", "Disable"], ["prefer", "Prefer"], ["require", "Require"]];
  const SSL_FULL: [string, string][] = [...SSL_BASIC, ["verify-ca", "Verify CA"], ["verify-full", "Verify full"]];
  const selSsl = h("select", { class: "input", "aria-label": "SSL mode" });
  const setSslOptions = (full: boolean): void => {
    const cur = selSsl.value || cfg.sslMode || "prefer";
    clear(selSsl);
    for (const [v, l] of full ? SSL_FULL : SSL_BASIC) selSsl.appendChild(h("option", { value: v }, l));
    selSsl.value = (full ? SSL_FULL : SSL_BASIC).some(([v]) => v === cur) ? cur : "prefer";
  };
  setSslOptions(cfg.driver === "postgres" || cfg.driver === "mysql");
  const inSslCa = h("input", { class: "input", type: "text", placeholder: "/path/to/ca.pem", value: cfg.sslCaPath ?? "", spellcheck: false, "aria-label": "CA certificate path" });
  const inSslCert = h("input", { class: "input", type: "text", placeholder: "/path/to/client.pem (optional)", value: cfg.sslCertPath ?? "", spellcheck: false, "aria-label": "Client certificate path" });
  const inSslKey = h("input", { class: "input", type: "text", placeholder: "/path/to/client.key (optional)", value: cfg.sslKeyPath ?? "", spellcheck: false, "aria-label": "Client key path" });
  const chkTrust = h("input", { type: "checkbox", checked: cfg.trustServerCertificate === true });
  const chkRo = h("input", { type: "checkbox", checked: cfg.readOnly === true });
  // ----- Kafka -----
  const k0 = existing?.kafka ?? {};
  let kProtocol = (k0.securityProtocol ?? "plaintext").toLowerCase();
  if (!KAFKA_PROTOCOLS.some(([v]) => v === kProtocol)) kProtocol = "plaintext";
  const selSasl = h("select", { class: "input", "aria-label": "SASL mechanism" }, SASL_MECHANISMS.map((m) => h("option", { value: m }, m)));
  selSasl.value = SASL_MECHANISMS.includes(k0.saslMechanism ?? "") ? (k0.saslMechanism as string) : "PLAIN";
  const inKCa = h("input", { class: "input", type: "text", placeholder: "/path/to/ca.pem", value: k0.caCertPath ?? "", spellcheck: false, "aria-label": "CA certificate path" });
  const inKCert = h("input", { class: "input", type: "text", placeholder: "/path/to/client.pem (optional)", value: k0.clientCertPath ?? "", spellcheck: false, "aria-label": "Client certificate path" });
  const inKKey = h("input", { class: "input", type: "text", placeholder: "/path/to/client.key (optional)", value: k0.clientKeyPath ?? "", spellcheck: false, "aria-label": "Client key path" });
  const chkKSkip = h("input", { type: "checkbox", checked: k0.skipTlsVerify === true });
  const chkKInternal = h("input", { type: "checkbox", checked: k0.showInternal === true });
  const result = h("div", { class: "test-result", "aria-live": "polite" });

  // ----- HashiCorp Vault -----
  const v0: Partial<VaultConfig> = existing?.vault ?? {};
  let authMethod: AuthMethod = cfg.authMethod === "vault" ? "vault" : "password";
  let tokenSource: VaultTokenSource = v0.tokenSource ?? "file";
  let profileDefaulted = editing;
  let vaultProfileId: string | null = v0.profileId ?? null;
  const selVProfile = h("select", { class: "input", "aria-label": "Vault profile" });
  const vSummary = h("div", { class: "vault-summary" });
  const inVAddr = h("input", { class: "input", type: "text", placeholder: "https://vault.example.com:8200", value: v0.address ?? "", spellcheck: false });
  const inVPath = h("input", { class: "input", type: "text", placeholder: "database/creds/readonly", value: v0.secretPath ?? "", spellcheck: false });
  const inVTokenFile = h("input", { class: "input", type: "text", placeholder: "~/.vault-token", value: v0.tokenFile ?? "", spellcheck: false });
  const inVToken = h("input", {
    class: "input",
    type: "password",
    autocomplete: "new-password",
    placeholder: editing && existing?.vault?.tokenSource === "keychain" ? "Leave blank to keep the stored token" : "hvs.…",
  });
  const inVNs = h("input", { class: "input", type: "text", placeholder: "admin/team-a", value: v0.namespace ?? "", spellcheck: false });
  const inVUserKey = h("input", { class: "input", type: "text", placeholder: "username", value: v0.usernameKey ?? "", spellcheck: false });
  const inVPassKey = h("input", { class: "input", type: "text", placeholder: "password", value: v0.passwordKey ?? "", spellcheck: false });
  const inVCa = h("input", { class: "input", type: "text", placeholder: "/path/to/ca.pem", value: v0.caCertPath ?? "", spellcheck: false });
  const chkVSkip = h("input", { type: "checkbox", checked: v0.skipTlsVerify === true });
  const vaultResult = h("div", { class: "test-result vault-result", "aria-live": "polite" });
  const hint = (text: string): HTMLElement => h("span", { class: "vault-hint" }, text);
  const browse = (target: HTMLInputElement, title: string, errEl: HTMLElement = vaultResult): HTMLElement =>
    h(
      "button",
      {
        type: "button",
        class: "btn",
        onclick: async () => {
          try {
            const p = await open({ multiple: false, directory: false, title });
            if (typeof p === "string") target.value = p;
          } catch (e) {
            errEl.className = "test-result err";
            errEl.textContent = errMsg(e);
          }
        },
      },
      icon("folder", 14),
      "Browse…",
    );
  const authBtns = (["password", "vault"] as AuthMethod[]).map((m) => {
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => setAuth(m) }, m === "vault" ? "HashiCorp Vault" : "Password");
    b.dataset.m = m;
    return b;
  });
  const authSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Authentication method" }, authBtns);
  const tokenLabels: Record<VaultTokenSource, string> = { file: "Token file", env: "VAULT_TOKEN env", keychain: "Keychain", oidc: "OIDC" };
  const tokenBtns = (["file", "env", "keychain"] as VaultTokenSource[]).map((t) => {
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => setTokenSource(t) }, tokenLabels[t]);
    b.dataset.t = t;
    return b;
  });
  const tokenSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Vault token source" }, tokenBtns);
  const tokenFilePane = h("div", { class: "row2 tight" }, inVTokenFile, browse(inVTokenFile, "Choose Vault token file"));
  const tokenEnvPane = h("div", { class: "vault-note" }, "Reads VAULT_TOKEN from the environment DataTrip was started in.");
  const tokenKeyPane = h("div", { class: "vault-pane" }, inVToken);
  const btnVault = h("button", { type: "button", class: "btn" }, icon("key", 14), "Test Vault");
  const vAddrField = field("Vault address", h("div", { class: "vault-stack" }, inVAddr, hint("Leave empty to use VAULT_ADDR")));
  const vTokenField = field("Token source", h("div", { class: "vault-stack" }, tokenSeg, tokenFilePane, tokenEnvPane, tokenKeyPane));
  const vCustomA = h("div", { class: "vault-sub" }, field("Namespace", inVNs));
  const vCustomB = h(
    "div",
    { class: "vault-sub" },
    field("CA certificate", h("div", { class: "row2 tight" }, inVCa, browse(inVCa, "Choose CA certificate (PEM)"))),
    h("label", { class: "check" }, chkVSkip, h("span", null, "Skip TLS verification")),
    h("div", { class: "vault-warn" }, icon("alert", 13), "Insecure: the Vault server's identity is not checked. Use a CA certificate instead when you can."),
  );
  const vaultFields = h(
    "div",
    { class: "vault-fields" },
    field("Vault profile", h("div", { class: "vault-stack" }, selVProfile, vSummary)),
    vAddrField,
    field(
      "Secret path",
      h("div", { class: "vault-stack" }, inVPath, hint("KV v2: secret/data/<name> · KV v1: kv/<name> · Dynamic: database/creds/<role>")),
    ),
    vTokenField,
    h(
      "details",
      { class: "vault-adv" },
      h("summary", null, icon("chevron", 12), "Advanced"),
      h(
        "div",
        { class: "vault-adv-body" },
        vCustomA,
        h("div", { class: "row2" }, field("Username key", inVUserKey), field("Password key", inVPassKey)),
        vCustomB,
      ),
    ),
    h("div", { class: "vault-test" }, btnVault, vaultResult),
  );

  // ----- SSH tunnel -----
  const chkSsh = h("input", { type: "checkbox", checked: !!cfg.sshProfileId });
  const selSsh = h("select", { class: "input", "aria-label": "SSH configuration" });
  const sshState = h("span", { class: "ssh-state" });
  const sshKafkaNote = h("div", { class: "vault-note" }, "SSH tunnels aren't supported for Kafka — brokers advertise their own addresses.");
  const sshFields = h(
    "div",
    { class: "vault-sub" },
    h("label", { class: "check" }, chkSsh, h("span", null, "Connect through an SSH tunnel (bastion)")),
    field("SSH configuration", h("div", { class: "vault-stack" }, selSsh, hint("The database host and port are resolved from the SSH server, so use the address as the bastion sees it."))),
  );
  // Redis Sentinel: every node it contacts goes through its own forward.
  const sshSentNote = h("span", { class: "ssh-sent-note" }, "tunnels the sentinels and the master they report");
  const sshSec = h(
    "details",
    { class: "vault-adv ssh-sec", open: !!cfg.sshProfileId },
    h("summary", null, icon("chevron", 12), "SSH tunnel", sshSentNote, sshState),
    h("div", { class: "vault-adv-body" }, sshFields, sshKafkaNote),
  );
  let sshId: string | null = cfg.sshProfileId ?? null;
  const fillSsh = (): void => {
    clear(selSsh);
    selSsh.appendChild(h("option", { value: "" }, sshStore.profiles.length ? "Choose a configuration…" : "No configurations yet"));
    for (const p of sshStore.profiles) selSsh.appendChild(h("option", { value: p.id }, `${p.name} — ${sshLabel(p)}`));
    selSsh.appendChild(h("option", { value: "__new" }, "New SSH configuration…"));
    selSsh.appendChild(h("option", { value: "__manage" }, "Manage…"));
    selSsh.value = sshId && sshStore.get(sshId) ? sshId : "";
    syncSsh();
  };
  const syncSsh = (): void => {
    const kafka = driver === "kafka";
    sshSec.style.display = driver === "sqlite" ? "none" : "";
    sshFields.style.display = kafka ? "none" : "";
    sshKafkaNote.style.display = kafka ? "" : "none";
    selSsh.disabled = !chkSsh.checked;
    const p = sshId ? sshStore.get(sshId) : undefined;
    sshState.textContent = kafka ? "not supported" : chkSsh.checked ? "On" + (p ? " · " + p.name : "") : "Off";
    sshState.classList.toggle("on", chkSsh.checked && !kafka);
  };
  selSsh.addEventListener("change", () => {
    const v = selSsh.value;
    if (v === "__new" || v === "__manage") {
      selSsh.value = sshId && sshStore.get(sshId) ? sshId : "";
      openSshProfilesDialog({
        create: v === "__new",
        select: sshId ?? undefined,
        onSaved: (p) => {
          sshId = p.id;
          chkSsh.checked = true;
          fillSsh();
        },
        onClose: () => void sshStore.load().then(fillSsh),
      });
      return;
    }
    sshId = v || null;
    syncSsh();
  });
  chkSsh.addEventListener("change", () => {
    if (chkSsh.checked && !sshId && sshStore.profiles.length === 1) {
      sshId = sshStore.profiles[0].id;
      selSsh.value = sshId;
    }
    syncSsh();
  });
  void sshStore.load().then(fillSsh);

  // ----- SSL files (PostgreSQL / MySQL) -----
  const sslFiles = h(
    "div",
    { class: "kafka-tls ssl-files" },
    h("div", { class: "kafka-tls-title" }, icon("key", 13), "SSL certificates"),
    field("CA certificate", h("div", { class: "row2 tight" }, inSslCa, browse(inSslCa, "Choose CA certificate (PEM)", result))),
    field("Client certificate", h("div", { class: "row2 tight" }, inSslCert, browse(inSslCert, "Choose client certificate (PEM)", result))),
    field("Client key", h("div", { class: "row2 tight" }, inSslKey, browse(inSslKey, "Choose client key (PEM)", result))),
  );
  const syncSsl = (): void => {
    const sqlLike = driver === "postgres" || driver === "mysql";
    const verify = selSsl.value === "verify-ca" || selSsl.value === "verify-full";
    const filled = inSslCa.value.trim() !== "" || inSslCert.value.trim() !== "" || inSslKey.value.trim() !== "";
    sslFiles.style.display = sqlLike && (verify || filled) ? "" : "none";
  };
  selSsl.addEventListener("change", syncSsl);

  const protoBtns = KAFKA_PROTOCOLS.map(([v, label]) => {
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => setProtocol(v) }, label);
    b.dataset.p = v;
    return b;
  });
  const protoSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Security protocol" }, protoBtns);
  const saslField = field("SASL mechanism", selSasl);
  const kafkaTlsFields = h(
    "div",
    { class: "kafka-tls" },
    h("div", { class: "kafka-tls-title" }, icon("key", 13), "TLS"),
    field("CA certificate", h("div", { class: "row2 tight" }, inKCa, browse(inKCa, "Choose CA certificate (PEM)", result))),
    field("Client certificate", h("div", { class: "row2 tight" }, inKCert, browse(inKCert, "Choose client certificate (PEM)", result))),
    field("Client key", h("div", { class: "row2 tight" }, inKKey, browse(inKKey, "Choose client key (PEM)", result))),
    h("label", { class: "check" }, chkKSkip, h("span", null, "Skip TLS verification")),
    h("div", { class: "vault-warn" }, icon("alert", 13), "Insecure: the brokers' identity is not checked. Use a CA certificate instead when you can."),
  );

  const driverBtns = DRIVERS.map((d) => {
    const b = h(
      "button",
      { type: "button", class: "seg-btn drv", role: "radio", title: DRIVER_LABELS[d], onclick: () => setDriver(d, true) },
      h("span", { class: "drv-badge", style: `--c:${DRIVER_COLORS[d]}`, "aria-hidden": "true" }, DRIVER_ABBR[d]),
      h("span", { class: "drv-name" }, DRIVER_LABELS[d].split(" / ")[0]),
    );
    b.dataset.d = d;
    return b;
  });
  const drivers = h("div", { class: "seg", role: "radiogroup", "aria-label": "Database driver" }, driverBtns);

  const swatches = CONN_COLORS.map((c) => {
    const b = h("button", { type: "button", class: "swatch", title: c, "aria-label": "Color " + c, style: `--c:${c}`, onclick: () => pick(c) });
    b.dataset.c = c;
    return b;
  });
  // Live badge (dialog header + Icon button): the data source's icon on its color.
  const headBadge = h("span", { class: "dlg-badge", "aria-hidden": "true" });
  const lookMini = h("span", { class: "look-mini", "aria-hidden": "true" });
  const lookLabel = h("span", null, "Choose icon…");
  const syncLook = (): void => {
    for (const b of [headBadge, lookMini]) {
      b.style.setProperty("--c", color ?? DRIVER_COLORS[driver] ?? CONN_COLORS[0]);
      fillBadge(b, { driver, icon: iconName }, b === headBadge ? 16 : 13);
    }
    lookLabel.textContent = iconName ?? "Choose icon…";
  };
  const pick = (c: string | null, user = true): void => {
    if (user) colorTouched = true;
    color = c;
    for (const s of swatches) s.classList.toggle("on", s.dataset.c === c);
    syncLook();
  };
  const btnIcon = h(
    "button",
    {
      type: "button",
      class: "look-btn",
      title: "Color & icon…",
      "aria-label": "Choose icon",
      "aria-haspopup": "dialog",
      onclick: () => {
        const r = btnIcon.getBoundingClientRect();
        openLookPicker(
          {
            folder: false,
            driver,
            name: () => inName.value.trim() || "New connection",
            color: () => color,
            icon: () => iconName,
            set: (p) => {
              if (p.icon !== undefined) iconName = p.icon;
              if (p.color !== undefined) pick(p.color);
              else syncLook();
            },
          },
          { x: r.left, y: r.bottom + 8 },
        );
      },
    },
    lookMini,
    lookLabel,
  );

  // ----- Redis Sentinel -----
  const r0: RedisOptions = existing?.redis ?? {};
  let redisMode: RedisMode = r0.mode === "sentinel" ? "sentinel" : "standalone";
  let readFrom: RedisReadFrom = r0.readFrom === "replica" ? "replica" : "master";
  let sentAuth = r0.sentinelAuth === true;
  const sentinels: string[] = (r0.sentinels ?? []).map((s) => normSentinel(s) ?? s);
  /** Per sentinel, from the last test: answered or failed. */
  const sentState = new Map<string, "ok" | "bad">();
  const modeBtns = (["standalone", "sentinel"] as RedisMode[]).map((m) => {
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => setRedisMode(m) }, m === "sentinel" ? "Sentinel" : "Standalone");
    b.dataset.m = m;
    return b;
  });
  const modeField = field("Mode", h("div", { class: "seg redis-mode", role: "radiogroup", "aria-label": "Redis mode" }, modeBtns));
  const inSent = h("input", { class: "sent-input", type: "text", placeholder: "add host:port ↵", spellcheck: false, autocomplete: "off", "aria-label": "Add sentinel" });
  const chipList = h("div", { class: "sent-chip-list" });
  const chipBox = h("div", { class: "sent-chips", onclick: (e: Event) => (e.target === chipBox || e.target === chipList) && inSent.focus() }, chipList, inSent);
  const sentErr = h("div", { class: "sent-err", "aria-live": "polite" });
  const renderChips = (): void => {
    clear(chipList);
    for (const addr of sentinels) {
      const st = sentState.get(addr);
      chipList.appendChild(
        h(
          "span",
          { class: "sent-chip" },
          h("span", { class: "sent-dot" + (st ? " " + st : ""), "aria-hidden": "true" }),
          addr,
          h(
            "button",
            {
              type: "button",
              class: "sent-x",
              title: "Remove",
              "aria-label": "Remove " + addr,
              onclick: () => {
                sentinels.splice(sentinels.indexOf(addr), 1);
                renderChips();
                inSent.focus();
              },
            },
            icon("x", 10),
          ),
        ),
      );
    }
  };
  /** Adds every valid "host[:port]" in `text` (comma / space separated); returns the parts that aren't valid. */
  const addSentinels = (text: string): string[] => {
    const bad: string[] = [];
    for (const part of text.split(/[\s,;]+/)) {
      if (!part) continue;
      const n = normSentinel(part);
      if (n === null) bad.push(part);
      else if (!sentinels.includes(n)) sentinels.push(n);
    }
    renderChips();
    sentErr.textContent = bad.length ? `Not a host:port: ${bad.join(", ")}` : "";
    return bad;
  };
  const flushSentInput = (): boolean => {
    if (inSent.value.trim() === "") return true;
    const bad = addSentinels(inSent.value);
    inSent.value = bad.join(", ");
    return bad.length === 0;
  };
  inSent.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      if (e.metaKey || e.ctrlKey) {
        flushSentInput();
        return; // ⌘↵ still saves
      }
      e.preventDefault();
      flushSentInput();
    } else if (e.key === "Backspace" && inSent.value === "" && sentinels.length) {
      sentinels.pop();
      renderChips();
    }
  });
  inSent.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/[\s,;]/.test(text.trim())) return;
    e.preventDefault();
    inSent.value = addSentinels(inSent.value + " " + text).join(", ");
  });
  inSent.addEventListener("blur", () => void flushSentInput());
  const inMaster = h("input", { class: "input mono", type: "text", placeholder: "mymaster", value: r0.masterName ?? "", spellcheck: false, autocomplete: "off", "aria-label": "Master name" });
  const readBtns = (["master", "replica"] as RedisReadFrom[]).map((r) => {
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => ((readFrom = r), syncRedis()) }, r === "replica" ? "Replica" : "Master");
    b.dataset.r = r;
    return b;
  });
  const swSentAuth = h("button", { class: "sw", type: "button", role: "switch", "aria-label": "Sentinels need their own password", onclick: () => ((sentAuth = !sentAuth), syncRedis()) });
  const inSentUser = h("input", { class: "input", type: "text", placeholder: "default", value: r0.sentinelUsername ?? "", autocomplete: "off", spellcheck: false, "aria-label": "Sentinel username" });
  const inSentPass = h("input", {
    class: "input",
    type: "password",
    autocomplete: "new-password",
    placeholder: editing && r0.sentinelAuth ? "Leave blank to keep saved password" : "",
    "aria-label": "Sentinel password",
  });
  const sentCredRow = h("div", { class: "row2" }, field("Sentinel username (optional)", inSentUser), field("Sentinel password", inSentPass));
  const sentinelFields = h(
    "div",
    { class: "sent-fields" },
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label" }, "Sentinel nodes ", h("span", { class: "sent-sub" }, "· host:port, default port 26379 · paste a comma-separated list")),
      chipBox,
      sentErr,
    ),
    h("div", { class: "row2" }, field("Master name", inMaster), field("Read from", h("div", { class: "seg", role: "radiogroup", "aria-label": "Read from" }, readBtns))),
    h("div", { class: "sent-auth" }, swSentAuth, h("span", null, "Sentinels need their own password ", h("span", { class: "sent-sub" }, "(sentinel requirepass)"))),
    sentCredRow,
  );
  const authTitle = h("div", { class: "sent-auth-title" }, "Master authentication");
  const isSentinel = (): boolean => driver === "redis" && redisMode === "sentinel";
  const setRedisMode = (m: RedisMode): void => {
    redisMode = m;
    sentState.clear();
    result.className = "test-result";
    clear(result);
    syncRedis();
  };
  const syncRedis = (): void => {
    const redis = driver === "redis";
    const sent = isSentinel();
    modeField.style.display = redis ? "" : "none";
    for (const b of modeBtns) {
      const on = b.dataset.m === redisMode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    for (const b of readBtns) {
      const on = b.dataset.r === readFrom;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    swSentAuth.classList.toggle("on", sentAuth);
    swSentAuth.setAttribute("aria-checked", String(sentAuth));
    sentinelFields.style.display = sent ? "" : "none";
    sentCredRow.style.display = sentAuth ? "" : "none";
    hostRow.style.display = sent ? "none" : "";
    authTitle.style.display = sent ? "" : "none";
    sshSentNote.style.display = sent ? "" : "none";
  };
  const collectRedis = (): RedisOptions => ({
    mode: redisMode,
    sentinels: [...sentinels],
    masterName: inMaster.value.trim() || "mymaster",
    readFrom,
    sentinelUsername: sentAuth ? inSentUser.value.trim() || null : null,
    sentinelAuth: sentAuth,
  });
  const sentinelProblem = (): string | null => {
    if (!isSentinel()) return null;
    if (!flushSentInput()) return `Not a valid sentinel address: ${inSent.value}. Use host:port (default port 26379).`;
    if (sentinels.length === 0) return "Add at least one sentinel (host:port, default port 26379).";
    return null;
  };
  /** Sentinel password for save / test: null = keep (or use) the stored one, "" = clear it. */
  const sentinelPasswordArg = (forSave: boolean): string | null => {
    if (driver !== "redis") return null;
    if (!sentAuth) return forSave && editing && r0.sentinelAuth ? "" : null;
    return inSentPass.value === "" ? null : inSentPass.value;
  };
  /** Chip dots from the last test's report (or the error that lists the sentinels). */
  const markSentinels = (lines: string[], err: string | null): void => {
    sentState.clear();
    for (const addr of sentinels) {
      if (lines.some((l) => l.startsWith("✓ " + addr + " answered"))) sentState.set(addr, "ok");
      else if (lines.some((l) => l.startsWith("✕ " + addr + " ")) || (err !== null && err.includes(addr + " ("))) sentState.set(addr, "bad");
    }
    renderChips();
  };
  const renderReport = (lines: string[]): void => {
    const bad = lines.some((l) => l.startsWith("✕") || l.startsWith("!"));
    result.className = "test-result sent-report " + (bad ? "warn" : "ok");
    clear(result);
    result.append(
      ...lines.map((l) => {
        const g = l.charAt(0);
        const cls = g === "✓" ? "ok" : g === "✕" ? "bad" : "note";
        return h("div", { class: "sent-line " + cls }, h("span", { class: "sent-g", "aria-hidden": "true" }, g === "✓" || g === "✕" ? g : "!"), h("span", { class: "sent-text" }, l.slice(2)));
      }),
    );
  };
  renderChips();

  const passField = field("Password", inPass);
  const userLabel = h("span", { class: "field-label" }, "User");
  const userField = h("label", { class: "field" }, userLabel, inUser);
  const dbField = field("Database", inDb);
  const dbIdxField = field("Database index", h("div", { class: "vault-stack" }, inDbIdx, hint("0 – 15, selected when the connection opens")));
  const clearRow = h("label", { class: "check" }, chkClear, h("span", null, "Clear saved password"));
  const authField = field("Authentication", authSeg);
  const hostLabel = h("span", { class: "field-label" }, "Host");
  const hostField = h("label", { class: "field grow" }, hostLabel, inHost);
  const portField = field("Port", inPort, "port");
  const protoField = field("Security protocol", protoSeg);
  const credRow = h("div", { class: "row2" }, userField, passField);
  const hostRow = h("div", { class: "row2" }, hostField, portField);
  const netFields = h(
    "div",
    { class: "net-fields" },
    modeField,
    hostRow,
    sentinelFields,
    protoField,
    saslField,
    dbField,
    dbIdxField,
    authTitle,
    authField,
    credRow,
    editing ? clearRow : null,
  );
  const sslField = field("SSL mode", selSsl);
  const tlsRow = h("label", { class: "check redis-only" }, chkTls, h("span", null, "Use TLS (rediss://)"));
  const internalRow = h("label", { class: "check kafka-only" }, chkKInternal, h("span", null, "Show internal topics"));
  const optionRow = h(
    "div",
    { class: "row2" },
    sslField,
    h(
      "div",
      { class: "checks" },
      h("label", { class: "check mssql-only" }, chkTrust, h("span", null, "Trust server certificate")),
      tlsRow,
      internalRow,
      h("label", { class: "check" }, chkRo, h("span", null, "Read-only connection")),
    ),
  );
  const fileFields = h(
    "div",
    { class: "file-fields" },
    field(
      "Database file",
      h(
        "div",
        { class: "row2 tight" },
        inFile,
        h(
          "button",
          {
            type: "button",
            class: "btn",
            onclick: async () => {
              try {
                const p = await open({ multiple: false, directory: false, title: "Choose SQLite database file" });
                if (typeof p === "string") {
                  inFile.value = p;
                  if (!nameTouched) inName.value = p.split(/[\\/]/).pop() ?? p;
                }
              } catch (e) {
                result.className = "test-result err";
                result.textContent = errMsg(e);
              }
            },
          },
          icon("folder", 14),
          "Browse…",
        ),
      ),
    ),
  );

  const setDriver = (d: Driver, userPick: boolean): void => {
    const oldDefault = DEFAULT_PORTS[driver];
    const cur = inPort.value === "" ? null : Number(inPort.value);
    driver = d;
    syncLook();
    for (const b of driverBtns) {
      const on = b.dataset.d === d;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    const sqlite = d === "sqlite";
    netFields.style.display = sqlite ? "none" : "";
    fileFields.style.display = sqlite ? "" : "none";
    if (userPick && (cur === null || cur === oldDefault)) {
      const np = DEFAULT_PORTS[d];
      inPort.value = np === null ? "" : String(np);
    }
    optionRow.querySelectorAll<HTMLElement>(".mssql-only").forEach((el) => (el.style.display = d === "mssql" ? "" : "none"));
    const redis = d === "redis";
    const kafka = d === "kafka";
    tlsRow.style.display = redis ? "" : "none";
    internalRow.style.display = kafka ? "" : "none";
    sslField.style.display = sqlite || redis || kafka ? "none" : "";
    setSslOptions(d === "postgres" || d === "mysql");
    syncSsl();
    syncSsh();
    dbField.style.display = redis || kafka ? "none" : "";
    dbIdxField.style.display = redis ? "" : "none";
    portField.style.display = kafka ? "none" : "";
    hostLabel.textContent = kafka ? "Bootstrap servers" : "Host";
    inHost.placeholder = kafka ? "broker1:9092,broker2:9092" : "localhost";
    userLabel.textContent = redis ? "ACL user" : "User";
    inUser.placeholder = redis ? "default (optional)" : "";
    if (userPick && !colorTouched) pick(redis ? DRIVER_COLORS.redis : kafka ? DRIVER_COLORS.kafka : CONN_COLORS[0], false);
    syncAuth();
    syncRedis();
  };

  const fillVProfiles = (): void => {
    clear(selVProfile);
    for (const p of vaults.profiles) selVProfile.appendChild(h("option", { value: p.id }, p.name));
    selVProfile.appendChild(h("option", { value: "" }, "Custom (this connection only)"));
    selVProfile.appendChild(h("option", { value: "__manage" }, "Manage profiles…"));
    selVProfile.value = vaultProfileId && vaults.get(vaultProfileId) ? vaultProfileId : "";
    if (selVProfile.value === "") vaultProfileId = null;
  };
  const syncVProfile = (): void => {
    clear(vSummary);
    const p = vaultProfileId ? vaults.get(vaultProfileId) : undefined;
    vSummary.style.display = p ? "" : "none";
    if (!p) return;
    const host = (p.address ?? "").replace(/^https?:\/\//, "");
    const src = p.tokenSource ?? "keychain";
    const tone = src === "keychain" || src === "oidc" ? statusTone(p.id) : "idle";
    const tok = src === "keychain" ? "token " + statusText(p.id) : src === "oidc" ? "OIDC · " + statusText(p.id) : src === "file" ? "token from file" : "token from VAULT_TOKEN";
    const oidcOff = src === "oidc" && vaults.effective(p.id) !== "valid" && vaults.oidcPending !== p.id;
    vSummary.className = "vault-summary " + tone;
    vSummary.append(
      h("span", { class: "vchip-dot", style: `--pc:${p.color ?? "#8e8e93"}` }),
      h("span", { class: "vs-text" }, `${p.name} · ${host.length > 24 ? host.slice(0, 24) + "…" : host || "VAULT_ADDR"} · `, h("span", { class: "vs-tok " + tone }, tok)),
      src === "keychain"
        ? h("button", { class: "btn ghost sm", type: "button", onclick: (e: Event) => openTokenPopover(p.id, e.currentTarget as HTMLElement) }, icon("key", 13), "Paste token")
        : oidcOff
          ? h("button", { class: "btn ghost sm", type: "button", onclick: () => void startOidcSignIn(p.id) }, icon("key", 13), "Sign in")
          : h("span"),
    );
  };
  selVProfile.addEventListener("change", () => {
    if (selVProfile.value === "__manage") {
      selVProfile.value = vaultProfileId ?? "";
      openVaultProfilesDialog({ select: vaultProfileId ?? undefined, onClose: () => { fillVProfiles(); syncAuth(); } });
      return;
    }
    vaultProfileId = selVProfile.value || null;
    syncAuth();
  });
  const unsubVaults = vaults.subscribe(() => syncVProfile());
  void vaults.ensureLoaded().then(() => {
    if (!editing && vaultProfileId === null && vaults.profiles.length && !profileDefaulted) {
      profileDefaulted = true;
      vaultProfileId = vaults.profiles[0].id;
    }
    fillVProfiles();
    syncAuth();
    for (const p of vaults.profiles) if (vaults.state(p.id).status === "unknown") void vaults.lookup(p.id);
  });
  const setProtocol = (p: string): void => {
    kProtocol = p;
    syncAuth();
  };
  const setAuth = (m: AuthMethod): void => {
    authMethod = m;
    syncAuth();
  };
  const setTokenSource = (t: VaultTokenSource): void => {
    tokenSource = t;
    syncAuth();
  };
  const kafkaSasl = (): boolean => driver === "kafka" && kProtocol.startsWith("sasl");
  const kafkaTls = (): boolean => driver === "kafka" && kProtocol.endsWith("ssl");
  const syncAuth = (): void => {
    const sqlite = driver === "sqlite";
    const kafka = driver === "kafka";
    // Kafka only authenticates over SASL: no credentials for PLAINTEXT / SSL.
    const noCreds = kafka && !kafkaSasl();
    const vault = authMethod === "vault" && !sqlite && !noCreds;
    for (const b of protoBtns) {
      const on = b.dataset.p === kProtocol;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    protoField.style.display = kafka ? "" : "none";
    saslField.style.display = kafkaSasl() ? "" : "none";
    kafkaTlsFields.style.display = kafkaTls() ? "" : "none";
    credRow.style.display = noCreds ? "none" : "";
    clearRow.style.display = noCreds ? "none" : clearRow.style.display;
    for (const b of authBtns) {
      const on = b.dataset.m === authMethod;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    for (const b of tokenBtns) {
      const on = b.dataset.t === tokenSource;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    authField.style.display = sqlite || noCreds ? "none" : "";
    passField.style.display = vault ? "none" : "";
    clearRow.style.display = vault || noCreds ? "none" : "";
    vaultFields.style.display = vault ? "" : "none";
    const prof = vaultProfileId ? vaults.get(vaultProfileId) : undefined;
    vAddrField.style.display = prof ? "none" : "";
    vTokenField.style.display = prof ? "none" : "";
    vCustomA.style.display = prof ? "none" : "";
    vCustomB.style.display = prof ? "none" : "";
    syncVProfile();
    tokenFilePane.style.display = tokenSource === "file" ? "" : "none";
    tokenEnvPane.style.display = tokenSource === "env" ? "" : "none";
    tokenKeyPane.style.display = tokenSource === "keychain" ? "" : "none";
    inUser.placeholder = vault ? "Fallback if the secret has no username" : driver === "redis" ? "default (optional)" : "";
    userLabel.textContent = driver === "redis" ? "ACL user" : "User";
  };

  /** Redis database index from the field: an integer 0–15, or null when it is not valid. */
  const redisIndex = (): number | null => {
    const t = inDbIdx.value.trim();
    if (t === "") return 0;
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= 15 ? n : null;
  };
  const collect = (): ConnectionConfig => {
    const sqlite = driver === "sqlite";
    const kafka = driver === "kafka";
    const port = kafka ? null : inPort.value.trim() === "" ? null : Number(inPort.value);
    const vault = authMethod === "vault" && !sqlite && !(kafka && !kafkaSasl());
    return {
      id: cfg.id,
      name: inName.value.trim() || (sqlite ? inFile.value.split(/[\\/]/).pop() || "SQLite" : isSentinel() ? "Redis " + (inMaster.value.trim() || "mymaster") : inHost.value.trim() || DRIVER_LABELS[driver]),
      driver,
      host: sqlite ? null : kafka ? inHost.value.replace(/\s+/g, "") || null : inHost.value.trim() || null,
      port: sqlite ? null : port,
      database: sqlite || kafka ? null : driver === "redis" ? String(redisIndex() ?? 0) : inDb.value.trim() || null,
      username: sqlite || (kafka && !kafkaSasl()) ? null : inUser.value.trim() || null,
      filePath: sqlite ? inFile.value.trim() || null : null,
      sslMode: sqlite || kafka ? null : driver === "redis" ? (chkTls.checked ? "require" : "disable") : (selSsl.value as ConnectionConfig["sslMode"]),
      sslCaPath: sslShown() ? inSslCa.value.trim() || null : null,
      sslCertPath: sslShown() ? inSslCert.value.trim() || null : null,
      sslKeyPath: sslShown() ? inSslKey.value.trim() || null : null,
      sshProfileId: sqlite || kafka || !chkSsh.checked ? null : sshId,
      trustServerCertificate: driver === "mssql" ? chkTrust.checked : false,
      color,
      icon: iconName,
      readOnly: chkRo.checked,
      authMethod: vault ? "vault" : "password",
      vault: vault ? collectVault() : null,
      folder: inFolder.value.trim() || null,
      scope: cfg.scope ?? null,
      kafka: kafka ? collectKafka() : null,
      redis: driver === "redis" ? collectRedis() : null,
    };
  };
  const sslShown = (): boolean => (driver === "postgres" || driver === "mysql") && sslFiles.style.display !== "none";
  const collectKafka = (): KafkaConfig => ({
    securityProtocol: kProtocol,
    saslMechanism: kafkaSasl() ? selSasl.value : null,
    caCertPath: kafkaTls() ? inKCa.value.trim() || null : null,
    clientCertPath: kafkaTls() ? inKCert.value.trim() || null : null,
    clientKeyPath: kafkaTls() ? inKKey.value.trim() || null : null,
    skipTlsVerify: kafkaTls() && chkKSkip.checked,
    showInternal: chkKInternal.checked,
  });
  const collectVault = (): VaultConfig =>
    vaultProfileId
      ? {
          profileId: vaultProfileId,
          secretPath: inVPath.value.trim(),
          usernameKey: inVUserKey.value.trim() || null,
          passwordKey: inVPassKey.value.trim() || null,
        }
      : collectVaultCustom();
  const collectVaultCustom = (): VaultConfig => ({
    profileId: null,
    address: inVAddr.value.trim() || null,
    namespace: inVNs.value.trim() || null,
    tokenSource,
    tokenFile: inVTokenFile.value.trim() || null,
    secretPath: inVPath.value.trim(),
    usernameKey: inVUserKey.value.trim() || null,
    passwordKey: inVPassKey.value.trim() || null,
    caCertPath: inVCa.value.trim() || null,
    skipTlsVerify: chkVSkip.checked,
  });
  const isVault = (): boolean => authMethod === "vault" && driver !== "sqlite" && !(driver === "kafka" && !kafkaSasl());
  /** Token typed for the keychain source (null = none typed). */
  const typedToken = (): string | null => (isVault() && !vaultProfileId && tokenSource === "keychain" && inVToken.value.trim() !== "" ? inVToken.value.trim() : null);
  const vaultProblem = (): string | null => (isVault() && inVPath.value.trim() === "" ? "Enter the Vault secret path." : null);
  const kafkaProblem = (): string | null => {
    if (driver !== "kafka") return null;
    if (inHost.value.replace(/[\s,]/g, "") === "") return "Enter at least one bootstrap server, e.g. broker1:9092.";
    if (kafkaTls() && inKCert.value.trim() !== "" && inKKey.value.trim() === "") return "A client certificate needs its private key.";
    return null;
  };
  const sslProblem = (): string | null => (sslShown() && inSslCert.value.trim() !== "" && inSslKey.value.trim() === "" ? "A client certificate needs its private key." : null);
  const sshProblem = (): string | null => (driver !== "sqlite" && driver !== "kafka" && chkSsh.checked && !sshId ? "Choose an SSH configuration for the tunnel (or turn the tunnel off)." : null);
  const formProblem = (): string | null =>
    driver === "redis" && redisIndex() === null ? "Database index must be a whole number from 0 to 15." : sentinelProblem() ?? kafkaProblem() ?? vaultProblem() ?? sslProblem() ?? sshProblem();
  const showErr = (el: HTMLElement, msg: string): void => {
    el.className = el.className.replace(/\b(ok|err|busy)\b/g, "").trim() + " err";
    clear(el);
    el.append(icon("alert", 15), h("span", null, msg));
  };
  const passwordArg = (): string | null => {
    if (driver === "sqlite" || isVault() || (driver === "kafka" && !kafkaSasl())) return null;
    if (chkClear.checked && inPass.value === "") return "";
    if (inPass.value === "") return editing ? null : "";
    return inPass.value;
  };

  const btnTest = h("button", { type: "button", class: "btn" }, icon("plug", 14), "Test connection");
  const btnSave = h("button", { type: "button", class: "btn primary" }, "Save");
  const btnCancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");

  const overlay = h("div", { class: "overlay" });
  const close = (): void => {
    closeLookPicker();
    overlay.classList.add("leaving");
    window.removeEventListener("keydown", onKey, true);
    unsubVaults();
    window.setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e: KeyboardEvent): void => {
    // A dialog opened on top (SSH / Vault manager, confirm…) owns the keyboard.
    const open = document.querySelectorAll(".overlay:not(.leaving)");
    if (open[open.length - 1] !== overlay) return;
    if (e.key === "Escape" && document.querySelector(".look-pop")) return; // the picker closes first
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      btnSave.click();
    }
  };

  btnCancel.onclick = close;
  const runTest = async (): Promise<void> => {
    const problem = formProblem();
    if (problem) return showErr(result, problem);
    btnTest.disabled = true;
    result.className = "test-result busy";
    result.textContent = "Connecting…";
    try {
      const info = await api.testConnection(collect(), passwordArg(), typedToken(), sentinelPasswordArg(false));
      if (isSentinel() && info.details?.length) {
        markSentinels(info.details, null);
        const ver = info.version && info.version !== "Redis" ? " \u00b7 Redis " + info.version : "";
        renderReport([...info.details.slice(0, -1), info.details[info.details.length - 1] + ver]);
      } else {
        result.className = "test-result ok";
        clear(result);
        result.append(icon("check", 15), h("span", null, "Connected — " + info.version));
      }
    } catch (e) {
      if (isSentinel()) markSentinels([], errMsg(e));
      result.className = "test-result err";
      clear(result);
      result.append(icon("alert", 15), h("span", null, errMsg(e)));
      // Expired Vault token / unknown SSH host: fix inline and run the test again.
      handleActionError(e, runTest);
    } finally {
      btnTest.disabled = false;
    }
  };
  btnTest.onclick = () => void runTest();
  const describeVault = (r: VaultCheck): string => {
    const kind = r.secretKind === "dynamic" ? "dynamic credentials" : r.secretKind + " secret";
    const parts = [kind, r.username ? "user " + r.username : "no username in secret"];
    if (r.secretKind === "dynamic" && r.leaseDurationSecs) parts.push("lease " + fmtLease(r.leaseDurationSecs));
    return parts.join(" · ");
  };
  const runVaultTest = async (): Promise<void> => {
    const problem = vaultProblem();
    if (problem) return showErr(vaultResult, problem);
    btnVault.disabled = true;
    vaultResult.className = "test-result vault-result busy";
    vaultResult.textContent = "Contacting Vault…";
    try {
      const r = await api.testVault(collect(), typedToken());
      vaultResult.className = "test-result vault-result ok";
      clear(vaultResult);
      vaultResult.append(icon("check", 15), h("span", null, describeVault(r)));
    } catch (e) {
      showErr(vaultResult, errMsg(e));
      handleActionError(e, runVaultTest);
    } finally {
      btnVault.disabled = false;
    }
  };
  btnVault.onclick = () => void runVaultTest();
  btnSave.onclick = async () => {
    const problem = formProblem();
    if (problem) return showErr(result, problem);
    btnSave.disabled = true;
    try {
      const saved = await api.saveConnection(collect(), passwordArg(), sentinelPasswordArg(true));
      const tok = typedToken();
      if (tok !== null) await api.setVaultToken(saved.id, tok);
      close();
      onSaved(saved);
    } catch (e) {
      result.className = "test-result err";
      clear(result);
      result.append(icon("alert", 15), h("span", null, errMsg(e)));
      btnSave.disabled = false;
    }
  };

  const dialog = h(
    "div",
    { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": editing ? "Edit connection" : "New connection" },
    h(
      "div",
      { class: "dialog-head" },
      h("div", { class: "dialog-title" }, headBadge, editing ? "Edit connection" : "New connection"),
      h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: close }, icon("x", 16)),
    ),
    h(
      "div",
      { class: "dialog-body" },
      field("Driver", drivers),
      h("div", { class: "row2" }, field("Name", inName), field("Folder", h("div", { class: "folder-combo" }, inFolder, folderList))),
      netFields,
      vaultFields,
      sshSec,
      kafkaTlsFields,
      fileFields,
      optionRow,
      sslFiles,
      field("Color", h("div", { class: "swatches" }, swatches)),
      field("Icon", btnIcon),
      result,
    ),
    h("div", { class: "dialog-foot" }, btnTest, h("div", { class: "spacer" }), btnCancel, btnSave),
  );
  overlay.appendChild(dialog);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  fillVProfiles();
  setDriver(driver, false);
  pick(color, false);
  for (const i of [inSslCa, inSslCert, inSslKey]) i.addEventListener("input", syncSsl);
  if (editing && authMethod === "vault" && vaultProfileId && !inVPath.value.trim()) {
    vaultResult.className = "test-result vault-result busy";
    vaultResult.textContent = "This connection has no Vault secret path yet — enter where its credentials live.";
    window.setTimeout(() => inVPath.focus(), 50);
  }
  (driver === "sqlite" ? inFile : inName).focus();
}
