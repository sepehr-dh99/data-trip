# DataTrip web

The headless build is a **hosted preview**. The paired workstation companion is not implemented; laptop-only network access, CLI sign-ins and native workstation file workflows therefore still require desktop. See [validation status](#validation-status) before using the web mode with real data.

## Launch

Install dependencies with `npm ci`, then use `npm run local` for desktop or
`npm run local -- web` to start the headless server and Vite together. The web
launcher uses `src-web/dev.yml` and stores its development key in
`.datatrip-web/local-workspace-key` unless `DATATRIP_WEB_WORKSPACE_KEY` is set.
The first launch compiles the Rust dependencies. Press Ctrl+C to stop the launcher and its child processes.

Desktop uses the existing commands:

```sh
npm ci
npm run tauri dev
npm run tauri build
```

Desktop uses Vite port `1420`, builds `dist/`, and uses Tauri's existing app directories and OS keychain. It does not read web configuration or build Wasm.

Web development uses two terminals from the repository root:

```sh
export DATATRIP_WEB_WORKSPACE_KEY="$(openssl rand -hex 32)"
npm run web:server -- --config src-web/dev.yml
```

```sh
npm run web:dev
```

Open `http://127.0.0.1:1421`. Vite proxies `/api` to `127.0.0.1:8080`. `DATATRIP_WEB_DEV_PORT` and `DATATRIP_WEB_API` override the Vite endpoints; set `publicOrigin` in the server config to match the browser origin. `src-web/dev.yml` explicitly opts in to guest access, allows a disposable PostgreSQL server on `127.0.0.1:55432`, and writes to `.datatrip-web/dev`. Use a dedicated directory per instance; never point web at the desktop app directories.

To build and run web without Vite:

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.130
npm ci
npm run web:build
cargo build --locked --release --manifest-path src-web/Cargo.toml
src-web/target/release/datatrip-web --config /path/to/web.yml
```

Set `assetsDir: dist-web` when launching from the repository root. The server serves the assets and `/api/v1` at the same origin. `npm run web:wasm` also enables the worker in dev mode. Without the worker, the browser asks permission to upload the import file for native preview. The native importer executes the import in both modes.

## Instance configuration

The server validates YAML on startup. Supply a random, stable **32-byte hex** workspace key in the environment variable named by `workspaceKeyEnv`. Keep it outside the data volume and back it up alongside the volume. A different key cannot decrypt an existing workspace. Local users are configured by stable IDs, unique usernames and Argon2id password hashes. To create or rotate a password:

```sh
src-web/target/release/datatrip-web hash-password
```

Replace `passwordHash` and restart. Browser sessions are process-local; every restart invalidates them. Keep the user's `id` the same to preserve the workspace on username/password changes. Removing an account revokes its login but does not delete its workspace. OIDC identities use the verified issuer and subject.

Connection and profile passwords, tokens, and API keys are stored encrypted. Uploaded certificates and private-key files are workspace files and rely on volume encryption for at-rest protection.

Login-required example:

```yaml
bind: 0.0.0.0:8080
publicOrigin: https://datatrip.example.org
dataDir: /data
assetsDir: /app/dist-web
workspaceKeyEnv: DATATRIP_WEB_WORKSPACE_KEY
auth:
  oidc:
    issuer: https://login.example.org/
    clientId: datatrip
    clientSecretEnv: DATATRIP_OIDC_CLIENT_SECRET
  local:
    users:
      - id: operator-1
        username: operator
        passwordHash: "<replace with the generated Argon2id hash>"
databaseEndpoints:
  - 10.42.1.20:5432
```

Omit `local` or `oidc` for a single sign-in method. Register `https://datatrip.example.org/api/v1/login/oidc/callback` with the instance identity provider. OIDC discovery failure prevents startup, even with other configured modes. For mixed mode add `anonymous: true` under `auth`. For guest-only mode use `auth: { anonymous: true }`; expired guests are removed. With the key omitted, anonymous access is disabled.

`databaseEndpoints` accepts IP:port entries, including Redis Sentinel endpoints and their advertised nodes. PostgreSQL, MySQL/MariaDB, SQL Server and Redis use these entries; SQLite uses workspace file IDs. `sshEndpoints` similarly restricts SSH profiles; configure the bastion to restrict forwarded destinations. `vaultServers` accepts a list of approved base URLs, `openaiUrl` and `ollamaUrl` take a single approved base URL each. Use browser uploads for credentials that are files. Hosted Vault uses workspace tokens and supports an independent `/api/v1/vault-oidc/callback` over HTTPS; workstation token files and environment credentials are desktop-only. Hosted AI never invokes the workstation CLI. Restrict database users' privileges at the database; UI prompts and session read-only settings are safeguards and cannot replace database grants.

`kafkaNetworkPolicy` defaults to `false`. Only enable it when deployment egress filtering is in place for **all** broker addresses and the bootstrap endpoints are listed in `databaseEndpoints`. librdkafka follows broker advertisements, so an initial-address allowlist alone does not constrain discovery. Apply default-deny egress for the runtime, including DNS, OIDC, Vault, AI, SSH and the allowed database destinations. Use trusted database servers and provider endpoints.

Set `readOnly: true` to force read-only connections for the entire hosted instance. Provision database roles with matching grants, especially for stored functions or routines whose side effects cannot be inferred from a query.

## OCI image and Kubernetes contract

```sh
docker build -t datatrip-web:local .
docker volume create datatrip-web-data
export DATATRIP_WEB_WORKSPACE_KEY="<32 hex-encoded bytes>"
docker run --name datatrip-web --read-only --tmpfs /tmp \
  -p 127.0.0.1:8080:8080 \
  --mount type=volume,src=datatrip-web-data,dst=/data \
  --mount "type=bind,src=$PWD/src-web/container.example.yml,dst=/etc/datatrip/web.yml,readonly" \
  -e DATATRIP_WEB_WORKSPACE_KEY datatrip-web:local
```

Here “32 hex-encoded bytes” means **64 hex characters**; generate the value with `openssl rand -hex 32`. The example config is for local guest smoke tests.

- Use one replica. Use `Recreate` or another rollout strategy that releases the old mount before the new process starts. The web process locks its own data directory.
- Run as UID/GID `10001` with read-only root files, a writable persistent `/data` volume and separate writable `/tmp`. Mount the config read-only and inject the workspace key and any OIDC client secret through the deployment secret mechanism.
- Terminate TLS at the ingress; configure the external HTTPS `publicOrigin`. Keep `/api/v1` and application assets same-origin. Disable proxy buffering for SSE and use upload limits consistent with the server. The image binds `8080` with the sample config; point probes to the configured internal port and set `DATATRIP_PROBE_PORT` when changing it.
- Probe `/livez` and `/readyz` independently. Readiness becomes unavailable during drain; customer database failures are application errors. Allow `drainSeconds` (default 15) plus runtime cleanup and ingress propagation in the termination grace period.
- Size memory, CPU and disk for the concurrent workload. The server limits database connections to 16 per browser session, regular jobs to eight per session, and long-running jobs to two per session; it closes idle connections after `idleSeconds` (default 900). Uploads are capped at 128 MiB per file, 512 MiB of file payloads per workspace. Provision additional room for SQLite growth, settings, history, temporary file writes and concurrent workspaces.
- A session/transaction belongs to the running process. After restart, sign in again, reopen the saved console and reconnect. The web adapter does not automatically replay a SQL statement after transport loss; in-flight writes can have an unknown outcome. Long jobs have a session-scoped run ID and terminal state while that session survives.

## Adding shared behavior

Implement native behavior and wire types in `crates/datatrip-core/src/` (SQL and engine-specific work in `db/`). Register thin Tauri commands under `src-tauri/src/` and explicit HTTP operations in `src-web/src/operations.rs`. The web boundary owns authorization and maps opaque file references. Expose the operation in `src/api.ts`; UI components live in `src/ui/`. For import format changes, edit `crates/datatrip-import-format/src/`; `crates/datatrip-wasm/` only binds preview.

`node scripts/check-operation-parity.mjs` checks registrations against the shared API. `scripts/test-web-postgres.mjs` can run the same scenario through both transports:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --example ipc_fixture
DATATRIP_TEST_IPC=src-tauri/target/debug/examples/ipc_fixture node scripts/test-web-postgres.mjs
node scripts/test-web-files.mjs
DATATRIP_TEST_EXPIRY=1 node scripts/test-web-auth.mjs
```

## Validation status

| Workflow | Local result |
| --- | --- |
| Desktop | Build without `dist-web` or generated Wasm; Linux dev startup and packaged `.deb`/AppImage startup. A disposable key produced a signed Linux AppImage. Pre-port settings, connections, profiles, workspace JSON and history reads checked through Tauri IPC dispatch. Windows and macOS installers and an actual signed update download/install were not run. |
| PostgreSQL 18 and MariaDB 11 | Shared fixtures pass through Tauri IPC dispatch (mock runtime) and real HTTP. PostgreSQL covers error positions, paging, commit/rollback, cancellation and reconnect; MariaDB covers password authentication, query wires and commit/rollback. |
| Hosted SQLite and cross-source | SQLite query, native preview and CSV/TSV/JSON/SQL/Markdown export bytes matched through Tauri IPC dispatch and HTTP. Hosted DDL, row edits, SQLite/PostgreSQL joins, table import with progress, SQL scripts, and a 20 MiB streamed upload/paced download passed. A downloaded SQLite snapshot included only committed changes while the original had an open write transaction. |
| SQL Server 2022 | The same authentication, query, commit/rollback and error-line fixture passed through Tauri IPC dispatch and HTTP. |
| Redis/Sentinel and Kafka | Redis browse/TTL/delete/read-only, Sentinel discovery, and Kafka 4.1 broker discovery, topic create/delete, produce and consume passed through Tauri IPC dispatch and HTTP. A Sentinel replica promotion and reconnect passed over HTTP. Kafka failover, group administration and production prompts were not exercised. |
| DataTrip sign-in | Local-only, OIDC-only, both, guest-only and mixed passed; startup rejection, rate limiting, PKCE, wrong state/audience, logout, rotation, expiry, named persistence and graceful transaction rollback checked. Firefox exercised switching identities in the same browser. |
| Browser and Wasm | Chromium, Firefox and WebKit matched native preview, including invalid input and explicit-upload fallback. Browser-granted save-back was not covered by the automated browser fixture. |
| External credentials | Hosted Vault/SSH and OpenAI-compatible/Ollama adapters are wired. Local HTTP fixtures cover Vault profile token lookup and dynamic-secret result shape, AI model listing and generation, and secret isolation. Real provider authentication, Vault OIDC, mTLS and credential recovery still require integration tests. |
| Container | Built the multi-stage OCI image with equivalent Docker Hub base images mirrored on Public ECR (`RUST_IMAGE`, `NODE_IMAGE`, `RUNTIME_IMAGE`). `bash scripts/test-web-image.sh datatrip-web:validated` passed: non-root and read-only root, same-origin serving, Wasm MIME/cache, probes, persistence after restart and rollback of a live SQLite transaction. |
| Workstation access | Companion, enrollment and revocation remain unimplemented. |

The operation parity check establishes registration. The fixtures above exercise representative paths, not the complete per-engine matrix from the implementation plan.

Baseline: commit `2bce6e310bbf8e14b471cc6ec7d36b51e7bcaab7` passed the desktop frontend build, 71 JS checks and Linux `cargo check`, and built and launched the `.deb`. The baseline Rust suite was 79/80: JSON-flattening sorted nested keys alphabetically. The port preserves the contract's original source order, and the moved core/parser suite passed 80/80. Baseline strict desktop Clippy reported nine lints; the desktop and web entry packages now pass strict Clippy (dependency lints are reported separately when Clippy is run on the core itself).

The Linux signing smoke exposed a configuration discrepancy: the updater read the compiled-in public key, but the Tauri 2 CLI bundler also requires that key in its merged updater config. Release CI now gives the same repository public key to both. The release tag, installer matrix and signing secrets retain their existing entry points.

Representative validation commands (with the hosts and disposable credentials configured as in the fixtures):

```sh
npm run typecheck
npm run build
npm run web:build
for script in scripts/test-{ai-context,data-tools,federation,hibernate,ops}.mjs; do node "$script"; done
node scripts/check-operation-parity.mjs
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path crates/datatrip-core/Cargo.toml
cargo test --manifest-path crates/datatrip-import-format/Cargo.toml
cargo clippy --locked --manifest-path src-web/Cargo.toml -- -D warnings
cargo build --locked --release --manifest-path src-web/Cargo.toml
npm run tauri -- build --debug --bundles deb
npm run tauri -- build --debug --bundles appimage
DATATRIP_TEST_ORIGIN=http://127.0.0.1:8082 DATATRIP_TEST_MYSQL=127.0.0.1 \
  DATATRIP_TEST_MSSQL_PASSWORD='<disposable SQL Server sa password>' \
  DATATRIP_TEST_IPC=src-tauri/target/debug/examples/ipc_fixture node scripts/test-web-postgres.mjs
DATATRIP_TEST_ORIGIN=http://127.0.0.1:8082 DATATRIP_TEST_FED=1 DATATRIP_TEST_SQLITE_SNAPSHOT=1 \
  DATATRIP_TEST_LARGE_FILES=1 node scripts/test-web-files.mjs
DATATRIP_TEST_KAFKA=127.0.0.1:59092 node scripts/test-web-brokers.mjs
DATATRIP_TEST_REDIS=127.0.0.1:56379 DATATRIP_TEST_SENTINEL=127.0.0.1:56381 \
  DATATRIP_TEST_REDIS_FAILOVER=/path/to/redis-cli node scripts/test-web-brokers.mjs
DATATRIP_TEST_EXPIRY=1 node scripts/test-web-auth.mjs
```

### Performance

Linux x86-64, Core i7-13620H, Node 26.13.1, Vite 6.4.6. Node's `gzipSync` counted JS needed through the initial IDE bootstrap: **504.07 → about 387 kB** (−23%, under 400 kB). Initial CSS was 31.27 → 32.41 kB. First use downloads an additional 76.94 kB for SQL formatting, 92.03 kB for import (including 74.76 kB Wasm), 9.75 kB for connection settings, and 13.89 kB for application settings.

`scripts/test-web-browser.mjs` measures five fresh contexts against the built web assets. The pre-port timing baseline serves the original desktop bundle with only its startup IPC mocked. It is a shell-render comparison, not an equivalent authenticated/database workload.

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  DATATRIP_TEST_ORIGIN=http://127.0.0.1:8082 \
  DATATRIP_TEST_BASELINE_ORIGIN=http://127.0.0.1:8084 \
  DATATRIP_TEST_DEV_ORIGIN=http://127.0.0.1:1421 \
  DATATRIP_TEST_BROWSER_SQL=1 node scripts/test-web-browser.mjs
```

Serve `dist/` built from the baseline revision on port `8084`. On port `8082` run the headless server with guest access and the disposable PostgreSQL endpoint; port `1421` is used to force the browser worker fallback against Vite. Leave out `DATATRIP_TEST_BROWSER_SQL` for preview and startup smoke only.

| Metric | Chromium 158 | Firefox 159 | WebKit 27.2 |
| --- | ---: | ---: | ---: |
| Median cold navigation to shell, pre-port → web | 270 → 353 ms | 574 → 327 ms | — → 770 ms |
| Restored editor visible | 626 ms | 255 ms | — |
| First query through first result grid | 350 ms | 1,035 ms | — |
| 12 MB CSV worker preview (bounded sample) | 306 ms | 199 ms | 391 ms |
| Expand grid to 8,000 rows and scroll to last row | 1,249 ms | 5,711 ms | — |

Chromium heap delta for the 8,000-row scenario was 3.9 MiB. Comparable pre-port first-query, preview, and heap measurements are unavailable, because the pre-port bundle did not have a browser transport for these operations.
