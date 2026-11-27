// What the shell needs from anything that lives in a capsule tab (SQL / Redis console, Redis key viewer).
export interface TabPane {
  /** v0.16: "ddl" = Show DDL tab, "design" = table designer (neither is restored on launch). */
  readonly kind: "console" | "key" | "topic" | "group" | "sessions" | "ddl" | "design";
  readonly el: HTMLElement;
  /** Controls shown in the capsule while this tab is active (may be empty). */
  readonly controls: HTMLElement;
  title: string;
  connId: string;
  database: string | null;
  readonly effectiveDatabase: string | null;
  readonly isRunning: boolean;
  /** Redis key tabs: icon name + type color class for the tab strip. */
  readonly tabIcon?: { icon: string; cls: string };
  /** Consoles opened on a table / view: its name (tab names "orders · shop"). */
  readonly table?: string | null;
  /** Unsaved work (pending grid edits, open manual transaction): the tab shows a dot. */
  readonly dirty?: boolean;
  /** Cross-source consoles: badge text ("3 sources") shown instead of the data source's name. */
  readonly sourceBadge?: string | null;
  /** Consoles bound to a .sql file: its path (the tab is named after the file). */
  readonly filePath?: string | null;
  /** Kafka topic / group tabs: what the capsule's second breadcrumb segment shows. */
  readonly objectLabel?: { glyph: "topic" | "group"; name: string };
  /** v0.15: extra tooltip line, e.g. "Disconnected after 15 min idle — reconnects on next run". */
  readonly statusHint?: string | null;
  focus(): void;
  dispose(): Promise<void>;
  dropSession(): void;
  updateSchema(): void;
  switchDatabase(name: string): Promise<void>;
  switchConnection(connId: string): Promise<void>;
  currentSchemaName(): string | null;
  setDefaultSchema(name: string): Promise<void>;
}
