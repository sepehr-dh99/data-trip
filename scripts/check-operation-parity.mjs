import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const names = (text, pattern) => [...text.matchAll(pattern)].map(([, name]) => name).sort();
const ui = names(read("src/api.ts"), /\bcall(?:<[^;\n]+?>)?\("(\w+)"/g);
const registration = read("src-tauri/src/lib.rs").split("tauri::generate_handler![")[1].split("])")[0];
const desktop = names(registration, /::(\w+),/g);
const http = read("src-web/src/operations.rs").split("operations! {")[1];
const web = names(http, /^    (\w+)\(\w+, \w+[,)]/gm);
const desktopOnly = ["update_status", "update_check", "update_download", "update_install", "update_open_page"];

assert.equal(new Set(ui).size, ui.length, "Duplicate UI operation");
assert.equal(new Set(desktop).size, desktop.length, "Duplicate desktop operation");
assert.equal(new Set(web).size, web.length, "Duplicate web operation");
assert.deepEqual(desktop, ui, "UI/Tauri operations differ");
assert.deepEqual(web, ui.filter((name) => !desktopOnly.includes(name)), "Shared HTTP and UI operations differ");
console.log(`${web.length} shared operations; ${desktopOnly.length} desktop updater operations`);
