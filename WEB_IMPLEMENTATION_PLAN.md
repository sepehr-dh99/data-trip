# DataTrip web mode implementation plan

## Goal and release criteria

Ship DataTrip as both a standalone desktop app and a hosted browser app from one codebase. A fix or new database feature should be implemented once in the shared TypeScript UI and Rust core and become available in both launch modes. Platform-specific work belongs at the boundary: transport, files, credentials, sign-in, window behavior, and deployment.

- Desktop keeps its existing launch and installer commands, Tauri IPC contract, data locations, keychain entries, and signed updater. It must continue to run without a web server, an account, or a Wasm build.
- Web uses a separate, opt-in entry point, dev port, build output, and headless Rust executable. Both launch modes can run on the same machine at the same time.
- Each web instance configures its own OIDC provider and/or local username/password accounts. Login-free access is available only when explicitly enabled in that instance's web config.
- The first web release gives each user a private workspace and their own data. Users can log into the same instance with separate accounts; shared workspaces and invitations are a later feature.
- Browser support covers the full set of desktop IDE workflows and database backends. Workstation-bound workflows use browser-granted access or an optional local execution companion where the browser cannot provide equivalent behavior. An early hosted preview may ship in stages; it is not the full-parity release.
- WebAssembly ships as part of web mode for local import previews, built from the same Rust parsing code used by desktop. Native database drivers and network access stay on the selected execution host.
- Package web mode as a container suitable for Kubernetes. Helm and deployment manifests are outside this change.

## Starting point

| Existing boundary | Implication for the port |
| --- | --- |
| [`src/main.ts`](src/main.ts) boots the Vite/TypeScript UI; [`src/api.ts`](src/api.ts) wraps Tauri `invoke`. | Keep the UI and API call sites. Swap transport at startup and adapt the components that use Tauri dialogs and events directly. |
| [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) constructs state and registers commands. [`commands.rs`](src-tauri/src/commands.rs), `ddl.rs`, `sqlfile.rs`, `import.rs`, and `ai.rs` mix Tauri types with implementation code. | Move behavior behind plain Rust service functions a command group at a time. Keep the Tauri functions as thin wrappers. |
| [`session.rs`](src-tauri/src/session.rs) ties a console session to a live physical connection. [`store.rs`](src-tauri/src/store.rs) combines JSON, SQLite history, and OS keyring access. | Preserve transaction and cancellation semantics. Give the web runtime explicit ownership, storage, and lifetimes. |
| [`importfmt.rs`](src-tauri/src/importfmt.rs) is standard-library-only Rust. | It is a suitable starting point for a small Wasm target shared with the native importer. |

Baseline from a temporary checkout: `npm run build` and Linux `cargo check` passed; all 71 existing JavaScript checks and 11 standalone Rust import tests passed. The initial Vite bundle was **504 kB gzip JavaScript + 31 kB gzip CSS**. Desktop launch and installer builds have yet to be verified as part of the baseline.

## Target architecture

```text
                            Shared TypeScript UI and typed API
                        /                                      \
          Desktop Vite entry point                      Web Vite entry point
                        |                                      |
              Tauri IPC + events                  HTTPS API + job events
                        |                                      |
                Desktop adapter                        Headless Rust server
                        |                                      |
                 Shared Rust core  <--------------------------+
                        ^
                        |
             Optional local companion for web
             workspaces that run on a user's machine

            Shared Rust import parser -> Wasm -> browser worker
```

### Code and contract boundaries

- Keep feature code in the existing `src/ui/` modules. Select `desktop` or `web` explicitly in the entry points; feature components use the typed API and platform capabilities rather than inspecting Tauri globals. Keep OS keyboard labels separate from native window or menu capabilities.
- Keep `src/api.ts` as the frontend façade and preserve [`CONTRACT.md`](CONTRACT.md), including existing command names, camelCase arguments, optional/default values, and error messages and positions the UI interprets. HTTP can supply status codes while preserving the shared application result and error shapes.
- Start with three frontend boundaries: **commands** (typed request/response), **events** (subscribe/unsubscribe), and **files** (pick, open, save, upload/download or watch as supported). Keep updater and native menu behavior in desktop startup. Add a capability only when a real workflow needs it.
- Proposed Rust layout: `crates/datatrip-core/` for runtime-independent services and native drivers, `crates/datatrip-import-format/` for pure parsing shared by the core and a small `crates/datatrip-wasm/` binding, `src-tauri/` for desktop wrappers, and `src-web/` for the headless server. Keep the existing manifests and CI entry points working. Extract a shared method when its second caller needs it rather than moving every module at once.
- Share Rust request/response types. Use an explicit list of supported operations per transport, with contract fixtures checked against both adapters. A new shared feature adds its behavior once; where it needs a new operation, register it at both boundaries and exercise it in the parity suite. Add a check that flags a shared UI operation missing from either adapter. Desktop-only shell actions have explicit entries in the parity matrix.
- Keep web state, networking policy, and authentication at the web boundary. The shared services take the authorized state and inputs they need; they do not depend on an HTTP request, Tauri state, or an ambient global user.

