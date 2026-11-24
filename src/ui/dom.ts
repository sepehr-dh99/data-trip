// Tiny DOM helpers and hand-drawn inline SVG icons.
import logoUrl from "../assets/logo-mark.svg";

type Child = Node | string | number | null | undefined | false | Child[];
export type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "style") {
        if (typeof v === "string") el.style.cssText = v;
        else Object.assign(el.style, v as object);
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "dataset") Object.assign(el.dataset, v as object);
      else if (v === true) el.setAttribute(k, "");
      else if (k in el && !k.includes("-")) (el as unknown as Props)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  play: '<path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor"/>',
  playAll: '<path d="M4.5 6l6.5 6-6.5 6M12.5 6l6.5 6-6.5 6"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  table: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M4 10h16M10 10v9"/>',
  view: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17 12v3M20 12v2"/>',
  refresh: '<path d="M20 11a8 8 0 00-14.5-4M4 5v3.5h3.5"/><path d="M4 13a8 8 0 0014.5 4M20 19v-3.5h-3.5"/>',
  pencil: '<path d="M4 20l4-1L19 8a2.1 2.1 0 00-3-3L5 16z"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7M10.5 11v5M13.5 11v5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7.5a2 2 0 002 2h2.5"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 01-11 0zM12 16.5V21"/>',
  unplug: '<path d="M9 3v4M15 3v4M6.5 7.5h11v3.5a5.5 5.5 0 01-11 0zM12 16.5V21M4 4l16 16"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M7.5 10l3 2.5-3 2.5M13 15h4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  folder:
    '<path d="M3.5 7.5a2 2 0 012-2H10l2 2.5h6.5a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  schema: '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.3"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/>',
  sort: '<path d="M12 6v12M8 10l4-4 4 4"/>',
  dots: '<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>',
  filter: '<path d="M4 6h16l-6 7.5V19l-4 1.5v-7z"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  run: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
  caret: '<path d="M8 4.8l10.8 7.2L8 19.2z" fill="currentColor" stroke="none"/>',
  caretDown: '<path d="M7 10l5 5 5-5"/>',
  commit: '<circle cx="12" cy="12" r="3.6"/><path d="M3.5 12h4.9M15.6 12h4.9"/>',
  server: '<rect x="4" y="4.5" width="16" height="6" rx="2"/><rect x="4" y="13.5" width="16" height="6" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  matview: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><path d="M9.6 12h4.8M12 9.6v4.8"/>',
  func: '<path d="M15 4.8c-2.4-.9-3.8.4-4.2 2.7l-1.3 9c-.4 2.3-1.8 3.6-4.2 2.700M7 11.200h8"/>',
  proc: '<rect x="4" y="4.5" width="16" height="15" rx="3.5"/><path d="M10.3 9.200l4.4 2.8-4.4 2.800z"/>',
  seq: '<path d="M9.5 4L8 20M16 4l-1.5 16M4.5 9h15M4 15h15"/>',
  column: '<path d="M12 4.5l7.5 7.5-7.5 7.5L4.5 12z"/>',
  fk: '<path d="M4.5 12h11M11.5 7.500l4.5 4.5-4.5 4.500M19.5 5v14"/>',
  index: '<path d="M4.5 6.500h15M4.5 12h10M4.5 17.500h6M17 14.500l3 3-3 3"/>',
  role: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  tablespace: '<path d="M3.5 8.500h17v9a2 2 0 01-2 2h-13a2 2 0 01-2-2zM3.5 8.500l2-4h13l2 4M8.5 13.500h7"/>',
  row: '<rect x="3.5" y="8" width="17" height="8" rx="2.5"/>',
  kString: '<path d="M7 8.5h10M12 8.5v8M9.500 16.500h5"/>',
  kHash: '<path d="M9.500 5L8 19M16 5l-1.500 14M5 9.500h14.500M4.500 14.500H19"/>',
  kList: '<path d="M8.500 7h11M8.500 12h11M8.500 17h11"/><circle cx="4.800" cy="7" r="0.9" fill="currentColor"/><circle cx="4.800" cy="12" r="0.9" fill="currentColor"/><circle cx="4.800" cy="17" r="0.9" fill="currentColor"/>',
  kSet: '<circle cx="9.500" cy="12" r="5.500"/><circle cx="14.500" cy="12" r="5.500"/>',
  kZset: '<path d="M6 19v-6M12 19V6M18 19v-9"/>',
  kStream: '<path d="M3.500 9h10M3.500 15h14M17 6.500l3.500 2.500-3.500 2.500M20.500 15l-3 2.500"/>',
  kJson: '<path d="M9 4.500C6.500 4.500 7.500 9 5 12c2.500 3 1.500 7.500 4 7.500M15 4.500c2.500 0 1.500 4.500 4 7.500-2.500 3-1.500 7.500-4 7.500"/>',
  topic: '<path d="M4 8c2-2 3-2 5 0s3 2 5 0 3-2 6 0M4 12.500c2-2 3-2 5 0s3 2 5 0 3-2 6 0M4 17c2-2 3-2 5 0s3 2 5 0 3-2 6 0"/>',
  group: '<circle cx="12" cy="12" r="8.500"/><circle cx="12" cy="12" r="3.600"/>',
  send: '<path d="M4 12l16-7-6 15-2.500-6.200z"/><path d="M11.500 13.800L20 5"/>',
  copyCheck: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
};

export function icon(name: string, size = 16): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "ico";
  s.style.width = s.style.height = size + "px";
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  return s;
}

/** Brand mark: the colored DataTrip logo (src/assets/logo-mark.svg). */
export function brandMark(size = 22): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "ico brand-mark";
  const img = document.createElement("img");
  img.src = logoUrl;
  img.alt = "";
  img.width = img.height = size;
  img.draggable = false;
  s.appendChild(img);
  return s;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | undefined;
  return (...a: A) => {
    if (t !== undefined) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0;left:-999px" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Error text for people: the machine prefixes `VAULT_TOKEN_INVALID:<profileId>:` / `SSH_HOST_*:…` are dropped. */
export function humanMsg(m: string): string {
  const v = /^\s*VAULT_TOKEN_INVALID:[^:]*:\s*/.exec(m);
  if (v) return m.slice(v[0].length);
  const s = /^\s*SSH_HOST_(UNKNOWN|CHANGED):(?:\[[^\]]+\]|[^:\s]+):\d+:\S+\s*/.exec(m);
  if (s) return m.slice(s[0].length) || (s[1] === "CHANGED" ? "The SSH host key has changed." : "The SSH host key is not trusted yet.");
  return m;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return humanMsg(e.message);
  if (typeof e === "string") return humanMsg(e);
  return String(e);
}
