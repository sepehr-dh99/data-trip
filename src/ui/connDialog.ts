// Connection create/edit dialog.
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { DEFAULT_PORTS, DRIVER_LABELS } from "../types";
import type { AuthMethod, ConnectionConfig, Driver, VaultCheck, VaultConfig, VaultTokenSource } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { CONN_COLORS } from "./sqlutil";

function fmtLease(secs: number): string {
  if (secs >= 86400 && secs % 86400 === 0) return secs / 86400 + "d";
  if (secs >= 3600) {
    const m = Math.round((secs % 3600) / 60);
    return Math.floor(secs / 3600) + "h" + (m ? " " + m + "m" : "");
  }
  if (secs >= 60) return Math.round(secs / 60) + "m";
  return secs + "s";
}

const DRIVERS: Driver[] = ["postgres", "mysql", "sqlite", "mssql"];

export function openConnectionDialog(existing: ConnectionConfig | null, onSaved: (c: ConnectionConfig) => void): void {
  const editing = existing !== null;
  const cfg: ConnectionConfig = existing
    ? { ...existing }
    : { id: "", name: "", driver: "postgres", host: "localhost", port: 5432, database: "", username: "", sslMode: "prefer", color: CONN_COLORS[0], readOnly: false };
  let driver: Driver = cfg.driver;
  let color = cfg.color ?? CONN_COLORS[0];
  let nameTouched = editing;

  const field = (label: string, input: HTMLElement, cls = ""): HTMLElement =>
    h("label", { class: "field " + cls }, h("span", { class: "field-label" }, label), input);

  const inName = h("input", { class: "input", type: "text", placeholder: "My database", value: cfg.name, oninput: () => (nameTouched = true) });
  const inHost = h("input", { class: "input", type: "text", placeholder: "localhost", value: cfg.host ?? "", spellcheck: false });
  const inPort = h("input", { class: "input", type: "number", min: "1", max: "65535", value: cfg.port != null ? String(cfg.port) : "" });
  const inDb = h("input", { class: "input", type: "text", value: cfg.database ?? "", spellcheck: false });
  const inUser = h("input", { class: "input", type: "text", value: cfg.username ?? "", autocomplete: "off", spellcheck: false });
  const inPass = h("input", {
    class: "input",
    type: "password",
    autocomplete: "new-password",
    placeholder: editing ? "Leave blank to keep saved password" : "",
  });
  const chkClear = h("input", { type: "checkbox" });
  const inFile = h("input", { class: "input", type: "text", value: cfg.filePath ?? "", placeholder: "/path/to/database.sqlite", spellcheck: false });
  const selSsl = h(
    "select",
    { class: "input" },
    h("option", { value: "disable" }, "Disable"),
    h("option", { value: "prefer" }, "Prefer"),
    h("option", { value: "require" }, "Require"),
  );
  selSsl.value = cfg.sslMode ?? "prefer";
  const chkTrust = h("input", { type: "checkbox", checked: cfg.trustServerCertificate === true });
  const chkRo = h("input", { type: "checkbox", checked: cfg.readOnly === true });
  const result = h("div", { class: "test-result", "aria-live": "polite" });

  // ----- HashiCorp Vault -----
  const v0: Partial<VaultConfig> = existing?.vault ?? {};
  let authMethod: AuthMethod = cfg.authMethod === "vault" ? "vault" : "password";
  let tokenSource: VaultTokenSource = v0.tokenSource ?? "file";
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
  const browse = (target: HTMLInputElement, title: string): HTMLElement =>
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
            vaultResult.className = "test-result vault-result err";
            vaultResult.textContent = errMsg(e);
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
  const tokenLabels: Record<VaultTokenSource, string> = { file: "Token file", env: "VAULT_TOKEN env", keychain: "Keychain" };
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
  const vaultFields = h(
    "div",
    { class: "vault-fields" },
    field("Vault address", h("div", { class: "vault-stack" }, inVAddr, hint("Leave empty to use VAULT_ADDR"))),
    field(
      "Secret path",
      h("div", { class: "vault-stack" }, inVPath, hint("KV v2: secret/data/<name> · KV v1: kv/<name> · Dynamic: database/creds/<role>")),
    ),
    field("Token source", h("div", { class: "vault-stack" }, tokenSeg, tokenFilePane, tokenEnvPane, tokenKeyPane)),
    h(
      "details",
      { class: "vault-adv" },
      h("summary", null, icon("chevron", 12), "Advanced"),
      h(
        "div",
        { class: "vault-adv-body" },
        field("Namespace", inVNs),
        h("div", { class: "row2" }, field("Username key", inVUserKey), field("Password key", inVPassKey)),
        field("CA certificate", h("div", { class: "row2 tight" }, inVCa, browse(inVCa, "Choose CA certificate (PEM)"))),
        h("label", { class: "check" }, chkVSkip, h("span", null, "Skip TLS verification")),
        h("div", { class: "vault-warn" }, icon("alert", 13), "Insecure: the Vault server's identity is not checked. Use a CA certificate instead when you can."),
      ),
    ),
    h("div", { class: "vault-test" }, btnVault, vaultResult),
  );

  const driverBtns = DRIVERS.map((d) => {
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => setDriver(d, true) }, DRIVER_LABELS[d]);
    b.dataset.d = d;
    return b;
  });
  const drivers = h("div", { class: "seg", role: "radiogroup", "aria-label": "Database driver" }, driverBtns);

  const swatches = CONN_COLORS.map((c) => {
    const b = h("button", { type: "button", class: "swatch", title: c, "aria-label": "Color " + c, style: `--c:${c}`, onclick: () => pick(c) });
    b.dataset.c = c;
    return b;
  });
  const pick = (c: string): void => {
    color = c;
    for (const s of swatches) s.classList.toggle("on", s.dataset.c === c);
  };

  const passField = field("Password", inPass);
  const clearRow = h("label", { class: "check" }, chkClear, h("span", null, "Clear saved password"));
  const authField = field("Authentication", authSeg);
  const netFields = h(
    "div",
    { class: "net-fields" },
    h("div", { class: "row2" }, field("Host", inHost, "grow"), field("Port", inPort, "port")),
    field("Database", inDb),
    authField,
    h("div", { class: "row2" }, field("User", inUser), passField),
    editing ? clearRow : null,
  );
  const sslField = field("SSL mode", selSsl);
  const optionRow = h(
    "div",
    { class: "row2" },
    sslField,
    h(
      "div",
      { class: "checks" },
      h("label", { class: "check mssql-only" }, chkTrust, h("span", null, "Trust server certificate")),
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
    sslField.style.display = sqlite ? "none" : "";
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
  const syncAuth = (): void => {
    const sqlite = driver === "sqlite";
    const vault = authMethod === "vault" && !sqlite;
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
    authField.style.display = sqlite ? "none" : "";
    passField.style.display = vault ? "none" : "";
    clearRow.style.display = vault ? "none" : "";
    vaultFields.style.display = vault ? "" : "none";
    tokenFilePane.style.display = tokenSource === "file" ? "" : "none";
    tokenEnvPane.style.display = tokenSource === "env" ? "" : "none";
    tokenKeyPane.style.display = tokenSource === "keychain" ? "" : "none";
    inUser.placeholder = vault ? "Fallback if the secret has no username" : "";
  };

  const collect = (): ConnectionConfig => {
    const sqlite = driver === "sqlite";
    const port = inPort.value.trim() === "" ? null : Number(inPort.value);
    const vault = authMethod === "vault" && !sqlite;
    return {
      id: cfg.id,
      name: inName.value.trim() || (sqlite ? inFile.value.split(/[\\/]/).pop() || "SQLite" : inHost.value.trim() || DRIVER_LABELS[driver]),
      driver,
      host: sqlite ? null : inHost.value.trim() || null,
      port: sqlite ? null : port,
      database: sqlite ? null : inDb.value.trim() || null,
      username: sqlite ? null : inUser.value.trim() || null,
      filePath: sqlite ? inFile.value.trim() || null : null,
      sslMode: sqlite ? null : (selSsl.value as "disable" | "prefer" | "require"),
      trustServerCertificate: driver === "mssql" ? chkTrust.checked : false,
      color,
      readOnly: chkRo.checked,
      authMethod: vault ? "vault" : "password",
      vault: vault ? collectVault() : null,
    };
  };
  const collectVault = (): VaultConfig => ({
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
  const isVault = (): boolean => authMethod === "vault" && driver !== "sqlite";
  /** Token typed for the keychain source (null = none typed). */
  const typedToken = (): string | null => (isVault() && tokenSource === "keychain" && inVToken.value.trim() !== "" ? inVToken.value.trim() : null);
  const vaultProblem = (): string | null => (isVault() && inVPath.value.trim() === "" ? "Enter the Vault secret path." : null);
  const showErr = (el: HTMLElement, msg: string): void => {
    el.className = el.className.replace(/\b(ok|err|busy)\b/g, "").trim() + " err";
    clear(el);
    el.append(icon("alert", 15), h("span", null, msg));
  };
  const passwordArg = (): string | null => {
    if (driver === "sqlite" || isVault()) return null;
    if (chkClear.checked && inPass.value === "") return "";
    if (inPass.value === "") return editing ? null : "";
    return inPass.value;
  };

  const btnTest = h("button", { type: "button", class: "btn" }, icon("plug", 14), "Test connection");
  const btnSave = h("button", { type: "button", class: "btn primary" }, "Save");
  const btnCancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");

  const overlay = h("div", { class: "overlay" });
  const close = (): void => {
    overlay.classList.add("leaving");
    window.removeEventListener("keydown", onKey, true);
    window.setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      btnSave.click();
    }
  };

  btnCancel.onclick = close;
  btnTest.onclick = async () => {
    const problem = vaultProblem();
    if (problem) return showErr(result, problem);
    btnTest.disabled = true;
    result.className = "test-result busy";
    result.textContent = "Connecting…";
    try {
      const info = await api.testConnection(collect(), passwordArg(), typedToken());
      result.className = "test-result ok";
      clear(result);
      result.append(icon("check", 15), h("span", null, "Connected — " + info.version));
    } catch (e) {
      result.className = "test-result err";
      clear(result);
      result.append(icon("alert", 15), h("span", null, errMsg(e)));
    } finally {
      btnTest.disabled = false;
    }
  };
  const describeVault = (r: VaultCheck): string => {
    const kind = r.secretKind === "dynamic" ? "dynamic credentials" : r.secretKind + " secret";
    const parts = [kind, r.username ? "user " + r.username : "no username in secret"];
    if (r.secretKind === "dynamic" && r.leaseDurationSecs) parts.push("lease " + fmtLease(r.leaseDurationSecs));
    return parts.join(" · ");
  };
  btnVault.onclick = async () => {
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
    } finally {
      btnVault.disabled = false;
    }
  };
  btnSave.onclick = async () => {
    const problem = vaultProblem();
    if (problem) return showErr(result, problem);
    btnSave.disabled = true;
    try {
      const saved = await api.saveConnection(collect(), passwordArg());
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
      h("div", { class: "dialog-title" }, icon("database", 18), editing ? "Edit connection" : "New connection"),
      h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: close }, icon("x", 16)),
    ),
    h(
      "div",
      { class: "dialog-body" },
      field("Driver", drivers),
      field("Name", inName),
      netFields,
      vaultFields,
      fileFields,
      optionRow,
      field("Color", h("div", { class: "swatches" }, swatches)),
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
  setDriver(driver, false);
  pick(color);
  (driver === "sqlite" ? inFile : inName).focus();
}
