// "Import from DataGrip" dialog: paste Copy Settings text or pick .idea/dataSources.xml.
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { parseDataGrip } from "../import/datagrip";
import type { ImportCandidate } from "../import/datagrip";
import { DRIVER_LABELS } from "../types";
import type { ConnectionConfig } from "../types";
import { clear, debounce, errMsg, h, icon } from "./dom";
import { sshStore, sshLabel } from "./sshDialog";
import { store } from "./state";
import { toast } from "./toast";
import { vaults } from "./vault";

type Mode = "paste" | "file";

const SHORT: Record<string, string> = { postgres: "PG", mysql: "MY", sqlite: "SQ", mssql: "MS", redis: "RD", kafka: "KF" };

export function describeTarget(c: ConnectionConfig): string {
  if (c.driver === "sqlite") return c.filePath ?? "";
  const user = c.username ? c.username + "@" : "";
  const port = c.port != null ? ":" + c.port : "";
  const host = c.host && c.host.includes(":") ? `[${c.host}]` : c.host ?? "";
  if (c.driver === "redis" && c.redis?.mode === "sentinel")
    return `${user}sentinel: ${c.redis.masterName || "mymaster"} (${(c.redis.sentinels ?? []).join(", ")}) · db${c.database ?? "0"}${c.sslMode === "require" ? " · TLS" : ""}`;
  if (c.driver === "redis") return `${user}${host}${port} · db${c.database ?? "0"}${c.sslMode === "require" ? " · TLS" : ""}`;
  return `${user}${host}${port}${c.database ? "/" + c.database : ""}`;
}

/** Pure merge used on import: updates keep local-only settings. */
export function mergeForImport(cfg: ConnectionConfig, existing: ConnectionConfig | undefined): ConnectionConfig {
  if (!existing) return { ...cfg, authMethod: "password" };
  const merged: ConnectionConfig = {
    ...cfg,
    color: existing.color,
    readOnly: cfg.readOnly === true ? true : existing.readOnly,
    authMethod: existing.authMethod,
    vault: existing.vault,
    sshProfileId: existing.sshProfileId ?? null,
    folder: existing.folder ?? null,
    scope: existing.scope ?? null,
    // Sentinel setup is DataTrip-only (DataGrip has no Sentinel URL): keep it.
    redis: cfg.redis ?? existing.redis ?? null,
  };
  if (!cfg.username && existing.username) merged.username = existing.username;
  return merged;
}

