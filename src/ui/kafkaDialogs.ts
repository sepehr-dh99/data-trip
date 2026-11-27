// Kafka dialogs: produce message, create topic, delete topic (type-to-confirm), reset consumer-group offsets.
import { api } from "../api";
import type { KafkaGroupDetail, KafkaHeader, KafkaProduceResult, KafkaTopicDetail } from "../types";
import { TextEditor } from "./editor";
import { clear, errMsg, h, icon } from "./dom";
import { fmtInt, kafkaSid, loadOverview, overviewOf, toLocalInput } from "./kafka";
import { promptDialog } from "./prompt";
import { errorHelpButton } from "./help";
import { confirmProdKafka } from "./prodUi";
import { store } from "./state";
import { toast } from "./toast";

const MOD = /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

const isReadOnly = (connId: string): boolean => store.conns.get(connId)?.config.readOnly === true;

/** v0.17: an error line of a dialog with the "What does this mean?" help button when an article matches. */
function showErr(el: HTMLElement, e: unknown, command?: string): void {
  const msg = errMsg(e);
  el.replaceChildren(h("span", null, msg), errorHelpButton(msg, { driver: "kafka", command }) ?? "");
}

/** Overlay shell shared by the dialogs here: Escape / click outside close it. */
function shell(dialog: HTMLElement, onClose: () => void): { overlay: HTMLElement; close: () => void } {
  const overlay = h("div", { class: "overlay" }, dialog);
  const onKey = (e: KeyboardEvent): void => {
    // a production confirmation on top handles its own Escape
    if (e.key === "Escape" && !document.querySelector(".ops-confirm")) {
      e.stopPropagation();
      close();
    }
  };
  const close = (): void => {
    window.removeEventListener("keydown", onKey, true);
    overlay.classList.add("leaving");
    window.setTimeout(() => overlay.remove(), 160);
    onClose();
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  window.addEventListener("keydown", onKey, true);
  return { overlay, close };
}

// ---------------------------------------------------------------- produce

export interface ProducePrefill {
  key?: string | null;
  partition?: number | null;
  headers?: KafkaHeader[];
  value?: string | null;
}

export interface ProduceOpts {
  connId: string;
  topic: string;
  prefill?: ProducePrefill;
  onSent?: (r: KafkaProduceResult) => void;
}

export function openProduceDialog(o: ProduceOpts): void {
  if (isReadOnly(o.connId)) {
    toast("This connection is read-only", "info");
    return;
  }
  if (document.querySelector(".kf-produce")) return;
  const pre = o.prefill ?? {};
  const inKey = h("input", { class: "kf-input mono", type: "text", value: pre.key ?? "", placeholder: "none", spellcheck: false, autocomplete: "off", "aria-label": "Key" });
  const inPart = h("input", {
    class: "kf-input",
    type: "text",
    value: pre.partition === null || pre.partition === undefined ? "auto" : String(pre.partition),
    spellcheck: false,
    autocomplete: "off",
    "aria-label": "Partition",
  });
  inPart.addEventListener("focus", () => inPart.select());
  const hdrList = h("div", { class: "kf-hdrs" });
  const hdrRows: { k: HTMLInputElement; v: HTMLInputElement; el: HTMLElement }[] = [];
  const addHeader = (k = "", v = ""): void => {
    const ik = h("input", { class: "kf-input sm mono", type: "text", value: k, placeholder: "name", spellcheck: false, style: "flex:1", "aria-label": "Header name" });
    const iv = h("input", { class: "kf-input sm mono", type: "text", value: v, placeholder: "value", spellcheck: false, style: "flex:1.4", "aria-label": "Header value" });
    const row = { k: ik, v: iv, el: null as unknown as HTMLElement };
    row.el = h(
      "div",
      { class: "kf-hdr-row" },
      ik,
      iv,
      h(
        "button",
        {
          class: "kf-x",
          type: "button",
          "aria-label": "Remove header",
          onclick: () => {
            hdrRows.splice(hdrRows.indexOf(row), 1);
            row.el.remove();
          },
        },
        "×",
      ),
    );
    hdrRows.push(row);
    hdrList.insertBefore(row.el, btnAddHdr);
  };
  const btnAddHdr = h("button", { class: "kf-pill-btn", type: "button", onclick: () => addHeader() }, "+ Header");
  hdrList.append(btnAddHdr);
  for (const hd of pre.headers ?? []) addHeader(hd.key, hd.value ?? "");

  const hint = h("span", { class: "kf-hint" });
  const edHost = h("div", { class: "kf-editor", "aria-label": "Value" });
  const err = h("div", { class: "prompt-err", role: "alert" });
  const keepOpen = h("input", { type: "checkbox" });
  const btnSend = h("button", { class: "btn primary", type: "button" }, icon("send", 14), "Send");
  const btnCancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");

  let editor: TextEditor | null = null;
  const refreshHint = (): void => {
    const t = editor?.getText() ?? "";
    if (!t.trim()) {
      hint.className = "kf-hint";
      hint.textContent = "empty — sent as a null value (tombstone)";
      editor?.setJson(false);
      return;
    }
    try {
      JSON.parse(t);
      hint.className = "kf-hint ok";
      hint.textContent = "✓ valid JSON";
      editor?.setJson(true);
    } catch {
      hint.className = "kf-hint";
      hint.textContent = "not JSON — will be sent as text";
      editor?.setJson(false);
    }
  };

  const dialog = h(
    "div",
    { class: "dialog kf-dialog kf-produce", role: "dialog", "aria-modal": "true", "aria-label": "Produce message" },
    h(
      "div",
      { class: "kf-dlg-head" },
      h("span", { class: "kf-dlg-title" }, "Produce message"),
      h("span", { class: "kf-dlg-sub mono" }, "→ " + o.topic),
      h("div", { class: "spacer" }),
      h("button", { class: "kf-x lg", type: "button", "aria-label": "Close", onclick: () => close() }, "×"),
    ),
    h(
      "div",
      { class: "kf-dlg-body" },
      h("div", { class: "kf-grid2" }, h("label", { class: "kf-lab" }, "Key", inKey), h("label", { class: "kf-lab" }, "Partition", inPart)),
      h("div", { class: "kf-lab-row", style: "padding-top:6px" }, "Headers"),
      hdrList,
      h("div", { class: "kf-lab-row" }, "Value", h("div", { class: "spacer" }), hint),
      edHost,
      err,
    ),
    h(
      "div",
      { class: "kf-dlg-foot" },
      h("label", { class: "kf-check" }, keepOpen, h("span", null, "Keep open after send")),
      h("div", { class: "spacer" }),
      btnCancel,
      btnSend,
    ),
  );
  const { close } = shell(dialog, () => editor?.destroy());
  editor = new TextEditor(edHost, { doc: pre.value ?? "", placeholder: '{ "hello": "world" }', onChange: refreshHint, onSubmit: () => void send() });
  refreshHint();
  btnCancel.onclick = () => close();

  const send = async (): Promise<void> => {
    err.textContent = "";
    const sid = kafkaSid(o.connId);
    if (!sid) {
      err.textContent = "Not connected.";
      return;
    }
    const pt = inPart.value.trim().toLowerCase();
    let partition: number | null = null;
    if (pt !== "" && pt !== "auto") {
      const n = Number(pt);
      if (!Number.isInteger(n) || n < 0) {
        err.textContent = "Partition must be a whole number, or “auto”.";
        inPart.focus();
        return;
      }
      const cnt = overviewOf(o.connId)?.topics.find((t) => t.name === o.topic)?.partitions;
      if (cnt !== undefined && n >= cnt) {
        err.textContent = `${o.topic} has partitions 0–${cnt - 1}.`;
        inPart.focus();
        return;
      }
      partition = n;
    }
    const headers: KafkaHeader[] = hdrRows.filter((r) => r.k.value.trim() !== "").map((r) => ({ key: r.k.value.trim(), value: r.v.value }));
    const text = editor?.getText() ?? "";
    const key = inKey.value === "" ? null : inKey.value;
    btnSend.disabled = true;
    // v0.17: production sources confirm first
    const prod = await confirmProdKafka(store.conns.get(o.connId)?.config, { kind: "produce", topic: o.topic, partition, key, value: text === "" ? null : text, headers: headers.length });
    if (prod === false) {
      btnSend.disabled = false;
      return;
    }
    try {
      const r = await api.kafkaProduce(sid, { topic: o.topic, partition, key, value: text === "" ? null : text, headers });
      toast(`Sent to p${r.partition} @ ${fmtInt(r.offset)}`, "ok");
      o.onSent?.(r);
      if (!keepOpen.checked) close();
    } catch (e) {
      showErr(err, e, "produce");
    } finally {
      btnSend.disabled = false;
    }
  };
  btnSend.onclick = () => void send();
  btnSend.title = `Send (${MOD}↵)`;
  window.setTimeout(() => (pre.value ? editor?.focus() : inKey.focus()), 30);
}

// ---------------------------------------------------------------- create topic

/** Resolves with the created topic's name, or null when cancelled. */
export function openCreateTopicDialog(connId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const brokers = overviewOf(connId)?.brokers.length ?? 1;
    const inName = h("input", { class: "input", type: "text", placeholder: "orders.v3", spellcheck: false, autocomplete: "off", "aria-label": "Topic name" });
    const inParts = h("input", { class: "input", type: "number", min: "1", step: "1", value: "3", "aria-label": "Partitions" });
    const inRf = h("input", { class: "input", type: "number", min: "1", step: "1", value: String(Math.max(1, Math.min(3, brokers))), "aria-label": "Replication factor" });
    const err = h("div", { class: "prompt-err", role: "alert" });
    const btn = h("button", { class: "btn primary", type: "button" }, "Create topic");
    const field = (label: string, el: HTMLElement): HTMLElement => h("label", { class: "field" }, h("span", { class: "field-label" }, label), el);
    let done = false;
    const dialog = h(
      "div",
      { class: "dialog small", role: "dialog", "aria-modal": "true", "aria-label": "Create topic" },
      h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon("topic", 18), "Create topic")),
      h("div", { class: "dialog-body" }, field("Name", inName), h("div", { class: "row2" }, field("Partitions", inParts), field("Replication factor", inRf)), err),
      h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: () => close() }, "Cancel"), btn),
    );
    const { close } = shell(dialog, () => {
      if (!done) resolve(null);
    });
    const go = async (): Promise<void> => {
      err.textContent = "";
      const name = inName.value.trim();
      const parts = Number(inParts.value);
      const rf = Number(inRf.value);
      if (!/^[A-Za-z0-9._-]{1,249}$/.test(name) || name === "." || name === "..") {
        err.textContent = "Use letters, digits, “.”, “_” and “-” (up to 249 characters).";
        inName.focus();
        return;
      }
      if (!Number.isInteger(parts) || parts < 1 || !Number.isInteger(rf) || rf < 1) {
        err.textContent = "Partitions and replication factor must be whole numbers of at least 1.";
        return;
      }
      if (rf > brokers && overviewOf(connId)) {
        err.textContent = `Replication factor can't exceed the number of brokers (${brokers}).`;
        return;
      }
      const sid = kafkaSid(connId);
      if (!sid) {
        err.textContent = "Not connected.";
        return;
      }
      btn.disabled = true;
      // v0.17: production sources confirm first
      const prod = await confirmProdKafka(store.conns.get(connId)?.config, { kind: "create topic", topic: name, partitions: parts, replication: rf });
      if (prod === false) {
        btn.disabled = false;
        return;
      }
      try {
        await api.kafkaCreateTopic(sid, name, parts, rf);
        done = true;
        resolve(name);
        close();
        toast(`Created topic ${name}`, "ok");
        void loadOverview(connId, true);
      } catch (e) {
        showErr(err, e, "create");
        btn.disabled = false;
      }
    };
    btn.onclick = () => void go();
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void go();
      }
    });
    window.setTimeout(() => inName.focus(), 30);
  });
}

