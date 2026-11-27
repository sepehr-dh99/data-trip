// A small SQL highlighter for read-only views (Show DDL, the designer's SQL preview, the import plan):
// splits text into lines of colored segments. Pure; node tests: node scripts/test-data-tools.mjs.

export type SynKind = "kw" | "type" | "str" | "num" | "cmt" | "punct" | "fn" | "id" | "ws";

export interface SynSeg {
  t: string;
  c: SynKind;
}

const KW = new Set(
  (
    "select from where join left right inner outer full cross on and or not order by group limit offset as desc asc insert into values update " +
    "set with in null is having distinct interval between create table index constraint primary key foreign references check default comment " +
    "using generated always identity view function procedure returns returning language stable immutable volatile replace alter add column drop " +
    "truncate delete begin commit rollback exec execute unique cascade restrict rename to if exists conflict do nothing auto_increment engine " +
    "autoincrement collate true false only like security definer invoker return materialized sequence start increment minvalue maxvalue cache " +
    "cycle owned none trigger before after each row for declare end case when then else go clustered nonclustered include modify change first " +
    "after modify transaction savepoint release pragma ignore duplicate merge matched unlogged partition strict called input leakproof parallel " +
    "safe unsafe restricted cost delimiter algorithm sql data reads modifies deterministic contains no action schema temporary temp"
  ).split(" "),
);

const TYPES = new Set(
  (
    "bigint integer int smallint tinyint mediumint numeric decimal real float double precision text varchar char character varying nvarchar nchar " +
    "boolean bool date time timestamp timestamptz datetime datetime2 datetimeoffset smalldatetime interval json jsonb uuid uniqueidentifier bytea " +
    "blob tinyblob mediumblob longblob longtext mediumtext tinytext binary varbinary bit money serial bigserial smallserial oid inet cidr macaddr " +
    "xml image enum zone btree hash gist gin brin plpgsql sql max"
  ).split(" "),
);

const FN = new Set("now count sum avg min max coalesce lower upper nextval current_timestamp current_date getdate sysutcdatetime newid gen_random_uuid date_trunc length substring trim cast".split(" "));

/** Highlighted lines of `src`. */
export function highlightSql(src: string): SynSeg[][] {
  const lines: SynSeg[][] = [[]];
  const push = (t: string, c: SynKind): void => {
    const parts = t.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ t: p, c });
    });
  };
  const re = /(--[^\n]*|#[^\n]*(?=\n|$)|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?|N'(?:[^']|'')*'?)|(\$[A-Za-z_0-9]*\$)|("(?:[^"]|"")*"?|`(?:[^`]|``)*`?|\[[^\]\n]*\]?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    if (m[1]) {
      // "#" starts a comment only at a line start (MySQL); otherwise it's punctuation.
      if (m[1].startsWith("#") && !(m.index === 0 || src[m.index - 1] === "\n")) {
        push("#", "punct");
        re.lastIndex = m.index + 1;
        continue;
      }
      push(m[1], "cmt");
    } else if (m[2]) push(m[2], "str");
    else if (m[3]) push(m[3], "punct");
    else if (m[4]) push(m[4], "id");
    else if (m[5]) push(m[5], "num");
    else if (m[6]) {
      const w = m[6].toLowerCase();
      push(m[6], KW.has(w) ? "kw" : TYPES.has(w) ? "type" : FN.has(w) ? "fn" : "id");
    } else if (m[7]) push(m[7], "ws");
    else push(m[8], "punct");
  }
  return lines;
}
