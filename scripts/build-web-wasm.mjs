import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const crate = "crates/datatrip-wasm";
const target = process.env.CARGO_TARGET_DIR ?? `${crate}/target`;
const tool = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const version = execFileSync(tool, ["--version"], { encoding: "utf8" }).trim();
if (version !== "wasm-bindgen 0.2.130") throw new Error(`Expected wasm-bindgen 0.2.130, got ${version}`);
execFileSync("cargo", ["build", "--locked", "--manifest-path", `${crate}/Cargo.toml`,
  "--target-dir", target, "--target", "wasm32-unknown-unknown", "--release"], { stdio: "inherit" });
mkdirSync("src/generated", { recursive: true });
execFileSync(tool, ["--target", "web", "--out-dir", "src/generated",
  `${target}/wasm32-unknown-unknown/release/datatrip_wasm.wasm`], { stdio: "inherit" });