// ---------------------------------------------------------------- delete topic

/** Type-to-confirm delete. Resolves true when the topic was deleted. */
export async function deleteTopicFlow(connId: string, topic: string): Promise<boolean> {
  if (isReadOnly(connId)) {
    toast("This connection is read-only", "info");
    return false;
  }
  // v0.17: on a production source its confirmation (typed data source or topic name) replaces the plain one
  const prod = await confirmProdKafka(store.conns.get(connId)?.config, { kind: "delete topic", topic });
  if (prod === false) return false;
  if (prod === null) {
    const typed = await promptDialog("Delete topic", `Type “${topic}” to confirm`, "", "Delete topic", [], {
      icon: "trash",
      hint: "This permanently deletes the topic and every message in it.",
      validate: (v) => (v === topic ? null : "The name doesn't match."),
    });
    if (typed !== topic) return false;
  }
  const sid = kafkaSid(connId);
  if (!sid) return false;
  try {
    await api.kafkaDeleteTopic(sid, topic);
    toast(`Deleted topic ${topic}`, "ok");
    void loadOverview(connId, true);
    return true;
  } catch (e) {
    toast(errMsg(e), "error");
    return false;
  }
}

// ---------------------------------------------------------------- reset offsets

type ResetTo = "earliest" | "latest" | "timestamp" | "offset";

