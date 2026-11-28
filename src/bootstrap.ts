import { setPlatform, type Platform } from "./platform";
import { App } from "./ui/app";
import { installInputUndo } from "./ui/inputUndo";
import { loadSettings } from "./ui/settings";
import "./styles/settings.css";
import "./styles/shell.css";
import "./styles/nav.css";

export async function start(platform: Platform): Promise<void> {
  setPlatform(platform);
  const root = document.documentElement;
  const ua = navigator.userAgent;
  root.classList.toggle("desktop", platform.mode === "desktop");
  if (/Mac/.test(ua)) root.classList.add("mac");
  else if (/Windows/.test(ua)) root.classList.add("win");
  else if (/Linux|X11|BSD/.test(ua)) root.classList.add("os-linux");
  installInputUndo();
  const mount = document.getElementById("app");
  if (mount) {
    // Preserve the saved accent, fonts and theme on the IDE's first paint.
    await loadSettings();
    await new App(mount).start();
  }
}