### Web login and instance configuration

An instance may enable any combination of **OIDC**, **local accounts**, and **anonymous access**. Show only the configured ways to enter. With anonymous access and a login method enabled, offer **Continue without signing in** alongside sign-in. An anonymous-only instance opens the IDE directly.

Illustrative server-side web config (names are proposed):

```yaml
auth:
  anonymous: false
  oidc:
    issuer: https://id.example.com
    clientId: datatrip
    clientSecretEnv: DATATRIP_OIDC_CLIENT_SECRET
  local:
    users:
      - id: db-operator
        username: operator
        passwordHash: "<Argon2id password hash>"
```

- **OIDC:** Use the instance's configured provider and public origin for login. Use Authorization Code with PKCE; validate issuer, audience, state, and nonce. Identify users by issuer and subject. DataTrip sign-in is separate from connecting to HashiCorp Vault through Vault OIDC.
- **Local accounts:** The instance administrator defines users in the web config. Give each user a stable ID and a unique username within that instance. Store Argon2id hashes and provide a local hash-generation command. Validate account config at startup, rate-limit login attempts, and return a generic invalid-credentials message. Apply account changes on restart and invalidate sessions for removed users or changed credentials. Self-registration, password reset, account management UI, and linking local and OIDC identities can be added later.
- **Anonymous access:** Default to `false`, including when the key is omitted. For an anonymous-only instance, set `anonymous: true` and omit OIDC and local accounts. Each browser receives a server-generated guest identity and private workspace scoped to its session. Guest sessions expire and their temporary workspace data is cleaned up; they cannot see other guests' or named users' workspaces. Signing in switches identity without automatically merging guest data into the account.
- **Session and startup rules:** All three paths use the same server-side session and workspace authorization. Over HTTPS use a secure HTTP-only session cookie, rotate it on identity changes, and validate origin/CSRF for mutations. An instance with no enabled access method fails with a configuration error; a missing or unavailable login provider must never silently enable anonymous access. Configured credentials and the OIDC client secret are server-only and must not appear in the frontend bundle or logs.

### Private workspaces now, sharing later

- Provision one private workspace per named account on first sign-in. The same account reopens its workspace on a later sign-in or from another browser. Anonymous access gets a temporary private workspace tied to the guest session. Sharing a workspace between accounts is unavailable in the initial release.
- Scope all user data to the workspace: saved connections, credentials and profiles, settings, explorer layout, queries and console tabs, history, uploaded files and SQLite databases, and import/export artifacts. Scope running sessions, cancellation, AI jobs, and progress events to the authorized workspace and owning session. Browser caches and preferences that contain user data must also be workspace-scoped; discard active UI state and subscriptions on logout or identity change.
- Give each workspace a stable internal ID and owner independent of the login method or username. Persist resource ownership by workspace ID and resolve access in one server-side authorization check. For the initial release that check is owner-only, and the server selects the account's or guest's workspace.
- Later, let users create shared workspaces and invite other accounts into them. Extend the authorization check to consult membership for those workspaces, keeping each user's private workspace private. Invitations, membership management, roles, and shared workspace UI are outside the initial port.

## Implementation phases

### 0. Freeze the desktop baseline

1. Inventory [`src/api.ts`](src/api.ts), the Rust handlers, direct Tauri imports, and desktop events. Record each user workflow, transport operation, current behavior, web equivalent, and test. Use the source alongside the README so Redis/Sentinel and Kafka are included.
2. Record successful desktop startup and installer smoke tests on Linux, Windows, and macOS through the existing build flow. Capture representative desktop settings, workspace, history, and connection/profile fixtures from the existing formats.
3. Set up a repeatable browser performance scenario: cold load, first usable editor, first connection/query, large result scrolling, and a large CSV preview. Use the existing bundle as the transfer-size baseline and collect timing and memory baselines as soon as the corresponding web workflows run.

**Exit:** Baseline failures are documented independently of the port. The operation inventory and parity matrix are reviewable.

### 1. Separate the entry points and prove a shared vertical slice

