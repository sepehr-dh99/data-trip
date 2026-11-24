import { h, icon } from "./dom";

let host: HTMLElement | null = null;

export type ToastKind = "info" | "ok" | "error";

export function toast(message: string, kind: ToastKind = "info", ms?: number): void {
  if (!host) {
    host = h("div", { class: "toasts", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  const t = h(
    "div",
    { class: "toast " + kind, role: kind === "error" ? "alert" : "status" },
    icon(kind === "error" ? "alert" : kind === "ok" ? "check" : "sparkle", 16),
    h("div", { class: "toast-msg" }, message),
  );
  const close = (): void => {
    t.classList.add("leaving");
    window.setTimeout(() => t.remove(), 200);
  };
  t.addEventListener("click", close);
  host.appendChild(t);
  while (host.children.length > 5) host.firstElementChild?.remove();
  window.setTimeout(close, ms ?? (kind === "error" ? 8000 : 3200));
}
