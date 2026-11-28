// In-app updates (board Q): check GitHub releases on launch and daily, show a card when a newer
// version exists, download in the background with progress, then restart (or install for the
// next launch). The backend side is src-tauri/src/updater.rs.
import "../styles/updates.css";
import { listen } from "../platform";
import { api } from "../api";
import type { UpdateInfo, UpdateStatus } from "../types";
import { errMsg, h } from "./dom";
import { toast } from "./toast";
import { getSettings, onSettingsChange, updateSettings } from "./settings";

type Phase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

const DAY = 24 * 60 * 60 * 1000;
const LOGO =
  '<svg width="26" height="26" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M14.95 52.23V6.98H31.75A22.62 22.62 0 0 1 36.46 51.74" stroke="#FF1A3C" stroke-width="9.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14.95" cy="52.23" r="6.8" stroke="#FF1A3C" stroke-width="5.7"/></svg>';

let status: UpdateStatus | null = null;
let phase: Phase = "idle";
let info: UpdateInfo | null = null;
let lastCheck = 0;
let lastError = "";
let progress = { downloaded: 0, total: null as number | null };
let card: HTMLElement | null = null;
let beforeRestart: (() => void | Promise<void>) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const f of listeners) f();
  renderCard();
}

/** Called on every state change (the Settings section uses it). */
export function onUpdateState(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function updateState(): { status: UpdateStatus | null; phase: Phase; info: UpdateInfo | null; lastCheck: number; error: string } {
  return { status, phase, info, lastCheck, error: lastError };
}

/** Saves what must survive the restart (the workspace) right before relaunching. */
export function setBeforeRestart(f: () => void | Promise<void>): void {
  beforeRestart = f;
}

/** Starts automatic checks (on launch after a short delay, then daily). */
export async function initUpdates(): Promise<void> {
  try {
    status = await api.updateStatus();
  } catch {
    status = null;
  }
  void listen<{ downloaded: number; total: number | null }>("update-progress", (e) => {
    progress = e.payload;
    if (phase === "downloading") renderCard();
  });
  emit();
  if (!status?.configured) return;
  window.setTimeout(() => {
    if (getSettings().updates.auto) void checkForUpdates(false);
  }, 6000);
  window.setInterval(() => {
    if (getSettings().updates.auto && Date.now() - lastCheck > DAY && phase !== "downloading" && phase !== "ready") void checkForUpdates(false);
  }, 60 * 60 * 1000);
  onSettingsChange(() => listeners.forEach((f) => f()));
}

/** `manual`: from a menu / Settings — always shows the outcome (also "up to date"). */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!status?.configured) {
    if (manual) toast("Updates aren't set up for this build yet.", "info");
    return;
  }
  if (phase === "checking" || phase === "downloading") return;
  if (phase === "ready") {
    renderCard(true);
    return;
  }
  phase = "checking";
  lastError = "";
  emit();
  try {
    const s = getSettings().updates;
    const found = await api.updateCheck(s.prerelease);
    lastCheck = Date.now();
    info = found;
    if (!found) {
      phase = "idle";
      if (manual) toast(`You're up to date (DataTrip ${status.currentVersion}).`, "ok");
    } else if (!manual && s.skipped === found.version) {
      phase = "available";
      emit();
      hideCard();
      return;
    } else {
      phase = "available";
      emit();
      if (s.background) void download();
      else renderCard(true);
      return;
    }
  } catch (e) {
    phase = "error";
    lastError = errMsg(e);
    if (manual) toast(lastError, "error");
  }
  emit();
}

async function download(): Promise<void> {
  if (!info) return;
  phase = "downloading";
  progress = { downloaded: 0, total: null };
  emit();
  renderCard(true);
  try {
    await api.updateDownload();
    phase = "ready";
  } catch (e) {
    phase = "error";
    lastError = errMsg(e);
    toast(lastError, "error");
    hideCard();
  }
  emit();
  if (phase === "ready") renderCard(true);
}