1. Extract the common UI bootstrap. Keep `index.html`, desktop port `1420`, desktop build output `dist`, and [`tauri.conf.json`](src-tauri/tauri.conf.json)'s default flow in place. Add explicit web scripts (proposed: `npm run web:dev` and `npm run web:build`), a separate Vite config and output (`dist-web`), and a configurable dev port. Proxy `/api` to the headless server in development so browser requests still use the frontend origin.
2. Pass the selected platform into the shared frontend at startup. Replace direct Tauri imports in shared components as their workflows migrate. Show the in-app menu on browser macOS and keep native menu and title-bar conventions on desktop.
3. Add a minimal headless Rust server, for example with Axum, with the same-origin static frontend, basic health endpoints, and a versioned API. Use explicit, typed handlers. Web handlers never dispatch arbitrary Tauri commands. Bind development access to loopback, explicitly enable anonymous access in a separate dev config for the first slice, and use isolated web state and a disposable database.
4. Prove the architecture with settings load/save, connection listing, and a PostgreSQL flow from test connection through query result and close. Route Tauri and HTTP through the same native operations and use the same UI.

**Exit:** Desktop and browser launch concurrently using different ports and data roots. The same fixture query and error appear correctly in both modes. The headless build has no Tauri, GTK, or WebKit dependency.

### 2. Build the hosted runtime and port the database workflows

1. Implement the web access configuration above: OIDC, config-defined local accounts, and explicitly enabled anonymous access. Resolve the named or guest session and its private workspace on the server before enabling database operations. Check workspace ownership on every request that accesses a resource, including event subscriptions and downloads.
2. Persist settings, explorer layout, saved consoles, history, connections, and profiles under the authorized workspace. Preserve desktop's existing stores. For web, use persistent workspace metadata and a secret store with keys kept outside the data volume. Carry over password/token update semantics (`null` keeps, empty clears where supported). Commit related metadata and secret changes consistently, including on delete, failure, and retry. Do not expose saved secrets in responses, browser storage, or logs.
3. Scope live database sessions, redirects and callbacks, tunnel leases, AI runs, import/export jobs, and events to the owner. Separate durable workspace state from live browser sessions. Keep one physical DB connection per console session; transport loss does not implicitly commit, repeat a write, or transfer a transaction. Enforce idle limits on the server, cancel or close abandoned work, and release resources during logout and shutdown. Never treat a session ID by itself as authorization.
4. Use bounded JSON responses for normal queries and retain paging and grid virtualization. Keep cancellation on a separate request that can reach the active job. For long-lived jobs, use an authorized event stream (SSE initially) with run IDs and an authoritative terminal state that can be recovered after reconnect. Bound queues and make retry semantics explicit for jobs and mutations.
5. Port explorer/catalog browsing, execution, transactions, cancellation, reconnect, history, row edits, parameter prompts, DDL, table designer, explain plans, sessions/locks, and federation through the same operations the desktop wrappers call. Then complete Redis standalone/Sentinel and Kafka administration and browsing using the existing drivers and engine-specific permission checks.
6. Apply deployment egress policy to database, SSH, Vault, and configured AI destinations and to secondary destinations discovered by drivers, including Sentinel and Kafka. Preserve TLS and SSH host-key handling. Enforce read-only/authorization at the server and driver boundary and preserve production confirmation UX; the browser cannot grant itself permissions. Set explicit per-user bounds on connections, rows/response bytes, statement duration, federation memory, and concurrent jobs.

**Exit:** All six backend families work through the hosted UI. Integration coverage demonstrates all three access paths, workspace isolation, transactions, cancellation, reconnect behavior, and bounded resource use. The desktop can still load pre-port state and exercise the existing IPC contract.

### 3. Complete file, credential, and AI workflows