export function openImportDialog(onImported: (count: number) => void, initialText = ""): void {
  let mode: Mode = "paste";
  let text = initialText;
  let localText: string | undefined;
  let filePath = "";
  let cands: ImportCandidate[] = [];
  const checked = new Set<number>();

  const ta = h("textarea", {
    class: "input import-ta",
    spellcheck: false,
    placeholder: "#DataSourceSettings#\n#LocalDataSource: …\n#BEGIN#\n<data-source …>\n#END#",
    "aria-label": "DataGrip settings text",
  });
  ta.value = initialText;
  const hint = h("div", { class: "import-hint" }, "In DataGrip: select data sources → right-click → Copy Settings, then paste here.");
  const fileName = h("div", { class: "import-file-name" }, "No file chosen");
  const fileErr = h("div", { class: "test-result", "aria-live": "polite" });
  const list = h("div", { class: "import-list", role: "list" });
  const btnImport = h("button", { type: "button", class: "btn primary" }, "Import");
  const btnCancel = h("button", { type: "button", class: "btn ghost" }, "Cancel");
  const btnAll = h("button", { type: "button", class: "btn ghost sm" }, "Select all");

  // ---- apply one Vault profile / SSH configuration to every selected row
  const selVault = h("select", { class: "input", "aria-label": "Vault profile for selected" });
  const selSshImp = h("select", { class: "input", "aria-label": "SSH configuration for selected" });
  const applyRow = h(
    "div",
    { class: "import-apply" },
    h("label", { class: "import-apply-f" }, h("span", { class: "field-label" }, "Vault profile"), selVault),
    h("label", { class: "import-apply-f" }, h("span", { class: "field-label" }, "SSH configuration"), selSshImp),
    h("div", { class: "import-apply-hint" }, "Applied to every selected row. Vault rows keep an empty secret path until you open them — the connection dialog asks for it."),
  );
  applyRow.style.display = "none";
  const fillApply = (): void => {
    clear(selVault);
    selVault.appendChild(h("option", { value: "" }, "Keep as is (password)"));
    for (const p of vaults.profiles) selVault.appendChild(h("option", { value: p.id }, p.name));
    clear(selSshImp);
    selSshImp.appendChild(h("option", { value: "" }, "No tunnel"));
    for (const p of sshStore.profiles) selSshImp.appendChild(h("option", { value: p.id }, `${p.name} — ${sshLabel(p)}`));
    applyRow.style.display = vaults.profiles.length || sshStore.profiles.length ? "" : "none";
  };
  void Promise.all([vaults.ensureLoaded(), sshStore.load()]).then(fillApply);

  const pasteBox = h("div", { class: "import-pane" }, ta, hint);
  const chooseBtn = h(
    "button",
    {
      type: "button",
      class: "btn",
      onclick: async () => {
        fileErr.className = "test-result";
        clear(fileErr);
        try {
          const p = await open({ multiple: false, directory: false, filters: [{ name: "DataGrip data sources", extensions: ["xml"] }] });
          if (typeof p !== "string") return;
          await loadFile(p);
        } catch (e) {
          showFileErr(errMsg(e));
        }
      },
    },
    icon("folder", 14),
    "Choose dataSources.xml…",
  );
  const fileBox = h(
    "div",
    { class: "import-pane" },
    h("div", { class: "row2 tight" }, chooseBtn, fileName),
    h("div", { class: "import-hint" }, "Pick .idea/dataSources.xml from a DataGrip project. If dataSources.local.xml sits next to it, user names are merged in."),
    fileErr,
  );

  const showFileErr = (msg: string): void => {
    fileErr.className = "test-result err";
    clear(fileErr);
    fileErr.append(icon("alert", 15), h("span", null, msg));
  };

  const loadFile = async (p: string): Promise<void> => {
    const t = await api.readTextFile(p);
    const dir = p.replace(/[\\/][^\\/]*$/, "");
    const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
    const base = p.split(/[\\/]/).pop() ?? "";
    const siblingName = /\.local\.xml$/i.test(base) ? "dataSources.xml" : "dataSources.local.xml";
    let sib: string | undefined;
    try {
      sib = await api.readTextFile(dir + sep + siblingName);
    } catch {
      sib = undefined;
    }
    if (/\.local\.xml$/i.test(base)) {
      // picked the local file: it is the "local" half
      text = sib ?? "";
      localText = t;
    } else {
      text = t;
      localText = sib;
    }
    filePath = p;
    fileName.textContent = p.split(/[\\/]/).slice(-3).join("/") + (sib !== undefined ? " (+ " + siblingName + ")" : "");
    fileName.title = p;
    reparse(true);
    if (cands.length === 0) showFileErr("No data sources found in this file.");
  };

  const existingOf = (c: ImportCandidate): ConnectionConfig | undefined => (c.config && c.config.id ? store.conns.get(c.config.id)?.config : undefined);

  const updateFooter = (): void => {
    const n = checked.size;
    btnImport.textContent = `Import (${n})`;
    btnImport.disabled = n === 0;
    const importable = cands.filter((c) => c.config).length;
    btnAll.style.display = importable > 1 ? "" : "none";
    btnAll.textContent = checked.size === importable ? "Select none" : "Select all";
  };

  const chip = (c: ImportCandidate): HTMLElement => {
    if (c.status === "unsupported") return h("span", { class: "import-chip unsupported", title: c.message }, "Unsupported");
    if (c.status === "warning") return h("span", { class: "import-chip warning", title: c.message }, "Warning");
    return existingOf(c) ? h("span", { class: "import-chip update" }, "Updates existing") : h("span", { class: "import-chip new" }, "New");
  };

  const renderList = (): void => {
    clear(list);
    if (cands.length === 0) {
      list.appendChild(
        h(
          "div",
          { class: "import-empty" },
          icon("database", 22),
          h("div", null, (mode === "paste" ? text : text + (localText ?? "")).trim() ? "No DataGrip data sources found." : mode === "paste" ? "Paste settings above to preview them." : "Choose a file to preview its data sources."),
        ),
      );
      updateFooter();
      return;
    }
    cands.forEach((c, i) => {
      const disabled = !c.config;
      const cb = h("input", { type: "checkbox", disabled, checked: checked.has(i), "aria-label": "Import " + c.sourceName });
      cb.addEventListener("change", () => {
        if (cb.checked) checked.add(i);
        else checked.delete(i);
        updateFooter();
      });
      const cfg = c.config;
      const row = h(
        "label",
        { class: "import-row" + (disabled ? " disabled" : ""), role: "listitem" },
        cb,
        h("span", { class: "import-badge " + (cfg?.driver ?? "none"), title: cfg ? DRIVER_LABELS[cfg.driver] : "" }, cfg ? SHORT[cfg.driver] : "?"),
        h(
          "span",
          { class: "import-main" },
          h("span", { class: "import-name" }, c.sourceName),
          h("span", { class: "import-sub" }, cfg ? describeTarget(cfg) : ""),
          c.message ? h("span", { class: "import-msg " + c.status }, c.message) : null,
        ),
        chip(c),
      );
      list.appendChild(row);
    });
    updateFooter();
  };

  const reparse = (_selectAll: boolean): void => {
    try {
      cands = parseDataGrip(text, localText);
    } catch {
      cands = [];
    }
    checked.clear();
    cands.forEach((c, i) => {
      if (c.config) checked.add(i);
    });
    renderList();
  };
  const reparseSoon = debounce(() => reparse(true), 120);
  ta.addEventListener("input", () => {
    text = ta.value;
    localText = undefined;
    reparseSoon();
  });
  btnAll.onclick = () => {
    const importable = cands.map((c, i) => (c.config ? i : -1)).filter((i) => i >= 0);
    if (checked.size === importable.length) checked.clear();
    else importable.forEach((i) => checked.add(i));
    renderList();
  };

  // ---- mode switch
  const segPaste = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => setMode("paste") }, "Paste settings");
  const segFile = h("button", { type: "button", class: "seg-btn", role: "radio", onclick: () => setMode("file") }, "From project file");
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Import source" }, segPaste, segFile);
  const setMode = (m: Mode): void => {
    if (m !== mode) {
      mode = m;
      text = m === "paste" ? ta.value : "";
      localText = undefined;
      filePath = "";
      fileName.textContent = "No file chosen";
      reparse(true);
    }
    segPaste.classList.toggle("on", mode === "paste");
    segFile.classList.toggle("on", mode === "file");
    segPaste.setAttribute("aria-checked", String(mode === "paste"));
    segFile.setAttribute("aria-checked", String(mode === "file"));
    pasteBox.style.display = mode === "paste" ? "" : "none";
    fileBox.style.display = mode === "file" ? "" : "none";
  };

  // ---- import
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
      btnImport.click();
    }
  };
  btnCancel.onclick = close;
  btnImport.onclick = async () => {
    btnImport.disabled = true;
    let ok = 0;
    const failed: string[] = [];
    for (const i of [...checked].sort((a, b) => a - b)) {
      const c = cands[i];
      if (!c.config) continue;
      try {
        const existing = c.config.id ? store.conns.get(c.config.id) : undefined;
        const cfg = mergeForImport(c.config, existing?.config);
        if (selVault.value && cfg.driver !== "sqlite") {
          cfg.authMethod = "vault";
          cfg.vault = { secretPath: cfg.vault?.secretPath ?? "", usernameKey: cfg.vault?.usernameKey ?? null, passwordKey: cfg.vault?.passwordKey ?? null, profileId: selVault.value };
        }
        if (selSshImp.value && cfg.driver !== "sqlite" && cfg.driver !== "kafka") cfg.sshProfileId = selSshImp.value;
        if (existing && existing.status !== "idle") await store.disconnect(cfg.id);
        await api.saveConnection(cfg, null);
        ok++;
      } catch (e) {
        failed.push(`${c.sourceName}: ${errMsg(e)}`);
      }
    }
    try {
      await store.load();
    } catch (e) {
      failed.push(errMsg(e));
    }
    close();
    if (ok > 0) toast(`Imported ${ok} connection${ok === 1 ? "" : "s"}`, "ok");
    if (failed.length) toast(`Could not import ${failed.length}: ${failed[0]}`, "error");
    onImported(ok);
  };

  const dialog = h(
    "div",
    { class: "dialog import-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Import from DataGrip" },
    h(
      "div",
      { class: "dialog-head" },
      h("div", { class: "dialog-title" }, icon("download", 18), "Import from DataGrip"),
      h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: close }, icon("x", 16)),
    ),
    h(
      "div",
      { class: "dialog-body" },
      seg,
      pasteBox,
      fileBox,
      h("div", { class: "import-list-head" }, h("span", { class: "field-label" }, "Data sources"), h("div", { class: "spacer" }), btnAll),
      list,
      applyRow,
    ),
    h(
      "div",
      { class: "dialog-foot import-foot" },
      h("div", { class: "import-note" }, icon("key", 14), h("span", null, "Passwords aren't included in DataGrip exports — you'll be asked for them on first connect.")),
      btnCancel,
      btnImport,
    ),
  );
  overlay.appendChild(dialog);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  setMode("paste");
  reparse(true);
  (initialText ? btnImport : ta).focus();
  void filePath;
}