async function install(restart: boolean): Promise<void> {
  try {
    if (restart && beforeRestart) {
      await beforeRestart();
      await new Promise((r) => window.setTimeout(r, 300));
    }
    await api.updateInstall(restart || status?.platform === "windows");
    if (!restart) {
      phase = "idle";
      hideCard();
      toast(`DataTrip ${info?.version ?? ""} is installed and starts next time.`, "ok");
      info = null;
      emit();
    }
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function later(): void {
  if (info && phase === "available") updateSettings((s) => (s.updates.skipped = info?.version ?? ""));
  hideCard();
}

function hideCard(): void {
  card?.remove();
  card = null;
}

function mb(n: number): string {
  return (n / 1048576).toFixed(1);
}

function notesList(notes: string | null): HTMLElement | null {
  if (!notes) return null;
  const lines = notes
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/[#*`_]/g, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 4);
  if (!lines.length) return null;
  return h("ul", { class: "upd-notes" }, ...lines.map((l) => h("li", null, l)));
}

/** Draws (or redraws) the corner card for the current phase; `show` creates it if hidden. */
function renderCard(show = false): void {
  if (!card && !show) return;
  if (!info || !(phase === "available" || phase === "downloading" || phase === "ready")) {
    hideCard();
    return;
  }
  if (!card) {
    card = h("div", { class: "upd-card", role: "status", "aria-live": "polite" });
    document.body.appendChild(card);
  }
  card.replaceChildren();
  const logo = h("span", { class: "upd-logo", "aria-hidden": "true" });
  logo.innerHTML = LOGO;
  const titles: Record<string, [string, string]> = {
    available: [`DataTrip ${info.version} is available`, `You have ${info.currentVersion}`],
    downloading: [`Downloading DataTrip ${info.version}…`, "You can keep working"],
    ready: [`DataTrip ${info.version} is ready`, "Restart to finish updating"],
  };
  const [title, sub] = titles[phase];
  card.append(
    h(
      "div",
      { class: "upd-head" },
      logo,
      h("div", { class: "upd-titles" }, h("div", { class: "upd-title" }, title), h("div", { class: "upd-sub" }, sub)),
      h("button", { class: "upd-x", type: "button", "aria-label": "Dismiss", onclick: () => (phase === "available" ? later() : hideCard()) }, "✕"),
    ),
  );
  if (phase === "available") {
    const notes = notesList(info.notes);
    if (notes) card.append(notes);
    card.append(
      h(
        "div",
        { class: "upd-actions" },
        h("button", { class: "upd-primary", type: "button", onclick: () => void download() }, "Update now"),
        h("button", { class: "upd-secondary", type: "button", onclick: () => later() }, "Later"),
        h("span", { class: "upd-spacer" }),
        h("button", { class: "upd-link", type: "button", onclick: () => info && void api.updateOpenPage(info.url).catch((e) => toast(errMsg(e), "error")) }, "Release notes ↗"),
      ),
    );
  } else if (phase === "downloading") {
    const pct = progress.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
    card.append(
      h("div", { class: "upd-bar" }, h("div", { class: "upd-fill" + (pct === null ? " indeterminate" : ""), style: pct === null ? "" : `width:${pct}%` })),
      h("div", { class: "upd-progress" }, pct === null ? `${mb(progress.downloaded)} MB` : `${pct}% · ${mb(progress.downloaded)} / ${mb(progress.total ?? 0)} MB`),
    );
  } else {
    const windows = status?.platform === "windows";
    card.append(
      h("div", { class: "upd-text" }, "Your tabs and their SQL come back after the restart. Finish or cancel running queries first."),
      h(
        "div",
        { class: "upd-actions" },
        h("button", { class: "upd-primary", type: "button", onclick: () => void install(true) }, "Restart DataTrip"),
        windows ? null : h("button", { class: "upd-secondary", type: "button", onclick: () => void install(false) }, "On next launch"),
      ),
    );
  }
}
