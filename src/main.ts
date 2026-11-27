import { App } from "./ui/app";
import { installInputUndo } from "./ui/inputUndo";
import { loadSettings } from "./ui/settings";
import "./styles/settings.css";
import "./styles/shell.css";
import "./styles/nav.css";

// Platform classes drive the few OS-specific rules in glass.css:
//  mac      -> reserve the traffic-light strip (titleBarStyle Overlay)
//  win      -> native title bar, nothing reserved
//  os-linux -> native title bar + lighter blur recipes (WebKitGTK backdrop-filter is costly)
const ua = navigator.userAgent;
const root = document.documentElement;
if (/Mac/.test(ua)) root.classList.add("mac");
else if (/Windows/.test(ua)) root.classList.add("win");
else if (/Linux|X11|BSD/.test(ua)) root.classList.add("os-linux");

installInputUndo();

const mount = document.getElementById("app");
// Settings are applied before the app starts so the first paint already has the user's accent, fonts and theme.
if (mount) void loadSettings().then(() => new App(mount).start());
