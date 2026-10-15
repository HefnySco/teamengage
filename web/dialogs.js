import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

/**
 * In-app replacements for window.confirm / window.prompt / window.alert —
 * Bootstrap-modal dialogs that resolve promises, plus non-blocking toasts
 * for errors. Mount <DialogHost/> once at the app root.
 *
 *   if (await confirmDialog("archive 3 items?", "they move to archive")) …   // → boolean
 *   const reason = await promptDialog("drop reason");                        // → string | null (cancel)
 *   toast(e.message);                                                        // error, top-right
 *   toast("saved", "success");
 */

let emitChange = () => {};
let dialog = null; // { kind: "confirm" | "prompt", title, body, label, value, placeholder, ok, danger, resolve }
let toasts = [];   // { seq, text, kind }
let toastSeq = 0;

/** confirm dialog — resolves true on the ok button, false on cancel/dismiss. */
export const confirmDialog = (title, body, opts = {}) =>
  new Promise((resolve) => {
    dialog = { kind: "confirm", title, body, ok: opts.ok ?? "ok", danger: !!opts.danger, resolve };
    emitChange();
  });

/** prompt dialog — resolves the entered text, or null on cancel (window.prompt's contract). */
export const promptDialog = (title, opts = {}) =>
  new Promise((resolve) => {
    dialog = {
      kind: "prompt",
      title,
      label: opts.label,
      value: opts.value ?? "",
      placeholder: opts.placeholder ?? "",
      ok: opts.ok ?? "ok",
      danger: !!opts.danger,
      resolve,
    };
    emitChange();
  });

/** non-blocking notice — "danger" (default) for errors, "success" for confirmations. */
export const toast = (text, kind = "danger") => {
  const t = { seq: ++toastSeq, text, kind };
  toasts = [...toasts, t];
  emitChange();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.seq !== t.seq);
    emitChange();
  }, 9000);
};

export const DialogHost = () => {
  const [, tick] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => {
    emitChange = () => tick((n) => n + 1);
    return () => {
      emitChange = () => {};
    };
  }, []);
  const close = (v) => {
    const d = dialog;
    dialog = null;
    emitChange();
    d?.resolve(v);
  };
  const cancelWith = dialog?.kind === "confirm" ? false : null;
  return html`
    ${dialog && html`
      <div class="modal-backdrop show"></div>
      <div class="modal d-block" tabindex="-1"
        onKeyDown=${(e) => e.key === "Escape" && close(cancelWith)}
        onClick=${(e) => e.target === e.currentTarget && close(cancelWith)}>
        <div class="modal-dialog modal-dialog-centered modal-sm">
          <div class="modal-content">
            <div class="modal-header py-2">
              <b class="modal-title fs-6">${dialog.title}</b>
              <button type="button" class="btn-close" title="cancel" onClick=${() => close(cancelWith)}></button>
            </div>
            <div class="modal-body py-2 small">
              ${dialog.body && html`<div style=${{ whiteSpace: "pre-line" }}>${dialog.body}</div>`}
              ${dialog.kind === "prompt" && html`
                ${dialog.label && html`<div class="mb-1 text-secondary">${dialog.label}</div>`}
                <input class="form-control form-control-sm" defaultValue=${dialog.value} placeholder=${dialog.placeholder}
                  ref=${(b) => { inputRef.current = b; b?.focus(); }}
                  onKeyDown=${(e) => { if (e.key === "Enter") close(inputRef.current?.value.trim() ?? ""); }} />`}
            </div>
            <div class="modal-footer py-1">
              <button class="btn btn-sm btn-outline-secondary" onClick=${() => close(cancelWith)}>cancel</button>
              <button class="btn btn-sm ${dialog.danger ? "btn-danger" : "btn-primary"}"
                ref=${(b) => { if (b && dialog.kind === "confirm") b.focus(); }}
                onClick=${() => close(dialog.kind === "confirm" ? true : (inputRef.current?.value.trim() ?? ""))}>${dialog.ok}</button>
            </div>
          </div>
        </div>
      </div>`}
    ${toasts.length > 0 && html`
      <div class="toast-container position-fixed top-0 end-0 p-3" style=${{ zIndex: 1100 }}>
        ${toasts.map((t) => html`
          <div key=${t.seq} class="toast show text-bg-${t.kind} border-0 small" role="alert">
            <div class="d-flex align-items-center">
              <div class="toast-body py-2" style=${{ whiteSpace: "pre-line" }}>${t.text}</div>
              <button type="button" class="btn-close btn-close-white me-2 m-auto" title="dismiss"
                onClick=${() => { toasts = toasts.filter((x) => x.seq !== t.seq); emitChange(); }}></button>
            </div>
          </div>`)}
      </div>`}
  `;
};
