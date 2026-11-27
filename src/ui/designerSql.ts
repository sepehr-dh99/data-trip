// Table designer (v0.16, board V), the pure part: per-dialect type lists, identifier quoting, and the exact
// statements for a new table (CREATE TABLE + indexes + comments) or an existing one (ALTER TABLE … per change,
// SQLite's copy-table rebuild where ALTER can't). Also the CREATE TABLE of "Import data › Create a new table".
// No DOM; node tests: node scripts/test-data-tools.mjs.

export type Dialect = "postgres" | "mysql" | "mssql" | "sqlite";

export interface DCol {
  /** Stable key (original columns keep theirs: changes are found by key). */
  k: string;
  name: string;
  type: string;
  nn: boolean;
  /** SQL expression ("" = none). */
  def: string;
  pk: boolean;
  cmt: string;
  deleted?: boolean;
  /** Identity / AUTO_INCREMENT (kept as is; MySQL repeats it in MODIFY). */
  auto?: boolean;
}

export interface DIdx {
  k: string;
  name: string;
  /** Comma-separated columns (expressions / "col DESC" kept as typed). */
  cols: string;
  uniq: boolean;
  /** The primary key's index (shown, not editable). */
  prim?: boolean;
  deleted?: boolean;
}

export interface DFk {
  k: string;
  name: string;
  cols: string;
  /** Referenced table, `schema.table` or `table`. */
  ref: string;
  refCols: string;
  /** "" / "NO ACTION" / "RESTRICT" / "CASCADE" / "SET NULL" / "SET DEFAULT" */
  onDelete: string;
  deleted?: boolean;
}

export interface DesignState {
  schema: string | null;
  name: string;
  cols: DCol[];
  idx: DIdx[];
  fks: DFk[];
}

/** The table as loaded (null = a new table). */
export interface DesignOrig extends DesignState {
  /** Name of the primary key constraint (PG / MSSQL). */
  pkName?: string | null;
  /** SQL Server: default constraint name by (original) column name. */
  defaultConstraints?: Record<string, string>;
  /** SQLite: the table used AUTOINCREMENT. */
  autoIncrement?: boolean;
}

export interface Stmt {
  sql: string;
  /** A comment line for the reader, never executed. */
  note?: boolean;
}

export interface DesignResult {
  stmts: Stmt[];
  /** SQLite: the table is rebuilt (copy → drop → rename). */
  rebuild: boolean;
}

export const DIALECT_NAMES: Record<Dialect, string> = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", sqlite: "SQLite" };

/** The type menu per dialect (any other type can be typed). */
export const TYPE_LISTS: Record<Dialect, { type: string; hint: string }[]> = {
  postgres: [
    { type: "bigint", hint: "64-bit integer" },
    { type: "integer", hint: "integer" },
    { type: "smallint", hint: "small integer" },
    { type: "numeric(12,2)", hint: "decimal" },
    { type: "double precision", hint: "float" },
    { type: "varchar(255)", hint: "short text" },
    { type: "text", hint: "text" },
    { type: "char(2)", hint: "fixed-length code" },
    { type: "boolean", hint: "boolean" },
    { type: "date", hint: "date" },
    { type: "timestamp", hint: "timestamp" },
    { type: "timestamptz", hint: "timestamp with zone" },
    { type: "time", hint: "time of day" },
    { type: "interval", hint: "duration" },
    { type: "uuid", hint: "UUID" },
    { type: "jsonb", hint: "JSON" },
    { type: "bytea", hint: "binary" },
  ],
  mysql: [
    { type: "BIGINT", hint: "64-bit integer" },
    { type: "INT", hint: "integer" },
    { type: "SMALLINT", hint: "small integer" },
    { type: "DECIMAL(12,2)", hint: "decimal" },
    { type: "DOUBLE", hint: "float" },
    { type: "VARCHAR(255)", hint: "short text" },
    { type: "TEXT", hint: "text" },
    { type: "LONGTEXT", hint: "long text" },
    { type: "CHAR(2)", hint: "fixed-length code" },
    { type: "TINYINT(1)", hint: "boolean" },
    { type: "DATE", hint: "date" },
    { type: "DATETIME(6)", hint: "timestamp" },
    { type: "TIMESTAMP", hint: "UTC timestamp" },
    { type: "TIME", hint: "time of day" },
    { type: "JSON", hint: "JSON" },
    { type: "CHAR(36)", hint: "UUID" },
    { type: "BLOB", hint: "binary" },
  ],
  mssql: [
    { type: "bigint", hint: "64-bit integer" },
    { type: "int", hint: "integer" },
    { type: "smallint", hint: "small integer" },
    { type: "decimal(12,2)", hint: "decimal" },
    { type: "float", hint: "float" },
    { type: "nvarchar(255)", hint: "short text" },
    { type: "nvarchar(max)", hint: "text / JSON" },
    { type: "varchar(255)", hint: "short ASCII text" },
    { type: "nchar(2)", hint: "fixed-length code" },
    { type: "bit", hint: "boolean" },
    { type: "date", hint: "date" },
    { type: "datetime2", hint: "timestamp" },
    { type: "datetimeoffset", hint: "timestamp with zone" },
    { type: "time", hint: "time of day" },
    { type: "uniqueidentifier", hint: "UUID" },
    { type: "varbinary(max)", hint: "binary" },
  ],
  sqlite: [
    { type: "INTEGER", hint: "integer" },
    { type: "REAL", hint: "float" },
    { type: "NUMERIC", hint: "decimal / date" },
    { type: "TEXT", hint: "text" },
    { type: "BLOB", hint: "binary" },
  ],
};

