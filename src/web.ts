import type { Platform } from "./platform";
import { createWebFiles } from "./webFiles";
import "./styles/web.css";

type BrowserSession = { workspaceId: string; binding: string; guest: boolean };
type Entry = { session: BrowserSession | null; anonymous: boolean; local: boolean; oidc: boolean; version: string };

const mount = document.getElementById("app")!;
const entryPath = "/api/v1";
const identity = typeof BroadcastChannel === "function" ? new BroadcastChannel("datatrip-identity") : null;
const pageRequests = new AbortController();

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(entryPath + path, { cache: "no-store", credentials: "same-origin", ...options });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw { ...error, status: response.status };
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

function post<T>(path: string, args: unknown, binding?: string): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(binding ? { "X-DataTrip-Session": binding } : {}) },
    body: JSON.stringify(args),
    signal: pageRequests.signal,
  });
}

function reload(url = "/"): void {
  pageRequests.abort();
  mount.replaceChildren();
  location.replace(url);
}

async function startWorkspace(session: BrowserSession, version: string, bootstrap?: typeof import("./bootstrap")): Promise<void> {
  const preferences = session.guest ? memoryPreferences() : {
    getItem: (key: string) => localStorage.getItem(`dt.web.${session.workspaceId}.${key}`),
    setItem: (key: string, value: string) => localStorage.setItem(`dt.web.${session.workspaceId}.${key}`, value),
  };
  const files = createWebFiles(session.binding, session.workspaceId, session.guest, pageRequests.signal, request, post);
  const platform: Platform = {
    ...files,
    mode: "web",
    version,
    preferences,
    async invoke<T>(name: string, args?: Record<string, unknown>): Promise<T> {
      try {
        return await files.invoke<T>(name, args);
      } catch (error) {
        if ((error as { status?: number }).status === 401) reload("/?signedOut=1");
        throw error;
      }
    },
    listen: (name, receive) => listen(session.binding, name, receive),
    signOut: () => {
      void post("/logout", {}, session.binding).then(() => {
        identity?.postMessage(null);
        reload("/?signedOut=1");
      }, (error) => {
        if (error.status === 401) reload("/?signedOut=1");
        else alert("Could not sign out. Try again.");
      });
    },
  };
  const verify = async () => {
    try {
      const active = await request<Entry>("/session");
      if (active.session?.binding !== session.binding) reload("/?signedOut=1");
    } catch {
      // Keep the active editor if the server is temporarily unreachable.
    }
  };
  identity?.addEventListener("message", () => void verify());
  window.addEventListener("dt-workspace-save-failed", () => {
    if (document.querySelector(".web-save-failed")) return;
    const banner = document.createElement("button");
    banner.type = "button";
    banner.className = "web-save-failed";
    banner.textContent = "DataTrip could not save your workspace. Dismiss";
    banner.onclick = () => banner.remove();
    document.body.append(banner);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void verify();
  });
  window.setInterval(() => void verify(), 30_000);
  const { start } = bootstrap ?? await import("./bootstrap");
  await start(platform);
}

async function listen<T>(binding: string, event: string, receive: (data: { payload: T }) => void): Promise<() => void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  pageRequests.signal.addEventListener("abort", abort, { once: true });
  const close = () => { abort(); pageRequests.signal.removeEventListener("abort", abort); };
  try {
    const response = await fetch(`${entryPath}/events`, {
      cache: "no-store", headers: { "X-DataTrip-Session": binding, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error("Could not subscribe to job progress");
    const reader = response.body.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const lines = buffer.slice(0, end).split("\n");
            buffer = buffer.slice(end + 2);
            const data = lines.find((line) => line.startsWith("data: "));
            if (data && lines.includes(`event: ${event}`)) receive({ payload: JSON.parse(data.slice(6)) as T });
          }
          if (buffer.length > 512 * 1024) break;
        }
      } catch {
        // The running request returns the final state independently of SSE.
      } finally {
        close();
        reader.releaseLock();
      }
    })();
    return close;
  } catch (error) {
    close();
    throw error;
  }
}

function memoryPreferences(): Platform["preferences"] {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function showEntry(entry: Entry, failed: boolean): void {
  const panel = document.createElement("main");
  panel.className = "web-entry";
  const title = document.createElement("h1");
  title.textContent = "DataTrip";
  const error = document.createElement("p");
  error.setAttribute("role", "status");
  if (failed) error.textContent = "Sign-in failed. Try again.";
  panel.append(title, error);
  const submit = (path: string, args: unknown) => {
    for (const button of panel.querySelectorAll("button")) button.disabled = true;
    error.textContent = "";
    void post<BrowserSession & { url?: string }>(path, args).then((result) => {
      if (result.url) location.assign(result.url);
      else {
        identity?.postMessage(result.binding);
        reload();
      }
    }, (failure) => {
      error.textContent = failure.message || "Could not reach DataTrip";
      for (const button of panel.querySelectorAll("button")) button.disabled = false;
    });
  };
  if (entry.local) {
    const form = document.createElement("form");
    const field = (label: string, type: string, autocomplete: string) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const input = document.createElement("input");
      input.type = type;
      input.setAttribute("autocomplete", autocomplete);
      input.required = true;
      wrapper.append(input);
      form.append(wrapper);
      return input;
    };
    const username = field("Username", "text", "username");
    const password = field("Password", "password", "current-password");
    const button = document.createElement("button");
    button.textContent = "Sign in";
    form.append(button);
    form.onsubmit = (event) => {
      event.preventDefault();
      submit("/login/local", { username: username.value, password: password.value });
      password.value = "";
    };
    panel.append(form);
  }
  if (entry.oidc) addButton("Sign in with your identity provider", "/login/oidc");
  if (entry.anonymous) addButton("Continue without signing in", "/login/guest");
  mount.replaceChildren(panel);

  function addButton(label: string, path: string): void {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = () => submit(path, {});
    panel.append(button);
  }
}

async function boot(): Promise<void> {
  const flags = new URLSearchParams(location.search);
  const failed = flags.has("signInFailed");
  const entry = await request<Entry>("/session");
  if (entry.session) {
    await startWorkspace(entry.session, entry.version);
  } else if (!failed && !flags.has("signedOut") && entry.anonymous && !entry.local && !entry.oidc) {
    const [session, bootstrap] = await Promise.all([post<BrowserSession>("/login/guest", {}), import("./bootstrap")]);
    await startWorkspace(session, entry.version, bootstrap);
  } else {
    showEntry(entry, failed);
  }
}

window.addEventListener("pagehide", (event) => { if (event.persisted) mount.hidden = true; });
window.addEventListener("pageshow", (event) => { if (event.persisted) reload(location.href); });
void boot().catch((error) => { mount.textContent = error.message || "Could not start DataTrip"; });
