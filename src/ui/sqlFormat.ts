// Format SQL (sql-formatter): dialect mapping and the options DataTrip uses.
import type { Driver } from "../types";

type FormatterLanguage = "postgresql" | "mysql" | "sqlite" | "transactsql";

const LANGUAGES: Partial<Record<Driver, FormatterLanguage>> = {
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
  mssql: "transactsql",
};

/** True when the driver's consoles can be formatted (SQL drivers; not Redis / Kafka). */
export function canFormat(driver: Driver): boolean {
  return LANGUAGES[driver] !== undefined;
}

/** Formats `sql` for the driver's dialect: upper-case keywords, 2-space indent. Throws on unparsable input. */
export async function formatSql(sql: string, driver: Driver): Promise<string> {
  const language = LANGUAGES[driver];
  if (!language) return sql;
  const { format } = await import("sql-formatter");
  const out: unknown = format(sql, { language, keywordCase: "upper", tabWidth: 2, linesBetweenQueries: 1 });
  if (typeof out !== "string") throw new Error("unexpected formatter output");
  return out;
}