const RESERVED = new Set(
  (
    "all alter analyse analyze and any array as asc asymmetric authorization between binary both by case cast check collate collation column " +
    "constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user database " +
    "default deferrable delete desc distinct do drop else end except exists false fetch for foreign freeze from full function grant group " +
    "having ilike in index initially inner insert intersect interval into is isnull join key lateral leading left like limit localtime " +
    "localtimestamp natural not notnull null offset on only or order outer over overlaps placing primary procedure range references " +
    "returning right row rows schema select session_user set similar some symmetric table tablesample then to trailing trigger true union " +
    "unique update user using values variadic verbose view when where window with"
  ).split(" "),
);

/** Identifier, quoted only when needed (PostgreSQL: lower-case simple names stay bare). */
export function ident(d: Dialect, name: string): string {
  const simple = d === "postgres" ? /^[a-z_][a-z0-9_$]*$/.test(name) : d === "mssql" ? /^[A-Za-z_][A-Za-z0-9_@#$]*$/.test(name) : /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
  if (simple && !RESERVED.has(name.toLowerCase())) return name;
  if (d === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (d === "mssql") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}

export function qname(d: Dialect, schema: string | null, name: string): string {
  return schema && d !== "sqlite" ? `${ident(d, schema)}.${ident(d, name)}` : schema && d === "sqlite" && schema !== "main" ? `${ident(d, schema)}.${ident(d, name)}` : ident(d, name);
}

/** A string literal. */
export function lit(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function nlit(s: string): string {
  return "N'" + s.replace(/'/g, "''") + "'";
}

/** "a, b DESC, lower(c)" → quoted names where they are plain names. */
export function colList(d: Dialect, cols: string): string {
  return splitCols(cols)
    .map((c) => (/^[^\s()"`[\]]+$/.test(c) ? ident(d, c) : c))
    .join(", ");
}

export function splitCols(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function refName(d: Dialect, ref: string): string {
  const t = ref.trim();
  if (/["`[]/.test(t)) return t;
  return t
    .split(".")
    .map((p) => ident(d, p.trim()))
    .join(".");
}

const PG_SYN: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  decimal: "numeric",
  float8: "double precision",
  float4: "real",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time without time zone": "time",
  "time with time zone": "timetz",
};

/** Normalized type text for change detection. */
export function normType(d: Dialect, t: string): string {
  let s = t.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")");
  if (d === "postgres") {
    s = s.replace(/^character varying/, "varchar").replace(/^character\b/, "char").replace(/^bpchar/, "char");
    const m = /^([a-z0-9 ]+?)(\(.*\))?(\[\])?$/.exec(s);
    if (m && PG_SYN[m[1]]) s = PG_SYN[m[1]] + (m[2] ?? "") + (m[3] ?? "");
  }
  if (d === "mysql") {
    // Display widths don't matter (int(11) = int), except tinyint(1) which means boolean.
    s = s.replace(/^(bigint|int|integer|smallint|mediumint)\(\d+\)/, "$1").replace(/^integer\b/, "int");
  }
  return s;
}

export function sameType(d: Dialect, a: string, b: string): boolean {
  return normType(d, a) === normType(d, b);
}

/** Defaults typed the portable way (true / false / now()) in the dialect's spelling. */
export function dialectDefault(d: Dialect, v: string): string {
  const t = v.trim();
  if (t === "") return "";
  if (d !== "postgres" && /^(true|false)$/i.test(t)) return /^true$/i.test(t) ? "1" : "0";
  if (/^now\(\)$/i.test(t)) return d === "mssql" ? "SYSUTCDATETIME()" : d === "postgres" ? "now()" : "CURRENT_TIMESTAMP";
  return t;
}

function colDef(d: Dialect, c: DCol, withComment: boolean, inlinePk = false): string {
  let s = `${ident(d, c.name)} ${c.type.trim()}`;
  if (inlinePk) s += " PRIMARY KEY AUTOINCREMENT";
  if (d === "mssql") s += c.nn ? " NOT NULL" : " NULL";
  else if (c.nn && !inlinePk) s += " NOT NULL";
  if (c.auto && d === "mysql") s += " AUTO_INCREMENT";
  const dv = dialectDefault(d, c.def);
  if (dv !== "") s += ` DEFAULT ${dv}`;
  if (withComment && d === "mysql" && c.cmt.trim()) s += ` COMMENT ${lit(c.cmt.trim())}`;
  return s;
}

function fkDef(d: Dialect, f: DFk): string {
  let s = `CONSTRAINT ${ident(d, f.name)} FOREIGN KEY (${colList(d, f.cols)}) REFERENCES ${refName(d, f.ref)} (${colList(d, f.refCols)})`;
  const od = f.onDelete.trim().toUpperCase();
  if (od && od !== "NO ACTION") s += ` ON DELETE ${od}`;
  return s;
}

function msComment(schema: string, table: string, col: string | null, value: string, op: "add" | "update" | "drop"): string {
  const proc = op === "add" ? "sp_addextendedproperty" : op === "update" ? "sp_updateextendedproperty" : "sp_dropextendedproperty";
  const val = op === "drop" ? "" : `, @value = ${nlit(value)}`;
  return `EXEC ${proc} @name = N'MS_Description'${val}, @level0type = N'SCHEMA', @level0name = ${nlit(schema)}, @level1type = N'TABLE', @level1name = ${nlit(table)}${col !== null ? `, @level2type = N'COLUMN', @level2name = ${nlit(col)}` : ""};`;
}

function createIndex(d: Dialect, table: string, x: DIdx): string {
  return `CREATE ${x.uniq ? "UNIQUE " : ""}INDEX ${ident(d, x.name)} ON ${table} (${colList(d, x.cols)});`;
}

function dropIndex(d: Dialect, schema: string | null, table: string, name: string): string {
  if (d === "postgres") return `DROP INDEX ${qname(d, schema, name)};`;
  if (d === "sqlite") return `DROP INDEX ${qname(d, schema, name)};`;
  return `DROP INDEX ${ident(d, name)} ON ${table};`;
}

/** CREATE TABLE … (+ indexes, comments) for a new table. */
function createSql(d: Dialect, s: DesignState): Stmt[] {
  const T = qname(d, s.schema, s.name);
  const live = s.cols.filter((c) => !c.deleted);
  const pk = live.filter((c) => c.pk);
  const out: Stmt[] = [];
  const inlinePk = d === "sqlite" && pk.length === 1 && pk[0].auto === true && /^integer$/i.test(pk[0].type.trim());
  const body = live.map((c) => "    " + colDef(d, c, true, inlinePk && c === pk[0]));
  if (pk.length && !inlinePk) body.push(`    ${d === "mssql" ? `CONSTRAINT ${ident(d, "PK_" + s.name)} ` : ""}PRIMARY KEY (${pk.map((c) => ident(d, c.name)).join(", ")})`);
  for (const f of s.fks.filter((f) => !f.deleted)) body.push("    " + fkDef(d, f));
  out.push({ sql: `CREATE TABLE ${T} (\n${body.join(",\n")}\n);` });
  for (const x of s.idx.filter((x) => !x.deleted && !x.prim)) out.push({ sql: createIndex(d, T, x) });
  for (const c of live) {
    if (!c.cmt.trim()) continue;
    if (d === "postgres") out.push({ sql: `COMMENT ON COLUMN ${T}.${ident(d, c.name)} IS ${lit(c.cmt.trim())};` });
    else if (d === "mssql") out.push({ sql: msComment(s.schema ?? "dbo", s.name, c.name, c.cmt.trim(), "add") });
  }
  if (d === "sqlite" && live.some((c) => c.cmt.trim())) out.push({ sql: "-- SQLite has no column comments; they aren't saved", note: true });
  return out;
}

/** The statements for the design: CREATE for a new table, ALTERs for an existing one. */
export function designSql(d: Dialect, cur: DesignState, orig: DesignOrig | null): DesignResult {
  if (!orig) return { stmts: createSql(d, cur), rebuild: false };
  const out: Stmt[] = [];
  const schema = orig.schema;
  const T = qname(d, schema, orig.name);
  const A = `ALTER TABLE ${T} `;
  const om = new Map(orig.cols.map((c) => [c.k, c]));
  const msSchema = schema ?? "dbo";
  const dfName = (col: string): string => `DF_${cur.name}_${col}`;
  let rebuild = false;

  // FKs and indexes that go away first (they may use columns that change).
  for (const f of cur.fks) {
    const o = orig.fks.find((x) => x.k === f.k);
    if (o && f.deleted) {
      if (d === "sqlite") rebuild = true;
      else out.push({ sql: d === "mysql" ? `${A}DROP FOREIGN KEY ${ident(d, o.name)};` : `${A}DROP CONSTRAINT ${ident(d, o.name)};` });
    }
  }
  for (const x of cur.idx) {
    const o = orig.idx.find((y) => y.k === x.k);
    if (!o || o.prim) continue;
    const changed = o.cols !== x.cols || o.uniq !== x.uniq;
    if (x.deleted || changed) out.push({ sql: dropIndex(d, schema, T, o.name) });
  }

  cur.cols.forEach((c, i) => {
    const o = om.get(c.k);
    if (!o) {
      if (c.deleted) return;
      if (d === "sqlite" && (c.pk || (c.nn && !c.def.trim()))) {
        rebuild = true;
        return;
      }
      if (d === "mssql") {
        const dv = dialectDefault(d, c.def);
        out.push({ sql: `${A}ADD ${ident(d, c.name)} ${c.type.trim()}${c.nn ? " NOT NULL" : " NULL"}${dv ? ` CONSTRAINT ${ident(d, dfName(c.name))} DEFAULT ${dv}` : ""};` });
        if (c.cmt.trim()) out.push({ sql: msComment(msSchema, orig.name, c.name, c.cmt.trim(), "add") });
        return;
      }
      let pos = "";
      if (d === "mysql") {
        const prev = cur.cols.slice(0, i).filter((x) => !x.deleted);
        pos = prev.length ? ` AFTER ${ident(d, prev[prev.length - 1].name)}` : " FIRST";
      }
      out.push({ sql: `${A}ADD COLUMN ${colDef(d, c, true)}${pos};` });
      if (d === "postgres" && c.cmt.trim()) out.push({ sql: `COMMENT ON COLUMN ${T}.${ident(d, c.name)} IS ${lit(c.cmt.trim())};` });
      return;
    }
    if (c.deleted) {
      if (d === "sqlite" && o.pk) {
        rebuild = true;
        return;
      }
      if (d === "mssql") {
        const dc = orig.defaultConstraints?.[o.name];
        if (dc) out.push({ sql: `${A}DROP CONSTRAINT ${ident(d, dc)};` });
      }
      out.push({ sql: `${A}DROP COLUMN ${ident(d, o.name)};` });
      return;
    }
    const ren = c.name !== o.name;
    const tyc = !sameType(d, c.type, o.type);
    const nnc = c.nn !== o.nn;
    const dfc = c.def.trim() !== o.def.trim();
    const cmc = c.cmt.trim() !== o.cmt.trim();
    if (d === "mysql") {
      if (ren && !(tyc || nnc || dfc || cmc)) out.push({ sql: `${A}RENAME COLUMN ${ident(d, o.name)} TO ${ident(d, c.name)};` });
      else if (ren) out.push({ sql: `${A}CHANGE COLUMN ${ident(d, o.name)} ${colDef(d, c, true)};` });
      else if (tyc || nnc || dfc || cmc) out.push({ sql: `${A}MODIFY COLUMN ${colDef(d, c, true)};` });
      return;
    }
    if (ren) {
      if (d === "mssql") out.push({ sql: `EXEC sp_rename ${nlit(`${msSchema}.${orig.name}.${o.name}`)}, ${nlit(c.name)}, N'COLUMN';` });
      else out.push({ sql: `${A}RENAME COLUMN ${ident(d, o.name)} TO ${ident(d, c.name)};` });
    }
    const n = ident(d, c.name);
    if (d === "sqlite") {
      if (tyc || nnc || dfc) rebuild = true;
      return;
    }
    if (d === "postgres") {
      if (tyc) out.push({ sql: `${A}ALTER COLUMN ${n} TYPE ${c.type.trim()} USING ${n}::${c.type.trim()};` });
      if (nnc) out.push({ sql: `${A}ALTER COLUMN ${n} ${c.nn ? "SET" : "DROP"} NOT NULL;` });
      if (dfc) out.push({ sql: c.def.trim() ? `${A}ALTER COLUMN ${n} SET DEFAULT ${dialectDefault(d, c.def)};` : `${A}ALTER COLUMN ${n} DROP DEFAULT;` });
      if (cmc) out.push({ sql: `COMMENT ON COLUMN ${T}.${n} IS ${c.cmt.trim() ? lit(c.cmt.trim()) : "NULL"};` });
      return;
    }
    // SQL Server
    if (tyc || nnc) out.push({ sql: `${A}ALTER COLUMN ${n} ${c.type.trim()} ${c.nn ? "NOT NULL" : "NULL"};` });
    if (dfc) {
      const dc = orig.defaultConstraints?.[o.name];
      if (dc) out.push({ sql: `${A}DROP CONSTRAINT ${ident(d, dc)};` });
      else if (o.def.trim()) out.push({ sql: `-- The old default of ${o.name} has no known constraint name: drop it by hand if needed`, note: true });
      if (c.def.trim()) out.push({ sql: `${A}ADD CONSTRAINT ${ident(d, dfName(c.name))} DEFAULT ${dialectDefault(d, c.def)} FOR ${n};` });
    }
    if (cmc) {
      const op = !c.cmt.trim() ? "drop" : o.cmt.trim() ? "update" : "add";
      out.push({ sql: msComment(msSchema, orig.name, c.name, c.cmt.trim(), op) });
    }
  });

  // Primary key
  const pkNow = cur.cols.filter((c) => c.pk && !c.deleted).map((c) => c.name);
  const pkWasCols = orig.cols.filter((c) => c.pk).map((c) => cur.cols.find((x) => x.k === c.k)?.name ?? c.name);
  const pkChanged = pkNow.join("\u0000") !== pkWasCols.join("\u0000") || orig.cols.some((c) => c.pk && cur.cols.find((x) => x.k === c.k)?.deleted);
  if (pkChanged) {
    const cols = pkNow.map((c) => ident(d, c)).join(", ");
    if (d === "sqlite") rebuild = true;
    else if (d === "mysql") {
      const parts: string[] = [];
      if (pkWasCols.length) parts.push("DROP PRIMARY KEY");
      if (pkNow.length) parts.push(`ADD PRIMARY KEY (${cols})`);
      if (parts.length) out.push({ sql: `${A}${parts.join(", ")};` });
    } else {
      if (pkWasCols.length) {
        const name = orig.pkName ?? (d === "postgres" ? `${orig.name}_pkey` : `PK_${orig.name}`);
        out.push({ sql: `${A}DROP CONSTRAINT ${ident(d, name)};` });
      }
      if (pkNow.length) out.push({ sql: d === "mssql" ? `${A}ADD CONSTRAINT ${ident(d, "PK_" + cur.name)} PRIMARY KEY (${cols});` : `${A}ADD PRIMARY KEY (${cols});` });
    }
  }

  // Column order
  const ordNow = cur.cols.filter((c) => om.has(c.k) && !c.deleted).map((c) => c.k);
  const ordWas = orig.cols.filter((c) => ordNow.includes(c.k)).map((c) => c.k);
  if (ordNow.join(",") !== ordWas.join(",")) {
    if (d === "mysql") {
      const live = cur.cols.filter((c) => !c.deleted);
      live.forEach((c, i) => {
        if (!om.has(c.k)) return;
        const before = ordWas.indexOf(c.k);
        const now = ordNow.indexOf(c.k);
        if (before === now) return;
        out.push({ sql: `${A}MODIFY COLUMN ${colDef(d, c, true)}${i === 0 ? " FIRST" : ` AFTER ${ident(d, live[i - 1].name)}`};` });
      });
    } else if (d === "sqlite") rebuild = true;
    else out.push({ sql: `-- ${DIALECT_NAMES[d]} can't reorder existing columns; the new order isn't applied`, note: true });
  }

  // Indexes: new, changed (re-created), renamed
  for (const x of cur.idx) {
    const o = orig.idx.find((y) => y.k === x.k);
    if (x.deleted || x.prim) continue;
    if (!o) {
      out.push({ sql: createIndex(d, T, x) });
      continue;
    }
    if (o.prim) continue;
    const changed = o.cols !== x.cols || o.uniq !== x.uniq;
    if (changed) out.push({ sql: createIndex(d, T, x) });
    else if (o.name !== x.name) {
      if (d === "postgres") out.push({ sql: `ALTER INDEX ${qname(d, schema, o.name)} RENAME TO ${ident(d, x.name)};` });
      else if (d === "mysql") out.push({ sql: `${A}RENAME INDEX ${ident(d, o.name)} TO ${ident(d, x.name)};` });
      else if (d === "mssql") out.push({ sql: `EXEC sp_rename ${nlit(`${msSchema}.${orig.name}.${o.name}`)}, ${nlit(x.name)}, N'INDEX';` });
      else out.push({ sql: dropIndex(d, schema, T, o.name) }, { sql: createIndex(d, T, x) });
    }
  }

  // New foreign keys
  for (const f of cur.fks) {
    if (f.deleted || orig.fks.some((x) => x.k === f.k)) continue;
    if (d === "sqlite") rebuild = true;
    else out.push({ sql: `${A}ADD ${fkDef(d, f)};` });
  }

  // Table rename last (everything above uses the old name).
  if (cur.name !== orig.name && cur.name.trim()) {
    if (d === "mssql") out.push({ sql: `EXEC sp_rename ${nlit(`${msSchema}.${orig.name}`)}, ${nlit(cur.name)};` });
    else if (d === "mysql") out.push({ sql: `RENAME TABLE ${T} TO ${qname(d, schema, cur.name)};` });
    else out.push({ sql: `${A}RENAME TO ${ident(d, cur.name)};` });
  }
  if (d === "sqlite" && cur.cols.some((c) => c.cmt.trim() !== (om.get(c.k)?.cmt ?? "").trim())) {
    out.push({ sql: "-- SQLite has no column comments; they aren't saved", note: true });
  }

  if (rebuild) return { stmts: sqliteRebuild(cur, orig), rebuild: true };
  return { stmts: out, rebuild: false };
}

/** SQLite: create the new shape, copy the rows, drop the old table, rename, re-create the indexes. */
function sqliteRebuild(cur: DesignState, orig: DesignOrig): Stmt[] {
  const d: Dialect = "sqlite";
  const name = cur.name.trim() || orig.name;
  const tmp = `${name}_new`;
  const om = new Map(orig.cols.map((c) => [c.k, c]));
  const live = cur.cols.filter((c) => !c.deleted);
  const keep = live.filter((c) => om.has(c.k));
  const pk = live.filter((c) => c.pk);
  const inlinePk = pk.length === 1 && orig.autoIncrement === true && /^integer$/i.test(pk[0].type.trim());
  const body = live.map((c) => "    " + colDef(d, c, false, inlinePk && c === pk[0]));
  if (pk.length && !inlinePk) body.push(`    PRIMARY KEY (${pk.map((c) => ident(d, c.name)).join(", ")})`);
  for (const f of cur.fks.filter((f) => !f.deleted)) body.push("    " + fkDef(d, f));
  const out: Stmt[] = [
    { sql: "-- SQLite can't change a column's type, NOT NULL, default, key or order in place:\n-- DataTrip rebuilds the table (copy → drop → rename). Foreign key checks are paused meanwhile.", note: true },
    { sql: "PRAGMA foreign_keys = OFF;" },
    { sql: `CREATE TABLE ${qname(d, cur.schema, tmp)} (\n${body.join(",\n")}\n);` },
    {
      sql: `INSERT INTO ${qname(d, cur.schema, tmp)} (${keep.map((c) => ident(d, c.name)).join(", ")})\nSELECT ${keep.map((c) => ident(d, (om.get(c.k) as DCol).name)).join(", ")} FROM ${qname(d, orig.schema, orig.name)};`,
    },
    { sql: `DROP TABLE ${qname(d, orig.schema, orig.name)};` },
    { sql: `ALTER TABLE ${qname(d, cur.schema, tmp)} RENAME TO ${ident(d, name)};` },
  ];
  for (const x of cur.idx.filter((x) => !x.deleted && !x.prim)) out.push({ sql: createIndex(d, qname(d, cur.schema, name), x) });
  out.push({ sql: "PRAGMA foreign_keys = ON;" });
  return out;
}

/** Whether the dialect runs DDL inside a transaction (MySQL commits each DDL statement). */
export function transactionalDdl(d: Dialect): boolean {
  return d !== "mysql";
}

/** The statements that run (comment notes dropped). SQLite PRAGMA foreign_keys can't run inside a transaction. */
export function runnable(stmts: Stmt[]): string[] {
  return stmts.filter((s) => !s.note).map((s) => s.sql);
}

// ------------------------------------------------------------------ import: new table types

/** A column type for an inferred kind (Import data › Create a new table). */
export function typeForKind(d: Dialect, kind: string, maxLen: number, precision: number, scale: number): string {
  const p = Math.min(38, Math.max(precision, scale + 1, 10));
  const s = Math.min(scale, 10);
  const len = maxLen <= 0 ? 255 : maxLen <= 50 ? 100 : maxLen <= 200 ? 255 : maxLen <= 1000 ? 1000 : 0;
  switch (d) {
    case "postgres":
      return kind === "int" ? "integer" : kind === "bigint" ? "bigint" : kind === "decimal" ? `numeric(${p},${s})` : kind === "bool" ? "boolean" : kind === "date" ? "date" : kind === "timestamp" ? "timestamptz" : kind === "json" ? "jsonb" : "text";
    case "mysql":
      return kind === "int" ? "INT" : kind === "bigint" ? "BIGINT" : kind === "decimal" ? `DECIMAL(${p},${s})` : kind === "bool" ? "TINYINT(1)" : kind === "date" ? "DATE" : kind === "timestamp" ? "DATETIME(6)" : kind === "json" ? "JSON" : len ? `VARCHAR(${len})` : "TEXT";
    case "mssql":
      return kind === "int" ? "int" : kind === "bigint" ? "bigint" : kind === "decimal" ? `decimal(${p},${s})` : kind === "bool" ? "bit" : kind === "date" ? "date" : kind === "timestamp" ? "datetime2" : len ? `nvarchar(${len})` : "nvarchar(max)";
    case "sqlite":
      return kind === "int" || kind === "bigint" || kind === "bool" ? "INTEGER" : kind === "decimal" ? "NUMERIC" : "TEXT";
  }
}

/** A column name made safe for a new table ("customer.id" → "customer_id"). */
export function columnNameFor(source: string): string {
  const s = source
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!s) return "column";
  return /^[0-9]/.test(s) ? "c_" + s : s;
}

/** CREATE TABLE for an import into a new table. */
export function createTableForImport(d: Dialect, schema: string | null, name: string, cols: { name: string; type: string }[]): string {
  const st: DesignState = {
    schema,
    name,
    cols: cols.map((c, i) => ({ k: "i" + i, name: c.name, type: c.type, nn: false, def: "", pk: false, cmt: "" })),
    idx: [],
    fks: [],
  };
  return createSql(d, st)[0].sql;
}
