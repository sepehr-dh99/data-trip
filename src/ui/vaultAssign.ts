// Assigning a shared Vault profile to many connections (profile manager "Assign to…", folder menu).
import type { ConnectionConfig } from "../types";
import { clear, errMsg, h, icon } from "./dom";
import { promptDialog } from "./prompt";
import { updateConfig } from "./scope";
import { store } from "./state";
import { toast } from "./toast";
import { vaults } from "./vault";

export function usersOf(profileId: string): ConnectionConfig[] {
  return store.list().map((e) => e.config).filter((c) => c.authMethod === "vault" && c.vault?.profileId === profileId);
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Applies (or, with null, removes) a Vault profile on the given connections. Each connection keeps its secret
 * path; when some have none yet, asks once for a default pattern ("database/creds/{name}").
 */
export async function assignVaultProfile(profileId: string | null, ids: string[]): Promise<number> {
  const cfgs = ids.map((id) => store.conns.get(id)?.config).filter((c): c is ConnectionConfig => !!c && c.driver !== "sqlite");
  if (cfgs.length === 0) return 0;
  if (profileId === null) {
    const using = cfgs.filter((c) => c.authMethod === "vault" && c.vault?.profileId);
    for (const c of using) await updateConfig(c.id, { authMethod: "password", vault: null });
    store.emit();
    return using.length;
  }
  const missing = cfgs.filter((c) => !c.vault?.secretPath?.trim());
  let pattern: string | null = null;
  if (missing.length > 0) {
    pattern = await promptDialog(
      "Default secret path",
      `${missing.length} connection${missing.length === 1 ? " has" : "s have"} no Vault secret path yet`,
      "database/creds/{name}",
      "Apply",
      [],
      { icon: "key", hint: "{name} becomes the connection name in lower-case (asia32-staging). Leave empty to fill it in later." },
    ).catch(() => null);
  }
  for (const c of cfgs) {
    const have = c.vault?.secretPath?.trim() ?? "";
    const secretPath = have || (pattern ? pattern.replace(/\{name\}/g, slug(c.name)) : "");
    await updateConfig(c.id, {
      authMethod: "vault",
      vault: { ...(c.vault ?? {}), secretPath, profileId, tokenSource: undefined, address: null, namespace: null, tokenFile: null },
    });
  }
  store.emit();
  return cfgs.length;
}

/** "Assign to…" picker: checkbox list of connections grouped by folder. */
export function openAssignDialog(profileId: string, onDone?: () => void): void {
  const profile = vaults.get(profileId);
  if (!profile) return;
  const entries = store.list().filter((e) => e.config.driver !== "sqlite");
  const picked = new Set<string>();
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    const k = e.config.folder?.trim() || "";
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const body = h("div", { class: "assign-list" });
  const btnApply = h("button", { class: "btn primary", type: "button" }, "Assign");
  const sync = (): void => {
    btnApply.textContent = picked.size ? `Assign to ${picked.size}` : "Assign";
    btnApply.disabled = picked.size === 0;
  };
  const folders = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  for (const f of folders) {
    const list = groups.get(f)!;
    const selectable = list.filter((e) => e.config.vault?.profileId !== profileId || e.config.authMethod !== "vault");
    const gcb = h("input", { type: "checkbox", "aria-label": "Select all in " + (f || "No folder") });
    const rows: HTMLInputElement[] = [];
    gcb.addEventListener("change", () => {
      for (const r of rows) {
        r.checked = gcb.checked;
        r.dispatchEvent(new Event("change"));
      }
    });
    body.appendChild(h("label", { class: "assign-folder" }, selectable.length ? gcb : h("span", { style: "width:16px" }), icon("folder", 14), h("span", null, f || "No folder"), h("span", { class: "assign-n" }, String(list.length))));
    for (const e of list) {
      const already = e.config.authMethod === "vault" && e.config.vault?.profileId === profileId;
      const other = e.config.authMethod === "vault" && e.config.vault?.profileId && !already ? vaults.get(e.config.vault.profileId)?.name : null;
      const cb = h("input", { type: "checkbox", checked: already, disabled: already, "aria-label": e.config.name });
      if (!already) {
        rows.push(cb);
        cb.addEventListener("change", () => {
          if (cb.checked) picked.add(e.config.id);
          else picked.delete(e.config.id);
          sync();
        });
      }
      body.appendChild(
        h(
          "label",
          { class: "assign-row" + (already ? " done" : "") },
          cb,
          h("span", { class: "assign-dot", style: `--c:${e.config.color ?? "#8e8e93"}` }),
          h("span", { class: "assign-name" }, e.config.name),
          already ? h("span", { class: "assign-tag" }, "assigned") : other ? h("span", { class: "assign-tag other" }, "uses " + other) : e.config.vault?.secretPath ? null : h("span", { class: "assign-tag warn" }, "no secret path"),
        ),
      );
    }
  }
  if (entries.length === 0) body.appendChild(h("div", { class: "import-empty" }, "No connections yet."));

  const overlay = h("div", { class: "overlay" });
  const close = (): void => {
    window.removeEventListener("keydown", onKey, true);
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  btnApply.onclick = async () => {
    btnApply.disabled = true;
    try {
      const n = await assignVaultProfile(profileId, [...picked]);
      close();
      toast(`${profile.name} applied to ${n} connection${n === 1 ? "" : "s"}`, "ok");
      onDone?.();
    } catch (e) {
      toast(errMsg(e), "error");
      btnApply.disabled = false;
    }
  };
  clear(overlay);
  overlay.appendChild(
    h(
      "div",
      { class: "dialog assign-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Assign Vault profile" },
      h(
        "div",
        { class: "dialog-head" },
        h("div", { class: "dialog-title" }, icon("key", 18), `Assign “${profile.name}” to…`),
        h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", onclick: close }, icon("x", 16)),
      ),
      h("div", { class: "dialog-body" }, h("div", { class: "vault-hint" }, "Switches the checked connections to HashiCorp Vault with this profile. Each keeps its own secret path."), body),
      h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"), btnApply),
    ),
  );
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  sync();
}
