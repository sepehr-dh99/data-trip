// v0.16 entry points: Show DDL (⌥⌘D), New table… / Edit table… (designer) and Import data… — from the explorer's
// context menus, the command palette and the app menu.
import { DdlPane } from "./ddlPane";
import { DesignerPane } from "./designerPane";
import { openImportWizard } from "./importWizard";
import type { DbTarget } from "./dataTools";
import { currentTarget, dataHost, isSqlDriver } from "./dataTools";
import { store } from "./state";
import { toast } from "./toast";

function sqlSource(t: DbTarget | null, what: string): t is DbTarget {
  const e = t ? store.conns.get(t.connId) : undefined;
  if (!t || !e) {
    toast(`Select a table${what === "ddl" ? ", view or routine" : what === "import" ? " or schema" : " or schema"} in the explorer first`, "info");
    return false;
  }
  if (!isSqlDriver(e.config.driver)) {
    toast("This works with PostgreSQL, MySQL, SQLite and SQL Server data sources", "info");
    return false;
  }
  return true;
}

/** Opens (or focuses) the DDL tab of an object. */
export function showDdl(target?: DbTarget | null): void {
  const t = target ?? currentTarget("ddl");
  if (!sqlSource(t, "ddl")) return;
  if (t.kind === "schema" || !t.name) {
    toast("Select a table, view, routine, sequence or index to show its DDL", "info");
    return;
  }
  const h = dataHost();
  const open = h.tabs().find((p): p is DdlPane => p instanceof DdlPane && p.matches(t));
  if (open) {
    h.activate(open);
    void open.load();
    return;
  }
  h.addTab(new DdlPane(t));
}

/** Table designer: an existing table ("Edit table…") or a new one in a schema ("New table…"). */
export function openDesigner(target: DbTarget | null | undefined, create: boolean): void {
  const t = target ?? currentTarget(create ? "schema" : "table");
  if (!sqlSource(t, "design")) return;
  const e = store.conns.get(t.connId);
  if (e?.config.readOnly) toast(`${e.config.name} is read-only: you can design, but not apply`, "info");
  const editing = !create && t.kind === "table" && !!t.name;
  const h = dataHost();
  if (editing) {
    const open = h.tabs().find((p): p is DesignerPane => p instanceof DesignerPane && p.matches(t, false));
    if (open) {
      h.activate(open);
      return;
    }
  }
  h.addTab(new DesignerPane(editing ? t : { ...t, kind: "schema", name: undefined }, !editing));
}

/** Import data… into a table, or into a schema (new or chosen table). */
export function importData(target?: DbTarget | null): void {
  const t = target ?? currentTarget("table");
  if (!sqlSource(t, "import")) return;
  const e = store.conns.get(t.connId);
  if (e?.config.readOnly) {
    toast(`${e.config.name} is read-only: importing isn't allowed`, "info");
    return;
  }
  openImportWizard(t);
}
