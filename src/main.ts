import { App } from "./ui/app";

// Platform classes drive the few OS-specific rules in glass.css:
//  mac      -> reserve the traffic-light strip (titleBarStyle Overlay)
//  win      -> native title bar, nothing reserved
//  os-linux -> native title bar + lighter blur recipes (WebKitGTK backdrop-filter is costly)
const ua = navigator.userAgent;
const root = document.documentElement;
if (/Mac/.test(ua)) root.classList.add("mac");
else if (/Windows/.test(ua)) root.classList.add("win");
else if (/Linux|X11|BSD/.test(ua)) root.classList.add("os-linux");

const mount = document.getElementById("app");
if (mount) void new App(mount).start();