1. Treat browser-picked files as `File` objects or granted handles. Upload to the user's or guest's authorized workspace only when host-side operations need the bytes. Pass opaque file IDs for uploads, certificates, SSH keys, SQL scripts, and SQLite addresses backed by workspace files. Resolve IDs on the server with ownership, purpose, and size checks; keep them separate from display names. Never interpret a browser-supplied path as a server path. Use finite quotas, atomic completion, and cleanup for partial uploads and expired artifacts.
2. Adapt SQL open/save/save-as, drag-and-drop, Recent Files, conflict handling, DataGrip import, and query/data exports. Use browser downloads everywhere and browser-granted persistent handles for save-back/change checks where supported. For large SQL scripts and data imports, stream/chunk the upload, then reuse the existing native script runner and importer with the same progress, cancellation, batch, and transaction behavior. Write exports incrementally to a bounded job artifact and stream downloads without holding the entire output in browser or server memory. Verify CSV/TSV/JSON/SQL/Markdown bytes against desktop fixtures.
3. Support uploaded or workspace-created SQLite files with consistent import/export semantics. Ensure SQLite opened for arbitrary user SQL cannot access application metadata, secrets, or another workspace's files. Verify isolation for file-affecting SQLite features; use an isolated runtime if the in-process driver cannot enforce the boundary. Keep native SQLite behavior in desktop mode.
4. Implement server-owned Vault profile secrets and dynamic credentials. Replace the desktop loopback OIDC callback in web mode with an HTTPS callback tied to the initiating workspace, sign-in state, and expiry; preserve cancel and expired-token recovery. Use scoped uploaded material or administrator-configured secret references in place of workstation files or process environment variables. Keep desktop token sources unchanged.
5. Support hosted OpenAI-compatible and Ollama providers through workspace configuration and secrets. Reuse AI request construction, provider behavior, cancel, production restrictions, and SQL review/apply UI. Keep CLI execution attached to a workstation through the local adapter below; never launch all browser users' jobs under one host-side CLI login.
6. Complete browser shell behavior: settings and workspace restore, clipboard, browser-reserved shortcut alternatives, menu/help, and version display. Preserve the desktop installer and updater; web upgrades are server deployments. Handle a lost browser save or connection without presenting the workspace as successfully saved.

**Exit:** The hosted path covers the database and IDE workflows using assets available to the server or browser. File and secret behavior is verified across supported browsers, with workstation-only cases explicitly tracked for phase 5.

### 4. Ship Wasm and optimize the web path

1. Reuse the existing import parser and isolate a byte-oriented preview entry point from filesystem and Tauri calls. Compile it for `wasm32-unknown-unknown` with a thin JS binding. In the browser, pass a bounded file sample to a dedicated worker for encoding, delimiter and format detection, preview rows, and type inference. Keep the native importer authoritative for execution. Use identical input fixtures to compare parser results, warnings, and errors between native and Wasm builds.
2. Load the worker and Wasm only when preview is opened. Fall back to the authorized native preview route when the worker cannot load or handle an input; make any required upload explicit. Keep the first implementation single-threaded inside the worker. Desktop does not load the worker or need the Wasm toolchain.
3. Measure the production web bundle. Lazy-load `sql-formatter` and measured heavy feature panels, minimize duplicate assets, and keep existing results-grid virtualization and editor hibernation. Serve hashed JS/CSS/Wasm with immutable caching and compression, `index.html` with revalidation, and workspace data and events without shared caching. Serve Wasm as `application/wasm`.
4. Compare cold-load transfer size, time to usable editor, preview responsiveness, and large-result memory with phase 0. Use **under 400 kB gzip for initial JavaScript** as the initial target against the measured 504 kB baseline, excluding optional chunks and Wasm until invoked. Record lab conditions and measure compressed total bytes for the first use of each deferred feature. Test under upload/download backpressure and a slow client.

**Exit:** Web mode ships a Wasm-backed preview with a passing native/Wasm parity suite and fallback. The initial JS target is met or the measured tradeoff is recorded for upstream review. Neither installer behavior nor the desktop startup bundle regresses.

### 5. Close workstation-bound parity

1. Build an optional local execution companion from the shared native operations and existing platform adapters. Keep it opt-in and independently launched; opening the normal desktop app does not start a listener or connect to a hosted deployment.
2. Let a browser workspace explicitly select `Hosted` or `This computer` as its execution host. Pair the companion to the server-resolved account or guest session using a short-lived, single-use enrollment flow, support revocation, and require consent before sending file or CLI requests. Guest pairings expire with the guest session. Use an outbound authenticated channel from the companion and a typed operation allowlist. Keep existing local CLI credentials, native file access, and keychain secrets on the workstation. Use the same UI and API shapes for both execution hosts.
3. Route local database and cross-source sessions to the companion when selected, including connections reachable only from the laptop or its VPN. All sources in a cross-source execution use the same execution host. Mixing cluster-only and workstation-only sources in one query is a new workflow outside this parity requirement.
4. Implement user-selected local SQL file save-back and change detection and reuse local Vault token sources and CLI providers (Codex, Claude Code, OpenCode, and local Ollama, as applicable). Display which host will access files, credentials, and data. Show clear offline and permission errors; never silently switch hosts or repeat writes after losing the companion.

**Exit:** A browser user can choose a capable execution host for every desktop IDE workflow, including laptop-only databases, desktop-style file behavior, and already-signed-in CLI providers. The browser remains usable for hosted workspaces when no companion is installed.

