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

/** A toast with arbitrary content (inline recovery inputs). Stays until `dismiss()` unless `ms` is given. */
export function toastNode(node: HTMLElement, kind: ToastKind = "info", ms = 0): () => void {
  if (!host) {
    host = h("div", { class: "toasts", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  const t = h("div", { class: "toast rich " + kind, role: kind === "error" ? "alert" : "status" }, icon(kind === "error" ? "alert" : kind === "ok" ? "check" : "key", 16), node);
  const dismiss = (): void => {
    t.classList.add("leaving");
    window.setTimeout(() => t.remove(), 200);
  };
  host.appendChild(t);
  if (ms > 0) window.setTimeout(dismiss, ms);
  return dismiss;
}
