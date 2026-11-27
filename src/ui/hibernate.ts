// v0.17: which consoles keep their result grids (pure, node tests: scripts/test-hibernate.mjs).
// Consoles outside the N most recently used release their grid DOM (rebuilt from the kept rows when shown again);
// those whose kept rows exceed the per-console budget also drop the rows ("Results released to save memory").

/** What the planner needs to know about one console. */
export interface HibConsole {
  /** Shown right now (never hibernated). */
  visible: boolean;
  /** A statement / page / filter is running (never hibernated). */
  busy: boolean;
  /** A result grid has pending edits (never hibernated, never released). */
  pending: boolean;
  /** Rows still kept in memory over all its results (released results count 0). */
  rows: number;
}

/** keep = leave as is; hibernate = release the grid DOM, keep the rows; release = also drop the rows. */
export type HibAction = "keep" | "hibernate" | "release";

export interface HibOptions {
  /** How many most recently used consoles keep live grids (the editor hibernation count, 10). */
  live: number;
  /** Rows a hibernated console may keep (`data.hibernateResultRows`); 0 = never release rows. */
  rowBudget: number;
}

/** Default number of consoles that keep their editor view and result grids. */
export const LIVE_CONSOLES = 10;
/** Default `data.hibernateResultRows`. */
export const DEFAULT_RESULT_ROWS = 100_000;

/**
 * One action per console of `mru` (most recently used first): the first `live` and every visible, busy or
 * pending one keep their grids; the others hibernate, and release their rows when they keep more than
 * `rowBudget` (when it is > 0).
 */
export function planHibernation(mru: readonly HibConsole[], opts: HibOptions): HibAction[] {
  const live = Math.max(1, Math.floor(opts.live));
  const budget = opts.rowBudget > 0 ? Math.floor(opts.rowBudget) : 0;
  return mru.map((c, i) => {
    if (i < live || c.visible || c.busy || c.pending) return "keep";
    return budget > 0 && c.rows > budget ? "release" : "hibernate";
  });
}