### 6. Package and release web mode independently

1. Build a multi-stage OCI image with the web assets and the headless Rust executable. Use a non-root runtime, a read-only root filesystem where practical, and separate writable mounts for persistent workspace data and temporary files. Build and start the image without desktop libraries or the Tauri toolchain.
2. Document image build and run commands and the Kubernetes deployment contract: configurable bind address/port, public origin, auth and secret configuration, persistent volume, temporary space, probes, TLS termination, resource limits, and egress policy. Include config examples for login-required, mixed, and anonymous-only instances and document how to rotate local credentials. `/livez` checks the process; `/readyz` checks that the server can accept work and turns unhealthy when draining. Treat dynamic customer database availability as application state rather than pod liveness.
3. Start with one replica and a rollout strategy that avoids overlapping writers to the same volume. On termination, reject new sessions/jobs, drain within a configured deadline, and close remaining connections and transactions. A live DB session belongs to its process; document how consoles recover after restart. Horizontal scaling requires explicit session routing and shared durable state and is a later design.
4. Add independent web checks and image smoke tests alongside [the existing desktop release workflow](.github/workflows/release.yml). Keep desktop version tags, installers, and signing behavior intact. Ship preview milestones separately from the full-parity release.

**Exit:** A single image serves DataTrip over HTTPS through an ingress using the instance's configured login or guest access, persists named workspaces on restart, and shuts down cleanly under normal orchestration. The desktop release pipeline passes without building web or Wasm artifacts.

## Parity verification

Run shared behavioral scenarios through both Tauri IPC and the browser HTTP adapter; use adapter-specific tests for boundaries with intentionally different implementations. Prefer the same fixtures and assertions over two independently maintained suites.

| Scenario | Acceptance |
| --- | --- |
| SQL engines: PostgreSQL, MySQL/MariaDB, SQLite, SQL Server | Connections, schema, execution, params, edits, DDL/designer, explain, sessions/locks where supported, paging, history, cancel, and manual commit/rollback match existing engine behavior. Preserve output/error shapes. |
| Redis/Sentinel, Kafka | Browsing and existing admin/console workflows work through the native drivers. Confirm read-only behavior and production prompts; cover Sentinel failover and Kafka broker discovery. |
| Cross-source queries | The same fixtures produce equivalent results and execution steps. Large source pulls stay within resource limits. |
| Imports, exports, and SQL files | Matching preview and export fixtures, large streamed transfers, cancellation, SQL dialect delimiters, partial failure, save conflicts, and restore. Test both standard browser fallback and workstation-backed file behavior. |
| DataTrip login and guest access | OIDC and config-defined local logins work independently and together. Local credentials can differ between instances; removed users and changed passwords invalidate their sessions. Missing `anonymous` behaves like `false`; guest-only and mixed modes work when explicitly enabled. Invalid config fails startup, and an OIDC failure never silently starts a guest session. Test login throttling, expiry, and logout. |
| Private workspace isolation | Two named accounts and two guests on the same instance cannot list, fetch, change, download, subscribe to, or cancel each other's resources. Switching accounts in one browser clears the previous user's active UI state. A named account reopens its own workspace after signing in from another browser. |
| Data source credentials | Vault static/dynamic/OIDC flows, SSH host trust, TLS uploads, AI provider discovery/configuration and cancellation, and workstation CLI reuse. Saved credentials are scoped to their workspace and never returned to the browser. |
| Desktop regression | Existing data fixtures open without migration, desktop starts without web services, packaging and updater remain functional, and web can run concurrently with desktop. |
| Browser, Wasm, and container | Test Chromium, Firefox, and WebKit, including worker failure and browser-specific picker behavior. Verify image startup, probes, data persistence, termination, and recovery of an idle console after restart. |

For future changes, add one feature scenario to the shared suite and run it in both modes. A regression where one mode lacks a shared feature blocks the change; an intentional platform difference needs a named equivalent, such as browser download for a native save dialog.

## Upstream review sequence

1. Land the baseline fixtures and platform boundaries with no desktop behavior changes.
2. Land the headless build and first shared vertical slice behind the explicit web launch mode.
3. Port command groups incrementally, keeping each merge request independently testable: sessions and SQL, Redis/Kafka and federation, then files, credentials, and AI.
4. Land Wasm, performance improvements, and the independent container build as reviewable changes. Package the hosted preview as soon as the corresponding security and runtime checks pass.
5. Land the opt-in companion and close the remaining parity cases before labeling web mode fully equivalent to desktop.
