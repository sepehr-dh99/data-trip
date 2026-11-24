// Connection create/edit dialog.
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { DEFAULT_PORTS, DRIVER_LABELS } from "../types";
import type { ConnectionConfig, Driver } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { CONN_COLORS } from "./sqlutil";

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

  const netFields = h(
    "div",
    { class: "net-fields" },
    h("div", { class: "row2" }, field("Host", inHost, "grow"), field("Port", inPort, "port")),
    field("Database", inDb),
    h("div", { class: "row2" }, field("User", inUser), field("Password", inPass)),
    editing ? h("label", { class: "check" }, chkClear, h("span", null, "Clear saved password")) : null,
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
  };

  const collect = (): ConnectionConfig => {
    const sqlite = driver === "sqlite";
    const port = inPort.value.trim() === "" ? null : Number(inPort.value);
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
    };
  };
  const passwordArg = (): string | null => {
    if (driver === "sqlite") return null;
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
    btnTest.disabled = true;
    result.className = "test-result busy";
    result.textContent = "Connecting…";
    try {
      const info = await api.testConnection(collect(), passwordArg());
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
  btnSave.onclick = async () => {
    btnSave.disabled = true;
    try {
      const saved = await api.saveConnection(collect(), passwordArg());
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
