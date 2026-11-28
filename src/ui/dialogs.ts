import { errMsg } from "./dom";
import { toast } from "./toast";

function report(error: unknown): void {
  toast(`Could not open dialog: ${errMsg(error)}`, "error");
}

export function openSettings(...args: Parameters<typeof import("./settingsDialog").openSettings>): void {
  void import("./settingsDialog").then((m) => m.openSettings(...args)).catch(report);
}

export function openConnectionDialog(...args: Parameters<typeof import("./connDialog").openConnectionDialog>): void {
  void import("./connDialog").then((m) => m.openConnectionDialog(...args)).catch(report);
}

export function openImportDialog(...args: Parameters<typeof import("./importDialog").openImportDialog>): void {
  void import("./importDialog").then((m) => m.openImportDialog(...args)).catch(report);
}
