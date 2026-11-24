import { App } from "./ui/app";

const ua = navigator.userAgent;
const root = document.documentElement;
if (ua.includes("Linux")) root.classList.add("no-vibrancy");
if (/Mac/.test(ua)) root.classList.add("mac");
if (/Windows/.test(ua)) root.classList.add("win");

const mount = document.getElementById("app");
if (mount) void new App(mount).start();