export function openResetOffsetsDialog(connId: string, group: KafkaGroupDetail, onDone: () => void): void {
  if (isReadOnly(connId)) return toast("This connection is read-only", "info");
  if (document.querySelector(".kf-reset")) return;
  const topics = [...new Set(group.offsets.map((x) => x.topic))].sort();
  if (topics.length === 0) return toast("This group has no committed offsets to reset", "info");
  let to: ResetTo = "earliest";
  const selTopic = h("select", { class: "input", "aria-label": "Topic" }, topics.map((t) => h("option", { value: t }, t)));
  const inTime = h("input", { class: "input", type: "datetime-local", step: "1", value: toLocalInput(Date.now() - 3_600_000), "aria-label": "Timestamp" });
  const inOff = h("input", { class: "input", type: "number", min: "0", step: "1", value: "0", "aria-label": "Offset" });
  const valueWrap = h("div", { class: "kf-reset-value" });
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Reset to" });
  const segBtns = (["earliest", "latest", "timestamp", "offset"] as ResetTo[]).map((m) => {
    const b = h(
      "button",
      {
        type: "button",
        class: "seg-btn",
        role: "radio",
        onclick: () => {
          to = m;
          sync();
        },
      },
      m[0].toUpperCase() + m.slice(1),
    );
    b.dataset.m = m;
    seg.appendChild(b);
    return b;
  });
  const preview = h("div", { class: "kf-preview", "aria-live": "polite" });
  const err = h("div", { class: "prompt-err", role: "alert" });
  const btnReset = h("button", { class: "btn primary", type: "button" }, "Reset");
  const details = new Map<string, KafkaTopicDetail | null>();

  const value = (): number | null => {
    if (to === "timestamp") {
      const t = new Date(inTime.value).getTime();
      return Number.isNaN(t) ? null : t;
    }
    if (to === "offset") {
      const n = Number(inOff.value);
      return inOff.value.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null;
    }
    return null;
  };
  const valid = (): boolean => (to === "timestamp" || to === "offset" ? value() !== null : true);

  const renderPreview = (): void => {
    clear(preview);
    const topic = selTopic.value;
    const rows = group.offsets.filter((x) => x.topic === topic).sort((a, b) => a.partition - b.partition);
    const det = details.get(topic);
    const target = (p: number, end: number): string => {
      const pi = det?.partitions.find((x) => x.id === p);
      if (to === "earliest") return pi ? fmtInt(pi.low) : "earliest";
      if (to === "latest") return fmtInt(pi ? pi.high : end);
      if (to === "offset") return value() === null ? "—" : fmtInt(value());
      return "at timestamp";
    };
    preview.append(
      h("div", { class: "kf-preview-head" }, `${rows.length} partition${rows.length === 1 ? "" : "s"} of `, h("span", { class: "mono" }, topic), " will be reset"),
      h(
        "div",
        { class: "kf-preview-rows" },
        rows.slice(0, 6).map((r) => h("div", { class: "kf-preview-row" }, h("span", { class: "mono dim" }, "p" + r.partition), h("span", { class: "mono" }, r.committed === null ? "—" : fmtInt(r.committed)), h("span", { class: "dim" }, "→"), h("span", { class: "mono" }, target(r.partition, r.end)))),
        rows.length > 6 ? h("div", { class: "kf-preview-more" }, `…and ${rows.length - 6} more`) : null,
      ),
    );
    btnReset.disabled = !valid() || rows.length === 0;
  };
  const sync = (): void => {
    for (const b of segBtns) {
      const on = b.dataset.m === to;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    clear(valueWrap);
    if (to === "timestamp") valueWrap.append(inTime);
    if (to === "offset") valueWrap.append(inOff);
    valueWrap.style.display = to === "timestamp" || to === "offset" ? "" : "none";
    renderPreview();
  };
  const loadDetail = async (): Promise<void> => {
    const topic = selTopic.value;
    if (details.has(topic)) return renderPreview();
    const sid = kafkaSid(connId);
    if (!sid) return;
    try {
      details.set(topic, await api.kafkaTopic(sid, topic));
    } catch {
      details.set(topic, null);
    }
    if (selTopic.value === topic) renderPreview();
  };
  selTopic.addEventListener("change", () => {
    renderPreview();
    void loadDetail();
  });
  inTime.addEventListener("input", renderPreview);
  inOff.addEventListener("input", renderPreview);

  const field = (label: string, el: HTMLElement): HTMLElement => h("label", { class: "field" }, h("span", { class: "field-label" }, label), el);
  const dialog = h(
    "div",
    { class: "dialog kf-reset", role: "dialog", "aria-modal": "true", "aria-label": "Reset offsets" },
    h("div", { class: "dialog-head" }, h("div", { class: "dialog-title" }, icon("refresh", 18), "Reset offsets"), h("span", { class: "kf-dlg-sub mono", style: "padding-right:8px" }, group.groupId)),
    h(
      "div",
      { class: "dialog-body" },
      field("Topic", selTopic),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "To"), seg, valueWrap),
      preview,
      h("div", { class: "kf-note" }, icon("alert", 13), "Members must stay stopped while offsets are reset. Messages between the old and new position will be re-read or skipped."),
      err,
    ),
    h("div", { class: "dialog-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn ghost", type: "button", onclick: () => close() }, "Cancel"), btnReset),
  );
  const { close } = shell(dialog, () => undefined);
  btnReset.onclick = async () => {
    err.textContent = "";
    const sid = kafkaSid(connId);
    if (!sid) {
      err.textContent = "Not connected.";
      return;
    }
    btnReset.disabled = true;
    // v0.17: production sources confirm first
    const parts = group.offsets.filter((x) => x.topic === selTopic.value).length;
    const v = value();
    const toText = to === "timestamp" && v !== null ? `timestamp ${new Date(v).toISOString()}` : to;
    const prod = await confirmProdKafka(store.conns.get(connId)?.config, { kind: "reset offsets", group: group.groupId, topic: selTopic.value, to: toText, value: to === "offset" ? v : null, partitions: parts });
    if (prod === false) {
      btnReset.disabled = false;
      return;
    }
    try {
      const n = await api.kafkaResetOffsets(sid, group.groupId, selTopic.value, to, value());
      toast(`Reset ${n} partition${n === 1 ? "" : "s"} of ${selTopic.value}`, "ok");
      close();
      onDone();
    } catch (e) {
      showErr(err, e);
      btnReset.disabled = false;
    }
  };
  sync();
  void loadDetail();
}
