import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { start } from "./bootstrap";

void start({
  mode: "desktop", invoke, listen,
  open: ({ purpose: _purpose, ...options }) => open(options),
  save: ({ purpose: _purpose, localCopy: _localCopy, ...options }) => save(options),
  preferences: localStorage,
});
