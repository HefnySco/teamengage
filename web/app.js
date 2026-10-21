import "bootstrap/dist/css/bootstrap.min.css";
import { markdownToHtml, inlineMarkdown, notesSection } from "./markdown.js";
import { confirmDialog, promptDialog, toast, DialogHost } from "./dialogs.js";
import { h, render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// ---- auth: `?token=` / `#t=<token>` from `te ui` → cookie, then strip ------
const qTok = new URLSearchParams(location.search).get("token") ??
  /[#&]t=([^&]+)/.exec(location.hash)?.[1];
if (qTok) {
  document.cookie = `te_token=${qTok}; path=/; samesite=strict`;
  history.replaceState(null, "", location.pathname + location.hash.replace(/[#&]t=[^&]+/, "").replace(/^#&/, "#"));
}

// a stale te_token cookie (e.g. an older daemon's token) 401s every call —
// say so instead of pages sitting on "loading…" forever
const authBanner = () => {
  if (document.getElementById("te-auth-banner")) return;
  const d = document.createElement("div");
  d.id = "te-auth-banner";
  d.className = "alert alert-danger py-2 small";
  d.textContent = "session expired — the daemon has a different token; reopen the UI with `te ui`";
  document.getElementById("app")?.prepend(d);
};
const api = async (path, init) => {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401) authBanner();
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

// ---- SSE-driven store ------------------------------------------------------
const listeners = new Set();
const onEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const notify = (e) => listeners.forEach((f) => f(e));
const es = new EventSource("/events");
es.onmessage = (e) => notify({ kind: "event", data: JSON.parse(e.data) });
for (const kind of ["watch", "reconcile"]) {
  es.addEventListener(kind, (e) => notify({ kind, data: JSON.parse(e.data) }));
}

const STATUSES = ["draft", "ready", "hold", "in_progress", "waiting", "in_review", "done", "dropped"];
const ST_BADGE = {
  draft: "text-bg-secondary",
  ready: "text-bg-primary",
  hold: "badge-hold",
  in_progress: "text-bg-warning",
  waiting: "text-bg-info",
  in_review: "badge-review",
  done: "text-bg-success",
  dropped: "text-bg-danger",
};
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
};

// time left until an ISO timestamp, for countdowns ("in 12m", "due")
const untilText = (ts) => {
  const s = (Date.parse(ts) - Date.now()) / 1000;
  if (s <= 60) return "due";
  return `in ${ago(new Date(Date.now() - s * 1000).toISOString())}`;
};

const nav = (route) => (location.hash = "#/" + route);
const route = () => location.hash.replace(/^#\/?/, "") || "inbox";

// ---- shared bits ------------------------------------------------------------
const STALE_MS = 24 * 3600 * 1000;
const staleClaim = (c) => !c.conflicted && Date.now() - Date.parse(c.last_seen ?? c.claimed_at) > STALE_MS;
// domain colours, fetched once and refreshed on change (chips everywhere use them)
let domainColors = {};
const domainListeners = new Set();
const refreshDomains = () =>
  api("/api/domains")
    .then((rows) => {
      domainColors = Object.fromEntries(rows.map((r) => [r.name, r.color]));
      domainListeners.forEach((f) => f(rows));
    })
    .catch(() => {});
refreshDomains();
const fallbackColor = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
};
// <input type=color> needs #rrggbb — canvas resolves hsl()/named colours for us
const colorCtx = document.createElement("canvas").getContext("2d");
const toHexColor = (css) => {
  colorCtx.fillStyle = "#888888";
  colorCtx.fillStyle = css;
  return colorCtx.fillStyle;
};
function useDomains() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    domainListeners.add(setRows);
    refreshDomains();
    return () => domainListeners.delete(setRows);
  }, []);
  return rows;
}
const DomainChip = ({ d, onClick, onRemove, active }) => html`
  <span class="badge domain-chip ${active ? "active" : ""}" style=${{ background: domainColors[d] ?? fallbackColor(d) }}
    title=${onClick ? `filter by #${d}` : `#${d}`}
    onClick=${onClick ? (e) => { e.stopPropagation(); onClick(d); } : undefined}>
    #${d}${onRemove && html`<span class="ms-1 chip-x" title="remove" onClick=${(e) => { e.stopPropagation(); onRemove(d); }}>×</span>`}
  </span>`;
const DomainChips = ({ ds, onClick, active }) =>
  (ds ?? []).length ? html`<span class="d-inline-flex flex-wrap gap-1">${ds.map((d) => html`<${DomainChip} key=${d} d=${d} onClick=${onClick} active=${active === d} />`)}</span>` : null;

const Badge = ({ s }) => html`<span class="badge ${ST_BADGE[s] ?? "text-bg-secondary"}">${s}</span>`;
// an epic's derived plan lifecycle (plan_state) — draft → decomposing → active → done
const PLAN_CHIP = {
  draft: "ps-draft",
  decomposing: "ps-decomposing",
  active: "ps-active",
  done: "ps-done",
};
// ghost micro-chip: graph glyph + n/m fraction — the colour carries the state, the title the words;
// clicking opens the plan's dependency graph
const PlanBadge = ({ i }) => {
  if (!i.plan_state) return null;
  const id = i.id ?? i.meta?.id; // list rows are flat; the item page nests it under meta
  const p = `${i.plan_progress?.done ?? 0}/${i.plan_progress?.total ?? 0}`;
  return html`<span class="plan-chip ${PLAN_CHIP[i.plan_state] ?? "ps-draft"}" role="button"
    title="plan ${i.plan_state} — ${p} parts finished — open the dependency graph"
    onClick=${(e) => {
      e.stopPropagation(); // don't open the item — show its plan graph instead
      nav(`graph/${id}`);
    }}><${GraphIcon} />${p}</span>`;
};

// bootstrap-icons glyphs, inlined (no icon font dependency)
const ArchiveIcon = () => html`
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M0 2a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1v7.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 1 12.5V5a1 1 0 0 1-1-1zm2 3v7.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V5zm13-3H1v2h14zM5 7.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5"/>
  </svg>`;
const GraphIcon = () => html`
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.9 4.6 11.3 7.5M4.9 11.4l6.4-2.9" stroke="currentColor" stroke-width="1.1" fill="none"/>
    <circle cx="3.5" cy="3.5" r="2.2"/><circle cx="13" cy="8" r="2.2"/><circle cx="3.5" cy="12.5" r="2.2"/>
  </svg>`;
const TrashIcon = () => html`
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
    <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
  </svg>`;
const StarIcon = ({ filled }) => html`
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
    ${filled
      ? html`<path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/>`
      : html`<path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767-3.686 1.894.694-3.957a.56.56 0 0 0-.163-.505L1.71 6.745l4.052-.576a.53.53 0 0 0 .393-.288L8 2.223l1.847 3.658a.53.53 0 0 0 .393.288l4.052.575-2.906 2.77a.56.56 0 0 0-.163.506l.694 3.957-3.686-1.894a.5.5 0 0 0-.461 0z"/>`}
  </svg>`;
// the ★ flips through the bootstrap colours; undefined means unstarred
const STAR_CYCLE = ["yellow", "red", "green", "blue"];
const STAR_TEXT = { yellow: "text-warning", red: "text-danger", green: "text-success", blue: "text-primary" };
const nextStarColor = (c) => STAR_CYCLE[STAR_CYCLE.indexOf(c) + 1]; // unset → yellow; blue → undefined (unstar)
// a ★ flips none → yellow → red → green → blue → none — every list
const toggleStar = async (i, reload) => {
  const next = nextStarColor(i.star_color);
  try {
    await post(`/api/items/${i.id}/${next ? "star" : "unstar"}`, next ? { color: next } : {});
  } catch (e) {
    toast(`${i.id}: ${e.message}`);
  }
  reload?.();
};
// always rendered — the empty star holds the slot so rows stay aligned
const StarBtn = ({ i, reload }) => html`
  <button class="icon-btn ${i.star_color ? `on ${STAR_TEXT[i.star_color]}` : ""}"
    title=${i.star_color ? `starred ${i.star_color} — click to flip, ends on unstar` : "star — bookmark this task"}
    onClick=${(e) => {
      e.stopPropagation(); // don't open the item
      toggleStar(i, reload);
    }}><${StarIcon} filled=${Boolean(i.star_color)} /></button>`;

// one <path> (or several) per glyph — same inline convention as the icons above
const glyph = (paths) => html`
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true" style="vertical-align:-.125em">
    ${paths.map((d) => html`<path d=${d} />`)}
  </svg>`;
const CheckIcon = () => glyph(["M12.736 3.97a.733.733 0 0 1 1.047 0c.286.289.29.756.01 1.05L7.88 12.01a.733.733 0 0 1-1.065.02L3.217 8.384a.757.757 0 0 1 0-1.06.733.733 0 0 1 1.047 0l3.052 3.093 5.4-6.425z"]);
const CheckCircleIcon = () => glyph([
  "M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16",
  "M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05",
]);
const XCircleIcon = () => glyph([
  "M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16",
  "M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708",
]);
const XIcon = () => glyph(["M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8z"]);
const UnlockIcon = () => glyph(["M11 1a2 2 0 0 0-2 2v4a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h5V3a3 3 0 0 1 6 0v4a.5.5 0 0 1-1 0V3a2 2 0 0 0-2-2M3 8a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1z"]);
const LockIcon = () => glyph(["M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2m3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM5 8h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1"]);
const PlayIcon = () => glyph(["m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393"]);
const PauseIcon = () => glyph(["M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5"]);
const PencilIcon = () => glyph([
  "M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z",
  "M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z",
]);
const UndoIcon = () => glyph([
  "M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 0 0 8 2z",
  "M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466",
]);
const PlusSquareIcon = () => glyph([
  "M14 1a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zM2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z",
  "M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4",
]);
const CheckSquareIcon = () => glyph([
  "M3 14.5A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5h8a.5.5 0 0 1 0 1H3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V8a.5.5 0 0 1 1 0v5a1.5 1.5 0 0 1-1.5 1.5z",
  "m8.354 10.354 7-7a.5.5 0 0 0-.708-.708L8 9.293 5.354 6.646a.5.5 0 1 0-.708.708l3 3a.5.5 0 0 0 .708 0",
]);
const RobotIcon = () => glyph([
  "M6 12.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5M3 8.062C3 6.76 4.235 5.765 5.53 5.886a26.6 26.6 0 0 0 4.94 0C11.765 5.765 13 6.76 13 8.062v1.157a.93.93 0 0 1-.765.935c-.845.147-2.34.346-4.235.346s-3.39-.2-4.235-.346A.93.93 0 0 1 3 9.219zm4.542-.827a.25.25 0 0 0-.217.068l-.92.9a25 25 0 0 1-1.871-.183.25.25 0 0 0-.068.495c.55.076 1.232.149 2.02.193a.25.25 0 0 0 .189-.071l.754-.736.847 1.71a.25.25 0 0 0 .404.062l.932-.97a25 25 0 0 0 1.922-.188.25.25 0 0 0-.068-.495c-.538.074-1.207.145-1.98.189a.25.25 0 0 0-.166.076l-.754.785-.842-1.7a.25.25 0 0 0-.182-.135",
  "M8.5 1.866a1 1 0 1 0-1 0V3h-2A4.5 4.5 0 0 0 1 7.5V8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1v-.5A4.5 4.5 0 0 0 10.5 3h-2zM14 7.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.5A3.5 3.5 0 0 1 5.5 4h5A3.5 3.5 0 0 1 14 7.5",
]);

// search field with a × clear button inside (the native type=search one is webkit-only)
// onEscape may return true to keep the query (e.g. it dismissed a dropdown instead)
const SearchBox = ({ value, onChange, onKeyDown, onEscape, ...props }) => html`
  <span class="search-box position-relative d-inline-flex align-items-center">
    <input type="search" class="form-control form-control-sm" ...${props} value=${value}
      onInput=${(e) => onChange(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === "Escape" && !onEscape?.()) onChange("");
        onKeyDown?.(e);
      }} />
    ${value && html`<button type="button" class="icon-btn position-absolute end-0 me-1" title="clear search" tabIndex=${-1}
      onMouseDown=${(e) => e.preventDefault()}
      onClick=${(e) => { onChange(""); e.currentTarget.previousElementSibling.focus(); }}>×</button>`}
  </span>`;

// suggestion dropdown under a search box — @agents, #domains, is:flags.
// mousedown+preventDefault keeps the input focused while a pick is applied
const SearchSug = ({ sug, sel, onPick }) => html`
  <div class="sug">
    <div class="hd">${sug.title}</div>
    ${sug.items.map(
      (s, n) => html`<div class="it ${n === sel ? "sel" : ""}" key=${s.insert}
        onMouseDown=${(e) => {
          e.preventDefault();
          onPick(s.insert);
        }}>${s.body}</div>`,
    )}
    <div class="ft">↑↓ select · ↩ apply · esc dismiss</div>
  </div>`;

// IDs (XX-0000) inside free text become item links
const ID_TOKEN = /\b([A-Z][A-Z0-9]*-\d+)\b/;
const LinkedText = ({ text, onOpen }) =>
  html`${text
    .split(ID_TOKEN)
    .map((p, i) =>
      i % 2
        ? html`<a class="item id" key=${i} onClick=${() => onOpen(p)}>${p}</a>`
        : p,
    )}`;

function useApi(path, deps = []) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const reload = () => api(path).then(setData, setErr);
  useEffect(() => {
    reload();
    return onEvent(() => reload());
  }, deps);
  return { data, err, reload };
}

// ---- Inbox (UI-0002) --------------------------------------------------------
// answer a waiting item's question: an option button (or typing) only fills
// the answer; nothing is sent until "answer" is pressed and confirmed
const AnswerBox = ({ id, opts, onAnswer }) => {
  const [text, setText] = useState("");
  const submit = async () => {
    const answer = text.trim();
    if (answer && (await confirmDialog("answer this question", `Answer ${id ?? "this question"} with:\n\n${answer}`, { ok: "answer" }))) onAnswer(answer);
  };
  return html`
    <div class="d-flex gap-2 flex-wrap align-items-center">
      ${(opts ?? []).map((o, i) => html`<button class="btn btn-sm ${text === o ? "btn-secondary" : "btn-outline-secondary"} text-start"
        onClick=${() => setText(o)}>opt ${i + 1}: ${o}</button>`)}
      <input class="form-control form-control-sm w-auto" value=${text} onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => e.key === "Enter" && submit()} placeholder="answer…" />
      <button class="btn btn-sm btn-primary btn-act" disabled=${!text.trim()} onClick=${submit}>answer</button>
    </div>
  `;
};

// a recorded answer; the item's latest one can be revised until the item is closed
const DecisionCard = ({ d, canChange, onChange }) => {
  const [text, setText] = useState(null);
  const save = async () => {
    const answer = (text ?? "").trim();
    if (!answer || answer === d.meta.title) return setText(null);
    if (await confirmDialog(`change answer ${d.meta.id}`, `from: ${d.meta.title}\nto:   ${answer}`, { ok: "change" })) {
      onChange(answer);
      setText(null);
    }
  };
  return html`
    <div class="card card-body mt-2">
      <div class="d-flex gap-2 align-items-start">
        <div class="flex-grow-1"><b>${d.meta.id}</b>${d.meta.version > 1 ? html` <span class="text-secondary small">(changed)</span>` : ""} ${text === null && d.meta.title}</div>
        ${canChange && text === null && html`<button class="btn btn-sm btn-outline-primary py-0" onClick=${() => setText(d.meta.title)}>change answer</button>`}
      </div>
      ${d.meta.question && html`<div class="small text-secondary mt-1">asked: ${d.meta.question}</div>`}
      ${(d.meta.options ?? []).length > 0 && html`<div class="d-flex gap-1 mt-1 flex-wrap small">
        ${d.meta.options.map((o, i) => text === null
          ? html`<span class="badge ${o === d.meta.title ? "text-bg-primary" : "text-bg-secondary"}">opt ${i + 1}: ${o}</span>`
          : html`<button class="btn btn-sm py-0 ${o === text ? "btn-secondary" : "btn-outline-secondary"}" onClick=${() => setText(o)}>opt ${i + 1}: ${o}</button>`)}
      </div>`}
      ${text !== null && html`<div class="d-flex gap-2 mt-2 flex-wrap">
        <textarea class="form-control form-control-sm" rows="2" value=${text} onInput=${(e) => setText(e.target.value)} />
        <button class="btn btn-sm btn-primary" onClick=${save}>save</button>
        <button class="btn btn-sm btn-outline-secondary" onClick=${() => setText(null)}>cancel</button>
      </div>`}
    </div>
  `;
};

// quiet domain tag: grey chip, the domain colour shrunk to a 6px dot;
// pass onClick to make it a filter control (board cards + filter row)
const DomainTags = ({ ds, onClick, active }) => {
  const shown = (ds ?? []).slice(0, 2);
  return html`<span class="d-inline-flex gap-1 align-items-center">
    ${shown.map((d) => html`<span key=${d}
      class="triage-tag ${onClick ? "clickable" : ""} ${active === d ? "on" : ""}"
      title=${onClick ? `show only #${d} (click again to clear)` : `#${d}`}
      style=${`--c:${domainColors[d] ?? fallbackColor(d)}`}
      onClick=${onClick ? (e) => { e.stopPropagation(); onClick(d); } : undefined}><i></i>${d}</span>`)}
    ${(ds ?? []).length > shown.length && html`<span class="triage-tag">+${ds.length - shown.length}</span>`}
  </span>`;
};

// status as a coloured dot + text — the only place colour carries meaning
const InboxStatus = ({ s, c, label }) => html`
  <span class="triage-st ${s ? `st-${s}` : ""}" style=${c ? `--st:${c}` : null}>${label ?? (s ?? "").replace("_", " ")}</span>`;

// last-update duration — the right-hand column on every inbox row
const ageCell = (i) => {
  const t = i?.updated ?? i?.created;
  return html`<span class="age" title=${t ? `last update ${t}` : "no update recorded"}>${t ? ago(t) : "—"}</span>`;
};

// a waiting question: one row whose "answer" button expands it in place —
// full question markdown + the answer box
const QuestionRow = ({ q, item, onOpen, onAnswer }) => {
  const [open, setOpen] = useState(false);
  return html`
    <div class="triage-li">
      <span class="id-cell d-flex align-items-center gap-1">
        <a class="item id" onClick=${() => onOpen(q.id)}>${q.id}</a>
        ${item?.star_color && html`<span class="${STAR_TEXT[item.star_color]}" title="starred ${item.star_color}"><${StarIcon} filled /></span>`}
      </span>
      <${InboxStatus} s="waiting" />
      <span class="t text-secondary" title=${q.question?.text}>${(q.question?.text ?? item?.title ?? "").replace(/\s+/g, " ")}</span>
      <${DomainTags} ds=${item?.domains} />
      ${ageCell(item)}
      <span class="acts">
        <button class="btn btn-sm py-0 ${open ? "btn-outline-secondary" : "btn-primary"}" disabled=${item && item.status !== "waiting"} title=${item && item.status !== "waiting" ? "questions can only be answered while the item is waiting" : ""} onClick=${() => setOpen(!open)}>${open ? "close" : "answer"}</button>
      </span>
      ${open && html`
        <div class="triage-detail">
          ${item?.title && html`<div class="small text-secondary mb-1">${item.title}</div>`}
          <div class="my-2 md-view" dangerouslySetInnerHTML=${{ __html: markdownToHtml(q.question?.text ?? "") }} />
          <${AnswerBox} id=${q.id} opts=${q.question?.options} onAnswer=${(text) => { setOpen(false); onAnswer(text); }} />
        </div>`}
    </div>`;
};

const Inbox = ({ onOpen }) => {
  const { data, reload } = useApi("/api/inbox");
  // the inbox lists ids; the item list supplies titles, projects and files to search
  const { data: all } = useApi("/api/items?archived=all");
  const [q, setQ] = useState(() => loadSearch("te.inbox.q"));
  const [kind, setKind] = useState("all");
  const [sort, setSortState] = useState(() => loadSearch("te.inbox.sort"));
  const [sugSel, setSugSel] = useState(0); // highlighted suggestion row
  const [sugOff, setSugOff] = useState(false); // Esc dismisses until the query changes
  const [sugFocus, setSugFocus] = useState(false); // dropdown only while the input is focused
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const byId = Object.fromEntries((all ?? []).map((i) => [i.id, i]));
  const title = (id) => byId[id]?.title ?? "";
  // trailing "held by …" note for rows of claimed items
  const claimNote = (id) => {
    const c = byId[id]?.claim;
    return c ? html` <span class="text-secondary">· ${c.holder.split("@")[0]}@${c.machine} ${ago(c.claimed_at)}</span>` : null;
  };
  // AI review marker for review rows — reviewed items are a quick accept, flagged ones need a look
  const aiNote = (id) => {
    const r = byId[id]?.ai_review;
    if (!r) return null;
    return html` <span class="${r.verdict === "ok" ? "text-success" : "text-danger-emphasis"}"
      title=${`AI review: ${r.verdict} — ${r.reviewed_by}${r.note ? `\n${r.note}` : ""}`}>AI ${r.verdict === "ok" ? "✓" : "✗"}</span>`;
  };
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (id, ...extra) =>
    !words.length ||
    matches(byId[id] ?? { id }, words) ||
    words.every((w) => extra.filter(Boolean).join(" ").toLowerCase().includes(w));
  // rows of different shapes share the board's comparators: each maps to its
  // item (a finding with none gets a pseudo-item so it still orders by name);
  // no picked sort = keep the server's order
  const effSort = SORTS[sort] ? sort : "";
  const itemOf = {
    questions: (x) => byId[x.id] ?? { id: x.id },
    drafts: (id) => byId[id] ?? { id },
    reviews: (id) => byId[id] ?? { id },
    drop_flags: (x) => byId[x.id] ?? { id: x.id },
    claims: (c) => byId[c.item] ?? { id: c.item },
    findings: (f) => byId[f.item] ?? { id: f.item ?? "", title: f.message ?? f.path ?? "" },
  };
  const sortRows = (key, arr) =>
    effSort ? [...arr].sort((a, b) => SORTS[effSort](itemOf[key](a), itemOf[key](b))) : arr;
  const view = {
    questions: sortRows("questions", data.questions.filter((x) => hit(x.id, x.question?.text))),
    drafts: sortRows("drafts", data.drafts.filter((id) => hit(id))),
    reviews: sortRows("reviews", data.reviews.filter((id) => hit(id))),
    drop_flags: sortRows("drop_flags", (data.drop_flags ?? []).filter((x) => hit(x.id, x.by, x.reason))),
    claims: sortRows("claims", data.claims.filter((c) => hit(c.item, c.holder, c.machine))),
    findings: sortRows("findings", data.findings.filter((f) => hit(f.item, f.path, f.message, f.kind))),
  };
  const total = data.questions.length + data.drafts.length + data.reviews.length + (data.drop_flags?.length ?? 0) + data.claims.length + data.findings.length;
  const shown = Object.values(view).reduce((n, a) => n + a.length, 0);
  // every item the inbox lists, deduped — the pool the search filters and the
  // suggestion dropdown's @agent / #domain counts draw from
  const poolIds = [
    ...new Set([
      ...data.questions.map((x) => x.id),
      ...data.drafts,
      ...data.reviews,
      ...(data.drop_flags ?? []).map((f) => f.id),
      ...data.claims.map((c) => c.item),
      ...data.findings.map((f) => f.item).filter(Boolean),
    ]),
  ];
  // the "updated" page: stalest on top — each row shows how long since it was last touched
  const touched = (i) => i.updated ?? i.created ?? "";
  const updatedItems = poolIds
    .filter((id) => hit(id))
    .map((id) => byId[id] ?? { id })
    .sort((a, b) => touched(a).localeCompare(touched(b)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const setSearch = (v) => {
    setQ(v);
    saveSearch("te.inbox.q", v);
    setSugOff(false); // a new token reopens a dismissed dropdown
  };
  const setSort = (v) => {
    setSortState(v);
    saveSearch("te.inbox.sort", v);
  };
  const act = async (id, action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => toast(e.message));
    reload();
  };
  // a cancelled prompt (null) aborts the action — only OK fires it
  const askThen = async (id, action, label) => {
    const reason = await promptDialog(label);
    if (reason !== null) act(id, action, { reason });
  };
  const empty = !total;
  // same search language as the board: @agent, #domain, is:flag, plus plain words
  const { def: sugDef, tok } = searchSug(q, poolIds.map((id) => byId[id] ?? { id }));
  const applySug = (insert) => setSearch(q.slice(0, q.length - tok.length) + insert + " ");
  const sug = sugFocus && !sugOff ? sugDef : null;
  const sel = sug ? Math.min(sugSel, sug.items.length - 1) : 0;

  // one dense line per thing that needs you; actions reveal on hover
  const idCell = (id) => html`
    <span class="id-cell d-flex align-items-center gap-1">
      <a class="item id" onClick=${() => onOpen(id)}>${id}</a>
      ${byId[id]?.star_color && html`<span class="${STAR_TEXT[byId[id].star_color]}" title="starred ${byId[id].star_color}"><${StarIcon} filled /></span>`}
    </span>`;
  const itemRow = (id, st, extra, acts) => html`
    <div class="triage-li" key=${id}>
      ${idCell(id)}
      ${st}
      <span class="t" title=${title(id)}>${title(id) || "—"}${extra}</span>
      <${DomainTags} ds=${byId[id]?.domains} />
      ${ageCell(byId[id])}
      <span class="acts">${acts}</span>
    </div>`;
  const groups = [
    {
      key: "questions",
      label: "Questions",
      rows: view.questions.map(
        (x) => html`<${QuestionRow} key=${x.id} q=${x} item=${byId[x.id]} onOpen=${onOpen}
          onAnswer=${(text) => act(x.id, "answer", { text })} />`,
      ),
    },
    {
      key: "claims",
      label: "Conflicts",
      rows: view.claims.map(
        (c) => html`
          <div class="triage-li" key=${c.item}>
            ${idCell(c.item)}
            <${InboxStatus} c="var(--bs-danger)" label="conflict" />
            <span class="t" title=${title(c.item)}>
              ${title(c.item)} <span class="text-secondary">· held by ${c.holder}@${c.machine} since ${ago(c.claimed_at)}</span>
            </span>
            <${DomainTags} ds=${byId[c.item]?.domains} />
            ${ageCell(byId[c.item])}
            <span class="acts"><button class="btn btn-sm py-0 btn-outline-secondary" disabled=${byId[c.item] ? !canRelease(byId[c.item].status) : false} title=${byId[c.item] ? releaseTitle(byId[c.item].status) : "release the claim"} onClick=${async () => {
              if (await confirmDialog(`release the claim on ${c.item}?`, `held by ${c.holder}@${c.machine} since ${ago(c.claimed_at)} — the item goes back to ready; work in its worktree is kept but the claim record is gone.`, { ok: "release", danger: true })) act(c.item, "release", { note: "resolve" });
            }}>release</button></span>
          </div>`,
      ),
    },
    {
      key: "reviews",
      label: "Review",
      rows: view.reviews.map((id) =>
        itemRow(
          id,
          html`<${InboxStatus} s="in_review" />`,
          html`${claimNote(id)}${aiNote(id)}`,
          html`<button class="btn btn-sm py-0 btn-primary" onClick=${async () => {
            if (await confirmDialog(`accept ${id}?`, "the claim's worktrees merge into the task repo(s) and the item becomes done — the merges cannot be undone from here.", { ok: "accept" })) act(id, "accept");
          }}>accept</button>
            <button class="btn btn-sm py-0 text-danger" onClick=${() => askThen(id, "reject", "reject reason")}>reject</button>`,
        ),
      ),
    },
    {
      key: "drop_flags",
      label: "Drop flags",
      rows: view.drop_flags.map((x) =>
        itemRow(
          x.id,
          html`<${InboxStatus} s=${x.status} />`,
          html` <span class="text-secondary">· flagged by <b class=${whoCls(x.by)}>${x.by}</b> ${ago(x.at)} ago${x.reason ? ` — ${x.reason}` : ""}</span>${claimNote(x.id)}`,
          html`<button class="btn btn-sm py-0 text-danger" title="drop it — the flag's reason is used" onClick=${async () => {
            if (await confirmDialog(`drop ${x.id}?`, `flagged by ${x.by}${x.reason ? `: ${x.reason}` : ""} — dependents treat a dropped task as done and the flag's claim (if any) is released.`, { ok: "drop", danger: true })) act(x.id, "drop", { reason: x.reason });
          }}>drop</button>
            <button class="btn btn-sm py-0 text-secondary" title="keep it — dismiss the flag" onClick=${() => act(x.id, "unflag")}>keep</button>`,
        ),
      ),
    },
    {
      key: "findings",
      label: "Findings",
      rows: view.findings.map(
        (f, i) => html`
          <div class="triage-li" key=${i}>
            ${f.item ? idCell(f.item) : html`<span class="id text-secondary" title=${f.path}>${f.path ?? ""}</span>`}
            <span class="triage-sev ${f.severity === "error" ? "err" : ""}">${f.severity ?? "warning"}</span>
            <span class="t text-secondary" title=${f.message}><${LinkedText} text=${f.message} onOpen=${onOpen} /></span>
            <span></span>
            ${ageCell(f.item ? byId[f.item] : null)}
            <span class="acts">${f.item && html`<button class="btn btn-sm py-0 text-secondary" onClick=${() => onOpen(f.item)}>open</button>`}</span>
          </div>`,
      ),
    },
    {
      key: "drafts",
      label: "Drafts",
      rows: view.drafts.map((id) =>
        itemRow(
          id,
          html`<${InboxStatus} s="draft" />`,
          claimNote(id),
          html`<button class="btn btn-sm py-0 btn-primary" onClick=${() => act(id, "approve")}>approve</button>
            <button class="btn btn-sm py-0 text-secondary" onClick=${() => act(id, "complete", { note: "already done" })}>done</button>
            <button class="btn btn-sm py-0 text-danger" onClick=${() => askThen(id, "drop", "drop reason")}>drop</button>`,
        ),
      ),
    },
  ].map((g) => ({ ...g, n: g.rows.length }));
  // when the picked group runs empty (or never had anything) fall back to all
  const effKind = (kind === "updated" && updatedItems.length > 0) || groups.some((g) => g.key === kind && g.n > 0) ? kind : "all";
  const shownGroups = groups.filter((g) => g.n > 0 && (effKind === "all" || g.key === effKind));
  return html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Inbox</h2>
      <span class="position-relative">
        <${SearchBox}
          style=${{ maxWidth: "24rem" }}
          placeholder="search id, title, text… · @agent #domain is:flag"
          value=${q}
          onChange=${setSearch}
          onKeyDown=${(e) => {
            if (sug) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSugSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + sug.items.length) % sug.items.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                applySug(sug.items[sel].insert);
                return;
              }
            }
            if (e.key === "Enter" && updatedItems.length === 1) onOpen(updatedItems[0].id);
          }}
          onEscape=${() => {
            if (!sug) return false;
            setSugOff(true); // first Esc closes the dropdown; a second clears the query
            return true;
          }}
          onFocus=${() => setSugFocus(true)}
          onBlur=${() => setSugFocus(false)}
        />
        ${sug && html`<${SearchSug} sug=${sug} sel=${sel} onPick=${applySug} />`}
      </span>
      ${words.length > 0 && html`<span class="text-secondary small">${shown} of ${total}${updatedItems.length === 1 ? " — Enter opens it" : ""}</span>`}
      <${SortSeg} eff=${effSort} onSort=${setSort} title="order rows inside each group" />
      ${!empty && html`
        <span class="btn-group btn-group-sm ms-auto" role="group">
          <button class="btn btn-outline-secondary${effKind === "all" ? " active" : ""}" onClick=${() => setKind("all")}>All ${shown}</button>
          ${groups.map(
            (g) => g.n > 0 && html`<button key=${g.key} class="btn btn-outline-secondary${effKind === g.key ? " active" : ""}" onClick=${() => setKind(g.key)}>${g.label} ${g.n}</button>`,
          )}
          ${updatedItems.length > 0 && html`<button class="btn btn-outline-secondary${effKind === "updated" ? " active" : ""}" title="every inbox item, stalest first — how long since it was last touched" onClick=${() => setKind("updated")}>Updated ${updatedItems.length}</button>`}
        </span>`}
    </div>
    ${effKind === "updated"
      ? html`
          <div class="triage">
            <div>
              <div class="triage-group">Updated <span class="n">${updatedItems.length}</span></div>
              ${updatedItems.map(
                (i) => html`
                  <div class="triage-li" key=${i.id}>
                    ${idCell(i.id)}
                    <${InboxStatus} s=${byId[i.id]?.status ?? ""} />
                    <span class="t" title=${title(i.id)}>${title(i.id) || "—"}</span>
                    <${DomainTags} ds=${i.domains} />
                    ${ageCell(i)}
                  </div>`,
              )}
            </div>
          </div>`
      : shownGroups.length > 0 && html`
      <div class="triage">
        ${shownGroups.map(
          (g) => html`
            <div key=${g.key}>
              <div class="triage-group">${g.label} <span class="n">${g.n}</span></div>
              ${g.rows}
            </div>`,
        )}
      </div>`}
    ${empty && html`<p class="text-success mt-3">inbox zero — nothing needs you</p>`}
    ${!empty && words.length > 0 && shown === 0 && html`<p class="text-secondary mt-3">nothing in the inbox matches "${q}"</p>`}
  `;
};

// ---- Board (UI-0004) ---------------------------------------------------------
// remembered per browser tab, so coming back from an item keeps the search
const loadSearch = (key) => {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const saveSearch = (key, q) => {
  try {
    sessionStorage.setItem(key, q);
  } catch {
    /* storage blocked — search just isn't remembered */
  }
};
// is:flag search filters — name → [description for the dropdown, item predicate]
const FLAG_FILTERS = {
  starred: ["only starred cards", (i) => Boolean(i.star_color)],
  claimed: ["an agent holds a claim", (i) => Boolean(i.claim)],
  unclaimed: ["nobody holds it", (i) => !i.claim],
  blocked: ["waiting on dependencies", (i) => Boolean(i.blocked)],
  "ai-ok": ["AI review approved", (i) => i.ai_review?.verdict === "ok"],
  "ai-flagged": ["AI review flagged issues", (i) => Boolean(i.ai_review) && i.ai_review.verdict !== "ok"],
  plan: ["epic — a plan with parts", (i) => i.type === "epic"],
  idea: ["idea — a source document, never claimed", (i) => i.type === "idea"],
};
// every word must appear in id, title, project or source path. @word filters the
// claim holder's name, is:flag a boolean trait; a lone @ or # is not a filter
const matches = (i, words) => {
  const hay = [i.id, i.title, i.project, i.legacy_id, i.source, ...(i.domains ?? []).map((d) => `#${d} ${d}`)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => {
    if (w === "@" || w === "#") return true;
    if (w[0] === "@") {
      // holders look like agent@machine#session — "@devin" is the agent devin only
      // (name boundary), "@devin@mhef" narrows by machine prefix
      const x = w.slice(1);
      const h = (i.claim?.holder ?? "").toLowerCase();
      return x.includes("@") ? h.startsWith(x) : h.startsWith(x + "@");
    }
    if (w.startsWith("is:")) return FLAG_FILTERS[w.slice(3)]?.[1](i) ?? true;
    return hay.includes(w);
  });
};
// search suggestions under a query box — the word being typed picks the
// dropdown: @ → claim holders, # → domains, is: → flags. `pool` is the item
// set the page searches (board: everything; inbox: only what it lists), so
// the counts beside each suggestion reflect what the search will hit.
const searchSug = (q, pool) => {
  const agents = {};
  for (const i of pool) {
    if (!i.claim) continue;
    const name = i.claim.holder.split("@")[0]; // holder is agent@machine#session
    (agents[name] ??= { name, machine: i.claim.machine, n: 0 }).n++;
  }
  const domainCounts = {};
  for (const i of pool) for (const d of i.domains ?? []) domainCounts[d] = (domainCounts[d] ?? 0) + 1;
  const tok = q.slice(q.lastIndexOf(" ") + 1).toLowerCase();
  let def = null;
  if (tok[0] === "@") {
    const w = tok.slice(1);
    const items = Object.values(agents)
      .filter((a) => a.name.toLowerCase().includes(w))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .map((a) => ({
        insert: `@${a.name}`,
        body: html`<span class="av">${a.name[0].toUpperCase()}</span
          ><span><b>${a.name}</b> <span class="text-secondary">@${a.machine}</span></span
          ><span class="ms-auto text-secondary">${a.n} claimed</span>`,
      }));
    items.push({
      insert: "is:unclaimed",
      body: html`<span class="av">∅</span><span class="text-secondary">unclaimed</span><span class="ms-auto text-secondary">${pool.filter((i) => !i.claim).length}</span>`,
    });
    def = { title: "agents", items };
  } else if (tok[0] === "#") {
    const w = tok.slice(1);
    def = {
      title: "domains",
      items: Object.entries(domainCounts)
        .filter(([d]) => d.includes(w))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([d, n]) => ({
          insert: `#${d}`,
          body: html`<i class="dot" style=${`--c:${domainColors[d] ?? fallbackColor(d)}`}></i><b>#${d}</b><span class="ms-auto text-secondary">${n}</span>`,
        })),
    };
  } else if (tok.startsWith("is:")) {
    const w = tok.slice(3);
    def = {
      title: "flags",
      items: Object.entries(FLAG_FILTERS)
        .filter(([f]) => f.includes(w))
        .map(([f, [desc]]) => ({
          insert: `is:${f}`,
          body: html`<b>is:${f}</b> <span class="text-secondary">${desc}</span>`,
        })),
    };
  }
  if (def && !def.items.length) def = null;
  return { def, tok };
};
// board card order: created = creation date, updated = last touched (updated, else created), name = title — id breaks ties
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
const byCreated = (a, b) => (a.created ?? "").localeCompare(b.created ?? "") || byId(a, b);
const byUpdated = (a, b) => (b.updated ?? b.created ?? "").localeCompare(a.updated ?? a.created ?? "") || byId(a, b);
const SORTS = {
  "created-asc": byCreated,
  "created-desc": (a, b) => byCreated(b, a),
  "updated-desc": byUpdated,
  "updated-asc": (a, b) => byUpdated(b, a),
  "name-asc": (a, b) => (a.title ?? "").localeCompare(b.title ?? "") || byId(a, b),
  "name-desc": (a, b) => (b.title ?? "").localeCompare(a.title ?? "") || byId(a, b),
};
// the order control — created ↑↓ | updated ↓↑ | AZ; clicking the active field
// flips its direction. Shared by the board (cards inside each column) and the
// inbox (rows inside each group); an empty eff means "keep the server's order"
const SortSeg = ({ eff, onSort, title }) => {
  const btn = (field, label) => {
    const on = eff.startsWith(field);
    const desc = eff.endsWith("desc");
    const text =
      field === "name" && on ? (desc ? "Z→A" : "A→Z")
      : on ? `${label} ${desc ? "↓" : "↑"}`
      : label;
    const next = !on ? `${field}-${field === "updated" ? "desc" : "asc"}` : desc ? `${field}-asc` : `${field}-desc`;
    return html`<button class="btn btn-outline-secondary${on ? " active" : ""}" title=${title} onClick=${() => onSort(next)}>${text}</button>`;
  };
  return html`<span class="btn-group btn-group-sm" role="group">${btn("created", "created")}${btn("updated", "updated")}${btn("name", "AZ")}</span>`;
};

// ---- new idea — the human captures a thought as a source document ----------
// same propose pipeline agents use; it lands as a draft (approve to triage)
const NewIdea = ({ projects, onClose, onCreated }) => {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [project, setProject] = useState(projects[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const r = await post("/api/propose", {
        items: [{
          type: "idea",
          title: title.trim(),
          summary: body.trim() || undefined,
          project: project || undefined,
        }],
      });
      toast(`idea ${r.ids[0]}${r.files?.[0] ? ` → ${r.files[0]}` : ""} saved as a draft`, "success");
      onCreated(r.ids[0]);
    } catch (e) {
      toast(e.message);
      setBusy(false);
    }
  };
  return html`
    <div class="modal-backdrop show"></div>
    <div class="modal d-block" tabindex="-1"
      onKeyDown=${(e) => e.key === "Escape" && onClose()}
      onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header py-2">
            <b class="modal-title fs-6">new idea</b>
            <button type="button" class="btn-close" title="cancel" onClick=${onClose}></button>
          </div>
          <div class="modal-body py-2 small">
            <div class="mb-2 text-secondary">a source document — ask an agent to plan from it later; it is never claimed</div>
            <input class="form-control form-control-sm mb-2" placeholder="title" value=${title}
              ref=${(b) => b?.focus()}
              onInput=${(e) => setTitle(e.target.value)}
              onKeyDown=${(e) => e.key === "Enter" && save()} />
            <textarea class="form-control form-control-sm" rows="7"
              placeholder="the thought — markdown (becomes the idea file's ## Summary)"
              value=${body} onInput=${(e) => setBody(e.target.value)}></textarea>
            ${projects.length > 1 && html`
              <select class="form-select form-select-sm mt-2" value=${project} onChange=${(e) => setProject(e.target.value)}>
                ${projects.map((p) => html`<option key=${p.name} value=${p.name}>${p.name} (${p.prefix})</option>`)}
              </select>`}
          </div>
          <div class="modal-footer py-1">
            <button class="btn btn-sm btn-outline-secondary" onClick=${onClose}>cancel</button>
            <button class="btn btn-sm btn-primary" disabled=${!title.trim() || busy} onClick=${save}>save idea</button>
          </div>
        </div>
      </div>
    </div>`;
};

const Board = ({ onOpen }) => {
  const { data, reload } = useApi("/api/items");
  const { data: ws } = useApi("/api/workspace");
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [q, setQ] = useState(() => loadSearch("te.board.q"));
  const [domain, setDomainState] = useState(() => loadSearch("te.board.domain"));
  const [sort, setSortState] = useState(() => loadSearch("te.board.sort"));
  const [starredOnly, setStarredOnlyState] = useState(() => loadSearch("te.board.starred") === "1");
  // AI-review filter: "" = all, "ok" = only approved, "issues" = only flagged
  const [aiFilter, setAiFilterState] = useState(() => (["ok", "issues"].includes(loadSearch("te.board.ai")) ? loadSearch("te.board.ai") : ""));
  const [domShowAll, setDomShowAll] = useState(false);
  const [sugSel, setSugSel] = useState(0); // highlighted suggestion row
  const [sugOff, setSugOff] = useState(false); // Esc dismisses until the query changes
  const [sugFocus, setSugFocus] = useState(false); // dropdown only while the input is focused
  const setDomain = (d) => {
    const v = d === domain ? "" : d; // clicking the active domain clears it
    setDomainState(v);
    saveSearch("te.board.domain", v);
  };
  // done cards get an archive button; the column header archives all shown
  const archive = async (ids) => {
    for (const id of ids) {
      try {
        await post(`/api/items/${id}/archive`, { reason: "archived from the board" });
      } catch (e) {
        toast(`${id}: ${e.message}`);
      }
    }
    reload();
  };
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const inDomain = domain ? data.filter((i) => (i.domains ?? []).includes(domain)) : data;
  const inStar = starredOnly ? inDomain.filter((i) => i.star_color) : inDomain;
  const inAi = aiFilter ? inStar.filter((i) => i.ai_review?.verdict === aiFilter) : inStar;
  const hits = words.length ? inAi.filter((i) => matches(i, words)) : inAi;
  const domainCounts = {};
  for (const i of data) for (const d of i.domains ?? []) domainCounts[d] = (domainCounts[d] ?? 0) + 1;
  const untagged = data.filter((i) => !(i.domains ?? []).length).length;
  // search suggestions: the word being typed picks the dropdown —
  // @ → claim holders, # → domains, is: → flags
  const { def: sugDef, tok } = searchSug(q, data);
  const applySug = (insert) => setSearch(q.slice(0, q.length - tok.length) + insert + " ");
  const sug = sugFocus && !sugOff ? sugDef : null;
  const sel = sug ? Math.min(sugSel, sug.items.length - 1) : 0;
  const setSearch = (v) => {
    setQ(v);
    saveSearch("te.board.q", v);
    setSugOff(false); // a new token reopens a dismissed dropdown
  };
  const setSort = (v) => {
    setSortState(v);
    saveSearch("te.board.sort", v);
  };
  const setStarredOnly = (v) => {
    setStarredOnlyState(v);
    saveSearch("te.board.starred", v ? "1" : "");
  };
  // cycles all → ok → issues → all
  const setAiFilter = () => {
    const v = { "": "ok", ok: "issues", issues: "" }[aiFilter];
    setAiFilterState(v);
    saveSearch("te.board.ai", v);
  };
  const eff = SORTS[sort] ? sort : "created-asc";
  const domEntries = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
  const domTag = ([d, n]) => html`
    <span key=${d} class="triage-tag clickable ${domain === d ? "on" : ""}" title="show only #${d} (click again to clear)"
      style=${`--c:${domainColors[d] ?? fallbackColor(d)}`} onClick=${() => setDomain(d)}><i></i>${d} <span class="n">${n}</span></span>`;
  return html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Board</h2>
      <span class="position-relative">
        <${SearchBox}
          style=${{ maxWidth: "24rem" }}
          placeholder="search id, title, file… · @agent #domain is:flag"
          value=${q}
          onChange=${setSearch}
          onKeyDown=${(e) => {
            if (sug) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSugSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + sug.items.length) % sug.items.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                applySug(sug.items[sel].insert);
                return;
              }
            }
            if (e.key === "Enter" && hits.length === 1) onOpen(hits[0].id);
          }}
          onEscape=${() => {
            if (!sug) return false;
            setSugOff(true); // first Esc closes the dropdown; a second clears the query
            return true;
          }}
          onFocus=${() => setSugFocus(true)}
          onBlur=${() => setSugFocus(false)}
          autofocus
        />
        ${sug && html`<${SearchSug} sug=${sug} sel=${sel} onPick=${applySug} />`}
      </span>
      <${SortSeg} eff=${eff} onSort=${setSort} title="order cards inside each column" />
      <button class="btn btn-sm ${starredOnly ? "btn-primary" : "btn-outline-secondary"}" title="show only starred" onClick=${() => setStarredOnly(!starredOnly)}><${StarIcon} filled=${starredOnly} /> starred</button>
      <button class="btn btn-sm ${aiFilter === "ok" ? "btn-success" : aiFilter === "issues" ? "btn-danger" : "btn-outline-secondary"}"
        title=${aiFilter === "ok" ? "only AI-approved — click for AI-flagged" : aiFilter === "issues" ? "only AI-flagged — click to show all" : "AI review filter — click for approved only"}
        onClick=${setAiFilter}><${RobotIcon} /> ${aiFilter === "issues" ? "AI ✗" : aiFilter === "ok" ? "AI ✓" : "AI"}</button>
      <button class="btn btn-sm btn-outline-info ms-auto" title="capture a thought as an idea — a source document an agent can plan from; lands as a draft" onClick=${() => setIdeaOpen(true)}>+ idea</button>
      ${(words.length > 0 || domain || starredOnly || aiFilter) && html`<span class="text-secondary small">${hits.length} of ${data.length}${hits.length === 1 ? " — Enter opens it" : ""}</span>`}
      ${ideaOpen && html`<${NewIdea} projects=${ws?.projects ?? []}
        onClose=${() => setIdeaOpen(false)}
        onCreated=${(id) => { setIdeaOpen(false); reload(); onOpen(id); }} />`}
    </div>
    ${domEntries.length > 0 && html`<div class="d-flex align-items-center gap-1 flex-wrap mb-3">
      <span class="small text-body-tertiary me-1">Domains</span>
      ${(domShowAll ? domEntries : domEntries.slice(0, 12)).map(domTag)}
      ${!domShowAll && domEntries.length > 12 && html`<span class="triage-tag clickable" onClick=${() => setDomShowAll(true)}>+${domEntries.length - 12} more</span>`}
      <span class="small text-body-tertiary">${untagged} untagged</span>
      ${domain && html`<button class="btn btn-sm btn-link py-0" onClick=${() => setDomain(domain)}>clear</button>`}
    </div>`}
    <div class="board-cols">
      ${STATUSES.map((s) => {
        const items = hits.filter((i) => i.status === s);
        if (SORTS[eff]) items.sort(SORTS[eff]);
        // empty columns collapse to a thin strip (mockup sample 3)
        if (items.length === 0) return html`
          <div class="board-col collapsed" key=${s}>
            <div class="col-hd"><${InboxStatus} s=${s} label=${s.replace("_", " ")} /> <span class="n">0</span></div>
          </div>`;
        return html`
          <div class="board-col" key=${s}>
            <div class="col-hd">
              <${InboxStatus} s=${s} label=${s.replace("_", " ")} />
              <span class="n">${items.length}</span>
              ${s === "done" && items.some((i) => !i.claim) && html`<button class="icon-btn ms-auto"
                title="archive every done card shown (respects the search)"
                onClick=${async () => {
                  const ids = items.filter((i) => !i.claim).map((i) => i.id);
                  if (await confirmDialog(`archive ${ids.length} done item(s)?`, `They move to the archive page and can be unarchived.${words.length ? " (search-matched only)" : ""}`, { ok: "archive" })) archive(ids);
                }}><${ArchiveIcon} /></button>`}
            </div>
            <div class="col-body">
              ${items.map(
                (i) => html`
                  <div class=${`card bcard p-2${i.type === "epic" && i.plan_state ? ` plan ps-${i.plan_state}` : ""}`} key=${i.id} onClick=${() => onOpen(i.id)}>
                    ${i.type === "epic" && i.plan_state && html`<div class="plan-over">plan · ${i.plan_state}</div>`}
                    <div class="d-flex align-items-center gap-1">
                      <span class="id">${i.id}${i.unblocks_on === "done" ? html` <span title="key task: dependents wait for its acceptance">🔑</span>` : ""}</span>
                      ${i.type === "epic" && html`<${PlanBadge} i=${i} />`}
                      ${i.type === "idea" && html`<span class="badge text-bg-info" title="idea — a source document; agents plan from it, it is never claimed">idea</span>`}
                      <span class="ms-auto d-flex">
                        ${s === "done" && !i.claim && html`<button class="icon-btn" title="archive"
                          onClick=${(e) => {
                            e.stopPropagation(); // don't open the item
                            archive([i.id]);
                          }}><${ArchiveIcon} /></button>`}
                        <${StarBtn} i=${i} reload=${reload} />
                      </span>
                    </div>
                    <div class="bcard-title">${i.title}</div>
                    ${((i.domains ?? []).length > 0 || i.claim || i.blocked || i.ai_review || i.updated || i.created) && html`
                      <div class="bcard-meta d-flex align-items-center gap-1 flex-wrap">
                        <${DomainTags} ds=${i.domains} onClick=${setDomain} active=${domain} />
                        ${i.blocked && html`<span>blocked</span>`}
                        ${i.ai_review && html`<span class="badge text-bg-${i.ai_review.verdict === "ok" ? "success" : "danger"}"
                          title=${`AI review: ${i.ai_review.verdict} — ${i.ai_review.reviewed_by}${i.ai_review.summary ? `\n${i.ai_review.summary}` : ""}${i.ai_review.note ? `\n${i.ai_review.note}` : ""} (${ago(i.ai_review.reviewed_at)} ago)`}>
                          AI ${i.ai_review.verdict === "ok" ? "✓" : "✗"}</span>`}
                        ${i.auto_accept_at && html`<span class="badge text-bg-warning" title=${`autonomy: solo — the daemon accepts this at ${new Date(i.auto_accept_at).toLocaleString()} unless you act (stop it on the item page)`}>⏱ ${untilText(i.auto_accept_at)}</span>`}
                        <span class="d-inline-flex align-items-center gap-1 ms-auto">
                          ${i.claim && html`
                            <span class="av" title=${`${i.claim.holder}@${i.claim.machine} · claimed ${ago(i.claim.claimed_at)} ago`}>${(i.claim.holder[0] ?? "?").toUpperCase()}</span>
                            ${i.claim.conflicted && html`<span class="text-danger">conflict</span>`}
                            ${i.claim.unsynced && html`<span class="text-warning-emphasis">unsynced</span>`}
                            ${staleClaim(i.claim) && html`<span class="text-warning-emphasis">stale</span>`}
                          `}
                          ${(i.updated ?? i.created) && html`<span title=${`updated ${i.updated ?? i.created}`}>${ago(i.updated ?? i.created)}</span>`}
                        </span>
                      </div>`}
                  </div>
                `,
              )}
            </div>
          </div>
        `;
      })}
    </div>
  `;
};

// ---- Plans ---------------------------------------------------------------------
// epics as a tree: plan → sub-plans → tasks, with plan_state, progress and deps
// PlanBar/PlanNode live at module scope: defined inside Plans they would be new
// component types every render, so each SSE-driven refetch would unmount/remount
// the whole tree — replacing the DOM under the cursor and eating clicks
const PlanBar = ({ p }) => {
  const total = p?.total ?? 0;
  const pct = total ? Math.round(((p?.done ?? 0) * 100) / total) : 0;
  return html`<div class="progress flex-shrink-0" style=${{ width: "6rem", height: "0.45rem" }} title="${p?.done ?? 0}/${total} parts finished">
    <div class="progress-bar bg-success" style=${{ width: `${pct}%` }}></div></div>`;
};
const PlanNode = ({ i, depth, tree }) => {
  const isPlan = i.type === "epic";
  const isOpen = isPlan && tree.isOpenOf(i, depth);
  const children = tree.kids.get(i.id) ?? [];
  const shown = tree.words.length ? children.filter(tree.subtreeMatches) : children;
  return html`
    <div>
      <div class="d-flex align-items-center gap-2 py-1 border-bottom plan-li" style=${{ paddingLeft: `${depth * 1.25}rem`, cursor: "pointer" }}
        onClick=${() => tree.onOpen(i.id)}>
        <span style=${{ width: "1rem", textAlign: "center" }} title=${isPlan ? (isOpen ? "collapse" : "expand") : ""}
          onClick=${(e) => {
            if (!isPlan) return;
            e.stopPropagation(); // fold, don't open the item
            tree.setOpen({ ...tree.open, [i.id]: !isOpen });
          }}>${isPlan ? (isOpen ? "▾" : "▸") : "·"}</span>
        <span class="id text-nowrap">${i.id}</span>
        <${StarBtn} i=${i} reload=${tree.reload} />
        ${isPlan ? html`<${PlanBadge} i=${i} />` : html`<${Badge} s=${i.status} />`}
        <span class=${isPlan ? "fw-semibold" : ""}>${i.title}</span>
        ${!isPlan && (i.depends_on ?? []).length > 0 && html`<span class="small text-secondary" title="depends on">← ${i.depends_on.join(", ")}</span>`}
        ${i.blocked && html`<span class="small text-warning-emphasis">blocked</span>`}
        ${i.claim && html`<span class="av" title=${`${i.claim.holder}@${i.claim.machine}`}>${(i.claim.holder[0] ?? "?").toUpperCase()}</span>`}
        ${isPlan && html`<span class="ms-auto d-flex align-items-center gap-2"><${DomainTags} ds=${i.domains} /><${Badge} s=${i.status} /><${PlanBar} p=${i.plan_progress} /></span>`}
        ${isPlan && html`<span class="acts"><${ActBtn} title="open this plan's dependency graph"
          onClick=${(e) => {
            e.stopPropagation(); // the row itself opens the item
            nav(`graph/${i.id}`);
          }}><${GraphIcon} /></${ActBtn}></span>`}
        ${!isPlan && html`<span class="ms-auto d-flex align-items-center gap-2">
          <${DomainTags} ds=${i.domains} />
          ${i.status === "draft" && html`<span class="acts"><${ActBtn} variant="primary" title="approve this draft — it becomes ready for agents"
            onClick=${(e) => {
              e.stopPropagation(); // the row itself opens the item
              tree.act(i.id, "approve");
            }}><${CheckIcon} /></${ActBtn}></span>`}
        </span>`}
      </div>
      ${isOpen && shown.map((c) => html`<${PlanNode} key=${c.id} i=${c} depth=${depth + 1} tree=${tree} />`)}
    </div>`;
};
const Plans = ({ onOpen }) => {
  const { data, reload } = useApi("/api/items");
  const [q, setQ] = useState(() => loadSearch("te.plans.q"));
  const [showDone, setShowDoneState] = useState(() => loadSearch("te.plans.done") === "1");
  const [open, setOpenState] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("te.plans.open") ?? "{}");
    } catch {
      return {};
    }
  });
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const setOpen = (next) => {
    setOpenState(next);
    try {
      localStorage.setItem("te.plans.open", JSON.stringify(next));
    } catch {
      /* storage blocked — fold state just isn't remembered */
    }
  };
  const items = new Map(data.map((i) => [i.id, i]));
  const kids = new Map();
  for (const i of data) {
    if (!i.parent || !items.has(i.parent)) continue;
    if (!kids.has(i.parent)) kids.set(i.parent, []);
    kids.get(i.parent).push(i);
  }
  // tasks first, then sub-plans — each in id order
  for (const list of kids.values()) list.sort((a, b) => (a.type === "epic") - (b.type === "epic") || byId(a, b));
  const roots = data.filter((i) => i.type === "epic" && !(i.parent && items.has(i.parent))).sort((a, b) => byCreated(b, a));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // a plan matches when it or any descendant matches the search
  const subtreeMatches = (i) => matches(i, words) || (kids.get(i.id) ?? []).some(subtreeMatches);
  const visible = roots.filter((r) => (showDone || r.plan_state !== "done") && (!words.length || subtreeMatches(r)));
  const setSearch = (v) => {
    setQ(v);
    saveSearch("te.plans.q", v);
  };
  const setShowDone = (v) => {
    setShowDoneState(v);
    saveSearch("te.plans.done", v ? "1" : "");
  };
  const isOpenOf = (i, depth) => open[i.id] ?? (depth === 0 || words.length > 0);
  const setAll = (v) => setOpen(Object.fromEntries(data.filter((i) => i.type === "epic").map((i) => [i.id, v])));
  const act = async (id, action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => toast(e.message));
    reload();
  };
  const tree = { kids, words, subtreeMatches, isOpenOf, open, setOpen, onOpen, act, reload };
  return html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Plans</h2>
      <${SearchBox}
        style=${{ maxWidth: "24rem" }}
        placeholder="search plans and their tasks…"
        value=${q}
        onChange=${setSearch}
        autofocus
      />
      <button class="btn btn-sm ${showDone ? "btn-primary" : "btn-outline-secondary"}" title="also show finished plans" onClick=${() => setShowDone(!showDone)}>done plans</button>
      <span class="btn-group btn-group-sm" role="group"><button class="btn btn-outline-secondary" onClick=${() => setAll(true)}>expand all</button><button class="btn btn-outline-secondary" onClick=${() => setAll(false)}>collapse all</button></span>
      <span class="text-secondary small">${visible.length} of ${roots.length} plan(s)</span>
    </div>
    <div class="card card-body py-1 dense">
      ${visible.map((r) => html`<${PlanNode} key=${r.id} i=${r} depth=${0} tree=${tree} />`)}
      ${!visible.length && html`<div class="text-secondary py-2">no plans${words.length ? " match the search" : ""}</div>`}
    </div>
  `;
};

// ---- Archive -------------------------------------------------------------------
// archived items keep their status; they only leave the board, inbox, graph and next
const Archive = ({ onOpen }) => {
  const { data, reload } = useApi("/api/items?archived=true");
  const [q, setQ] = useState("");
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (words.length ? data.filter((i) => matches(i, words)) : data).sort((a, b) =>
    (b.archived_at ?? "").localeCompare(a.archived_at ?? ""),
  );
  const unarchive = async (id) => {
    await post(`/api/items/${id}/unarchive`).catch((e) => toast(e.message));
    reload();
  };
  return html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Archive</h2>
      <${SearchBox} style=${{ maxWidth: "24rem" }} value=${q} onChange=${setQ}
        placeholder="search id, title, project, file…" />
      <span class="text-secondary small">${hits.length} of ${data.length} archived</span>
    </div>
    ${data.length === 0 && html`<p class="text-secondary">nothing archived — use "archive" on an item page</p>`}
    <div class="list-group dense">
      ${hits.map(
        (i) => html`
          <div class="list-group-item d-flex align-items-center gap-2 flex-wrap" key=${i.id}>
            <a class="item id" onClick=${() => onOpen(i.id)}>${i.id}</a>
            <${StarBtn} i=${i} reload=${reload} />
            <${Badge} s=${i.status} />
            <span class="flex-grow-1">${i.title}</span>
            ${i.archived_at && html`<span class="text-secondary small">archived ${ago(i.archived_at)} ago</span>`}
            <button class="btn btn-sm btn-outline-primary btn-act" onClick=${() => unarchive(i.id)}>unarchive</button>
          </div>
        `,
      )}
    </div>
  `;
};

// ---- Domains -------------------------------------------------------------------
const Domains = () => {
  const rows = useDomains();
  const [name, setName] = useState("");
  const [sugg, setSugg] = useState(null);
  const [pick, setPick] = useState({});
  const call = async (path, body) => {
    try {
      const r = await post(path, body);
      refreshDomains();
      return r;
    } catch (e) {
      toast(e.message);
    }
  };
  const edit = async (r, field, label) => {
    const cur = field === "keywords" ? (r.keywords ?? []).join(", ") : (r[field] ?? "");
    const v = await promptDialog(`${label} for #${r.name}`, { value: cur });
    if (v === null) return;
    await call("/api/domains", { name: r.name, [field]: field === "keywords" ? v.split(",").map((x) => x.trim()).filter(Boolean) : v });
  };
  const rename = async (r) => {
    const to = await promptDialog(`rename #${r.name} to…`, { label: "an existing domain name merges into it", value: r.name });
    if (!to || to === r.name) return;
    const exists = (rows ?? []).some((x) => x.name === to.toLowerCase());
    if (exists && !(await confirmDialog(`merge #${r.name} into #${to}?`, `#${to} already exists — #${r.name} (${r.count} item(s)) merges into it.`, { ok: "merge" }))) return;
    await call(`/api/domains/${encodeURIComponent(r.name)}/rename`, { to });
  };
  const del = async (r) => {
    if (!(await confirmDialog(`delete #${r.name}?`, `It is removed from ${r.count + r.archived} item(s).`, { ok: "delete", danger: true }))) return;
    await call(`/api/domains/${encodeURIComponent(r.name)}/delete`, {});
  };
  const loadSuggest = async () => {
    const s = await api("/api/domains/suggest");
    setSugg(s);
    setPick(Object.fromEntries(s.map((x) => [x.id, true])));
  };
  const apply = async () => {
    const ids = Object.entries(pick).filter(([, v]) => v).map(([k]) => k);
    if (!ids.length) return;
    const r = await call("/api/domains/suggest/apply", { ids });
    if (r) toast(`added ${r.added} tag(s) on ${r.items} item(s)`, "success");
    setSugg(null);
  };
  if (!rows) return html`<p class="text-secondary">loading…</p>`;
  return html`
    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <h2 class="h4 mb-0 me-2">Domains</h2>
      <input class="form-control form-control-sm" style=${{ maxWidth: "14rem" }} placeholder="new domain" value=${name}
        onInput=${(e) => setName(e.target.value)}
        onKeyDown=${async (e) => {
          if (e.key === "Enter" && name.trim()) {
            await call("/api/domains", { name });
            setName("");
          }
        }} />
      <button class="btn btn-sm btn-primary" disabled=${!name.trim()} onClick=${async () => {
        await call("/api/domains", { name });
        setName("");
      }}>add</button>
      <button class="btn btn-sm btn-outline-secondary ms-auto" onClick=${loadSuggest}>suggest tags from keywords</button>
    </div>
    ${rows.length === 0 && html`<p class="text-secondary">no domains yet — add one, or type one on an item page</p>`}
    <div class="table-responsive"><table class="table table-sm align-middle">
      <thead><tr><th>domain</th><th>description</th><th>keywords (for suggestions)</th><th class="text-end">items</th><th class="text-end">open</th><th></th></tr></thead>
      <tbody>
        ${rows.map((r) => html`<tr key=${r.name}>
          <td><a href=${`#/board`} onClick=${() => saveSearch("te.board.domain", r.name)}><${DomainChip} d=${r.name} /></a></td>
          <td class="small"><span class="editable" onClick=${() => edit(r, "description", "Description")}>${r.description || html`<span class="text-secondary">add…</span>`}</span></td>
          <td class="small"><span class="editable" onClick=${() => edit(r, "keywords", "Keywords (comma separated)")}>${(r.keywords ?? []).join(", ") || html`<span class="text-secondary">add…</span>`}</span></td>
          <td class="text-end">${r.count}${r.archived ? html`<span class="text-secondary small"> +${r.archived} archived</span>` : ""}</td>
          <td class="text-end">${r.open}</td>
          <td class="text-end text-nowrap">
            <input type="color" class="domain-color" value=${toHexColor(r.color ?? fallbackColor(r.name))}
              title="pick a colour for #${r.name}${r.color ? "" : " (automatic — inherited from the name)"}"
              onChange=${(e) => call("/api/domains", { name: r.name, color: e.target.value })} />
            ${r.color && html`<button class="btn btn-sm btn-link py-0 px-1 text-secondary" title="reset to the automatic colour" onClick=${() => call("/api/domains", { name: r.name, color: "" })}>×</button>`}
            <button class="btn btn-sm btn-outline-secondary py-0" onClick=${() => rename(r)}>rename / merge</button>
            <button class="btn btn-sm btn-outline-danger py-0" onClick=${() => del(r)}>delete</button>
          </td>
        </tr>`)}
      </tbody>
    </table></div>
    ${sugg && html`<div class="card mt-3">
      <div class="card-header py-2 d-flex align-items-center gap-2">
        <b>Suggested tags</b> <span class="text-secondary small">${sugg.length} item(s) — from the keywords above; only adds, never removes</span>
        <button class="btn btn-sm btn-outline-secondary py-0 ms-auto" onClick=${() => setPick(Object.fromEntries(sugg.map((x) => [x.id, !Object.values(pick).every(Boolean)])))}>toggle all</button>
        <button class="btn btn-sm btn-primary py-0" onClick=${apply}>apply selected</button>
      </div>
      <ul class="list-group list-group-flush overflow-y-auto" style=${{ maxHeight: "46vh" }}>
        ${sugg.length === 0 && html`<li class="list-group-item text-secondary small">nothing to suggest — add keywords to domains first</li>`}
        ${sugg.map((x) => html`<li class="list-group-item small d-flex gap-2 align-items-center" key=${x.id}>
          <input type="checkbox" checked=${!!pick[x.id]} onChange=${(e) => setPick({ ...pick, [x.id]: e.target.checked })} />
          <a class="item id" href=${`#/item/${x.id}`}>${x.id}</a>
          <span class="flex-grow-1">${x.title}</span>
          <${DomainChips} ds=${x.current} />
          ${x.add.map((d) => html`<span class="badge domain-chip suggested" style=${{ background: domainColors[d] ?? fallbackColor(d) }}>+#${d}</span>`)}
        </li>`)}
      </ul>
    </div>`}
  `;
};

// ---- Graph (UI-0003) ----------------------------------------------------------
const ZOOM_MIN = 0.2, ZOOM_MAX = 16;
// minimap pinned under the zoom tools — the same svg scaled down, with a box
// over the visible window; click/drag pans the view so a deep zoom can't get lost
const MINI_W = 160, MINI_H = 120;
const MiniMap = ({ view, svg, zoom }) => {
  const boxRef = useRef(null);
  const dragging = useRef(false);
  const [m, setM] = useState(null); // { s, w, h, natW, natH, vp: {l,t,w,h} }
  useEffect(() => {
    const v = view.current;
    const el = v?.querySelector("svg");
    if (!v || !el) return setM(null);
    const update = () => {
      // the svg is laid out at zoom scale — rect/zoom is its size at rest
      // (SVGElement has no offsetWidth; no transforms are in play so the
      // rect's size is the layout box)
      const r = el.getBoundingClientRect();
      const natW = r.width / zoom, natH = r.height / zoom;
      const s = Math.min(MINI_W / natW, MINI_H / natH);
      const mapW = natW * s, mapH = natH * s;
      // the window rect is fraction-mapped: where the scroll offsets sit inside
      // their ranges maps to where the box sits inside the mini image
      const w = Math.min(mapW, (v.clientWidth / v.scrollWidth) * mapW);
      const h = Math.min(mapH, (v.clientHeight / v.scrollHeight) * mapH);
      const fx = v.scrollWidth > v.clientWidth ? v.scrollLeft / (v.scrollWidth - v.clientWidth) : 0;
      const fy = v.scrollHeight > v.clientHeight ? v.scrollTop / (v.scrollHeight - v.clientHeight) : 0;
      setM({ s, w: mapW, h: mapH, natW, natH, vp: { l: fx * (mapW - w), t: fy * (mapH - h), w, h } });
    };
    update();
    v.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(v);
    return () => {
      v.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [svg, zoom]);
  if (!m) return null;
  // a tap/drag inside the map centres the visible window on that point
  const jump = (e) => {
    const v = view.current, box = boxRef.current?.getBoundingClientRect();
    if (!v || !box) return;
    const nx = (e.clientX - box.left) / m.s / m.natW;
    const ny = (e.clientY - box.top) / m.s / m.natH;
    v.scrollLeft = Math.max(0, Math.min(v.scrollWidth - v.clientWidth, nx * v.scrollWidth - v.clientWidth / 2));
    v.scrollTop = Math.max(0, Math.min(v.scrollHeight - v.clientHeight, ny * v.scrollHeight - v.clientHeight / 2));
  };
  const end = () => (dragging.current = false);
  return html`
    <div ref=${boxRef} class="graph-mini" style=${{ width: m.w, height: m.h }} title="overview — click or drag to move the view"
      onPointerDown=${(e) => {
        dragging.current = true;
        boxRef.current.setPointerCapture(e.pointerId);
        jump(e);
      }}
      onPointerMove=${(e) => dragging.current && jump(e)} onPointerUp=${end} onPointerCancel=${end}>
      <div class="mini-svg" style=${{ width: m.natW, height: m.natH, transform: `scale(${m.s})` }} dangerouslySetInnerHTML=${{ __html: svg }} />
      <div class="vp" style=${{ left: m.vp.l, top: m.vp.t, width: m.vp.w, height: m.vp.h }} />
    </div>`;
};
const Graph = ({ onOpen, id }) => {
  const domains = useDomains();
  const blank = { q: "", status: "", domain: "", linked: false };
  // q / status / domain / linked, remembered per tab like the board search;
  // a plan-scoped graph (id) starts blank — a stored filter would hide the subtree
  const [f, setF] = useState(() => {
    if (id) return blank;
    try {
      return { ...blank, ...JSON.parse(sessionStorage.getItem("te.graph.f") ?? "{}") };
    } catch {
      return blank;
    }
  });
  const [applied, setApplied] = useState(f);
  const [svg, setSvg] = useState("");
  const [zoom, setZoom] = useState(1);
  const [src, setSrc] = useState("");
  const [count, setCount] = useState(null);
  const [drafts, setDrafts] = useState([]);
  // same component stays mounted between #/graph and #/graph/<id> — reset the
  // filters on scope switch (scoped edits never overwrite the saved ones)
  useEffect(() => {
    setF(
      id
        ? blank
        : (() => {
            try {
              return { ...blank, ...JSON.parse(sessionStorage.getItem("te.graph.f") ?? "{}") };
            } catch {
              return blank;
            }
          })(),
    );
  }, [id]);
  const update = (patch) => {
    const next = { ...f, ...patch };
    setF(next);
    if (id) return;
    try {
      sessionStorage.setItem("te.graph.f", JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };
  // redraw once typing pauses — mermaid layout is too slow for every keystroke
  useEffect(() => {
    const t = setTimeout(() => setApplied(f), f.q === applied.q ? 0 : 350);
    return () => clearTimeout(t);
  }, [f]);
  useEffect(() => {
    const p = new URLSearchParams();
    if (id) p.set("under", id);
    if (applied.q.trim()) p.set("q", applied.q.trim());
    if (applied.status) p.set("status", applied.status);
    if (applied.domain) p.set("domain", applied.domain);
    if (applied.linked) p.set("linked", "1");
    const qs = p.toString();
    let live = true;
    api(`/api/graph${qs ? "?" + qs : ""}`).then(async (r) => {
      if (!live) return;
      setSrc(r.mermaid);
      setCount(r.count ?? null);
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default" });
      const { svg } = await mermaid.render("g" + Date.now(), r.mermaid);
      if (live) setSvg(svg);
    });
    return () => {
      live = false;
    };
  }, [applied, id]);
  // drafts currently on screen → approve buttons in the corner panel;
  // node ids in the mermaid source look like GL_0013
  useEffect(() => {
    const shown = new Set([...src.matchAll(/[A-Z][A-Z0-9]*_\d+/g)].map((m) => m[0].replace("_", "-")));
    if (!shown.size) {
      setDrafts([]);
      return;
    }
    let live = true;
    api("/api/items?status=draft").then((items) => {
      if (live) setDrafts(items.filter((i) => shown.has(i.id)));
    });
    return () => {
      live = false;
    };
  }, [src]);
  const act = async (itemId, action, body) => {
    await post(`/api/items/${itemId}/${action}`, body).catch((e) => toast(e.message));
    setApplied((a) => ({ ...a })); // refetch — the node redraws / drops off the filter
  };
  const filtering = f.q.trim() || f.status || f.domain;
  // drag anywhere pans the scrollable view; a press that moves <5px still counts as a click (opens the item)
  const viewRef = useRef(null);
  const pan = useRef(null);
  const panSuppressUntil = useRef(0);
  const panStart = (e) => {
    if (e.button !== 0 || !viewRef.current) return;
    pan.current = { x: e.clientX, y: e.clientY, left: viewRef.current.scrollLeft, top: viewRef.current.scrollTop, moved: false };
    viewRef.current.setPointerCapture(e.pointerId);
  };
  const panMove = (e) => {
    const d = pan.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) <= 4) return;
    d.moved = true;
    viewRef.current.classList.add("dragging");
    viewRef.current.scrollLeft = d.left - dx;
    viewRef.current.scrollTop = d.top - dy;
  };
  const panEnd = () => {
    if (pan.current?.moved) panSuppressUntil.current = Date.now() + 350;
    viewRef.current?.classList.remove("dragging");
    pan.current = null;
  };
  // wheel zooms around the cursor: remember the content point under it, restore the scroll
  // position once the new --zoom scale has re-rendered. zoomRef tracks the latest level —
  // fast wheel ticks land before re-render, so state alone would drop steps
  const zoomRef = useRef(zoom);
  const zoomAnchor = useRef(null);
  const applyZoom = (z2) => {
    zoomRef.current = z2;
    setZoom(z2);
  };
  const wheelZoom = (e) => {
    e.preventDefault();
    const v = viewRef.current;
    if (!v) return;
    const r = v.getBoundingClientRect();
    const st = getComputedStyle(v);
    const ox = e.clientX - r.left - (parseFloat(st.paddingLeft) || 0);
    const oy = e.clientY - r.top - (parseFloat(st.paddingTop) || 0);
    const z1 = zoomRef.current;
    const z2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z1 * (e.deltaY < 0 ? 1.25 : 1 / 1.25)).toFixed(2)));
    if (z2 === z1) return;
    zoomAnchor.current = { ox, oy, cx: (v.scrollLeft + ox) / z1, cy: (v.scrollTop + oy) / z1 };
    applyZoom(z2);
  };
  useEffect(() => {
    const a = zoomAnchor.current;
    const v = viewRef.current;
    zoomRef.current = zoom;
    zoomAnchor.current = null;
    if (!a || !v) return;
    v.scrollLeft = a.cx * zoom - a.ox;
    v.scrollTop = a.cy * zoom - a.oy;
  }, [zoom]);
  return html`
    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <h2 class="h4 mb-0 me-2">Graph</h2>
      ${id && html`<span class="badge text-bg-secondary" title="graph scoped to this plan and its parts">
        plan ${id} <a href="#/graph" class="text-reset ms-1 text-decoration-none" title="back to the full graph">×</a></span>`}
      <${SearchBox} style=${{ maxWidth: "22rem" }} value=${f.q} onChange=${(v) => update({ q: v })}
        placeholder="search id, title, project, file, #domain…" />
      <select class="form-select form-select-sm w-auto" value=${f.status} onChange=${(e) => update({ status: e.target.value })}>
        <option value="">all statuses</option>
        ${STATUSES.map((st) => html`<option value=${st}>${st}</option>`)}
      </select>
      <select class="form-select form-select-sm w-auto" value=${f.domain} onChange=${(e) => update({ domain: e.target.value })}>
        <option value="">all domains</option>
        ${(domains ?? []).map((d) => html`<option value=${d.name}>#${d.name}</option>`)}
      </select>
      <label class="form-check-label small d-flex align-items-center gap-1" title="also show tasks one step away: dependencies, dependents, parent and children">
        <input type="checkbox" class="form-check-input mt-0" checked=${f.linked} disabled=${!filtering}
          onChange=${(e) => update({ linked: e.target.checked })} /> + linked
      </label>
      ${count !== null && html`<span class="text-secondary small">${count} match${count === 1 ? "" : "es"}${count > 80 ? " — showing 80, narrow the search" : ""}</span>`}
    </div>
    <div class="graph-wrap">
      <div class="graph-tools btn-group btn-group-sm">
        <button class="btn btn-outline-secondary bg-body" title="zoom out" disabled=${zoom <= ZOOM_MIN}
          onClick=${() => applyZoom(Math.max(ZOOM_MIN, +(zoomRef.current / 1.25).toFixed(2)))}>−</button>
        <button class="btn btn-outline-secondary bg-body" title="reset zoom" onClick=${() => applyZoom(1)}>${Math.round(zoom * 100)}%</button>
        <button class="btn btn-outline-secondary bg-body" title="zoom in" disabled=${zoom >= ZOOM_MAX}
          onClick=${() => applyZoom(Math.min(ZOOM_MAX, +(zoomRef.current * 1.25).toFixed(2)))}>+</button>
      </div>
      ${drafts.length > 0 && html`
        <div class="graph-drafts card py-1 px-2">
          <div class="small text-secondary">drafts</div>
          ${drafts.slice(0, 10).map((d) => html`
            <div key=${d.id} class="d-flex align-items-center gap-2">
              <a class="id small" title=${d.title ?? ""} onClick=${() => onOpen(d.id)}>${d.id}</a>
              <${ActBtn} variant="primary" title="approve this draft — it becomes ready for agents"
                onClick=${() => act(d.id, "approve")}><${CheckIcon} /></${ActBtn}>
            </div>`)}
          ${drafts.length > 10 && html`<div class="small text-secondary">+${drafts.length - 10} more</div>`}
        </div>`}
      <${MiniMap} view=${viewRef} svg=${svg} zoom=${zoom} />
      <div ref=${viewRef} class="card card-body graph-view" style=${{ "--zoom": zoom }}
        onPointerDown=${panStart} onPointerMove=${panMove} onPointerUp=${panEnd} onPointerCancel=${panEnd}
        onWheel=${wheelZoom}
        onClick=${(e) => {
          if (Date.now() < panSuppressUntil.current) return;
          // pointer capture retargets click at the view — hit-test the node actually under the pointer
          const el = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
          const id = el?.closest?.("[id]")?.id?.match(/[A-Z]{2,}[-_]\d+/);
          if (id) onOpen(id[0].replace("_", "-"));
        }}>
        <div class="graph-zoom" dangerouslySetInnerHTML=${{ __html: svg }} />
      </div>
    </div>
    <details class="mt-2"><summary class="text-secondary">mermaid source</summary><pre class="card card-body small">${src}</pre></details>
  `;
};

// `## Log` lines are `- <iso ts> <who> <text>` (daemon-written); anything
// else (a hand-written line) is kept as plain text
const LOG_LINE = /^-\s+(\d{4}-\d\d-\d\dT\S+)\s+(\S+)\s+(.*)$/;
const parseLog = (body) =>
  body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = LOG_LINE.exec(l);
      return m ? { ts: m[1], who: m[2], text: m[3] } : { text: l.replace(/^-\s*/, "") };
    });

// author tag colour: `human` is written literally, `daemon` marks daemon
// writes, `watch`/`reconcile` are daemon-side notices, anything else is an
// agent session id (agent@machine#hex)
const whoKind = (w) => (w === "human" ? "human" : ["daemon", "watch", "reconcile"].includes(w) ? "daemon" : "agent");
const whoCls = (w) => `who-${whoKind(w)}`;

// release is only a valid transition from in_progress/waiting — anything
// else (e.g. in_review) is refused by the state machine
const canRelease = (status) => status === "in_progress" || status === "waiting";
const releaseTitle = (status) =>
  canRelease(status)
    ? "release the claim — work is kept, the item goes back to ready"
    : "a claim can only be released while work is in progress or waiting";

const History = ({ entries }) => html`
  <ul class="list-group list-group-flush overflow-y-auto" style=${{ maxHeight: "46vh" }}>
    ${entries.length === 0 && html`<li class="list-group-item text-secondary small">no history yet</li>`}
    ${[...entries].reverse().map(
      (e, i) => html`
        <li class="list-group-item small" key=${i}>
          ${e.ts && html`<span class="text-secondary me-2" title=${e.ts}>${e.ts.slice(0, 16).replace("T", " ")} · ${ago(e.ts)} ago</span>`}
          ${e.who && html`<b class="me-1 ${whoCls(e.who)}">${e.who}</b>`}
          <span class="md-inline" dangerouslySetInnerHTML=${{ __html: inlineMarkdown(e.text) }} />
        </li>
      `,
    )}
  </ul>
`;

// dependencies of an item: ref, live status and the dep's latest log line
const Deps = ({ deps }) => html`
  <ul class="list-group list-group-flush">
    ${deps.map((d) => {
      const e = parseLog(d.outcome)[0] ?? {};
      return html`
        <li class="list-group-item small" key=${d.ref}>
          ${d.ref.includes(":")
            ? html`<span class="id me-2">${d.ref}</span>`
            : html`<a class="item id me-2" onClick=${() => nav(`item/${d.ref}`)}>${d.ref}</a>`}
          <${Badge} s=${d.status} />
          ${d.key && html` <span title="key task — dependents wait for its acceptance">🔑</span>`}
          ${d.pending && html` <span class="text-secondary" title="satisfied only by review_unblocks — it may still be rejected">pending</span>`}
          ${e.text && html`<div class="text-secondary mt-1">
            ${e.ts && html`<span title=${e.ts}>${e.ts.slice(0, 16).replace("T", " ")} · ${ago(e.ts)} ago</span> `}
            ${e.who && html`<b class="me-1 ${whoCls(e.who)}">${e.who}</b>`}<span class="md-inline" dangerouslySetInnerHTML=${{ __html: inlineMarkdown(e.text) }} />
          </div>`}
        </li>
      `;
    })}
  </ul>
`;

// task text: formatted markdown by default, raw source on toggle (per browser)
const loadMdView = () => {
  try {
    return localStorage.getItem("te.md.view") === "markdown" ? "markdown" : "formatted";
  } catch {
    return "formatted";
  }
};
const saveMdView = (v) => {
  try {
    localStorage.setItem("te.md.view", v);
  } catch {
    /* not remembered — fine */
  }
};
const MdBox = ({ text, view }) =>
  view === "markdown"
    ? html`<pre class="mb-0">${text}</pre>`
    : html`<div class="md-view" dangerouslySetInnerHTML=${{ __html: markdownToHtml(text) }} />`;

// a daemon-written note starts with `**YYYY-MM-DD HH:MM · who**`; text before
// the first such line is something typed into the file without an author
const NOTE_HEAD = /^\*\*(\d{4}-\d\d-\d\d \d\d:\d\d) · (\S+)\*\*$/;
const parseNotes = (body) => {
  const blocks = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : NOTE_HEAD.exec(line.trim());
    if (m) blocks.push({ ts: m[1], who: m[2], md: "" });
    else if (blocks.length) blocks.at(-1).md += "\n" + line;
    else blocks.push({ md: line });
  }
  return blocks.map((b) => ({ ...b, md: b.md.trim() })).filter((b) => b.who || b.md);
};

// notes: the task file's ## Notes, shown formatted, plus a multi-line field to add one
const Notes = ({ id, text, onAdded }) => {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await post(`/api/items/${id}/note`, { text: draft });
      setDraft("");
      onAdded();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (b) => {
    const preview = b.md.length > 140 ? `${b.md.slice(0, 140)}…` : b.md;
    if (busy || !(await confirmDialog("delete this note?", preview, { ok: "delete", danger: true }))) return;
    setBusy(true);
    try {
      await post(`/api/items/${id}/delnote`, { ts: b.ts, who: b.who, body: b.md });
      onAdded();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const blocks = parseNotes(text ?? "");
  return html`
    <div>
      ${blocks.length
        ? html`<div class="mb-3">${blocks.map((b, i) => html`
            <div class="note${b.who ? ` note-${whoKind(b.who)}` : ""}" key=${i}>
              ${b.who && html`<div class="note-by d-flex align-items-center gap-1"><b class=${whoCls(b.who)}>${b.who}</b> <span class="text-secondary">· ${b.ts}</span>
                ${b.who === "human" && html`<button class="btn btn-sm btn-outline-danger py-0 px-1 ms-auto" title="delete this note" disabled=${busy} onClick=${() => del(b)}><${TrashIcon} /></button>`}
              </div>`}
              ${b.md && html`<div class="md-view" dangerouslySetInnerHTML=${{ __html: markdownToHtml(b.md) }} />`}
            </div>`)}
          </div>`
        : html`<p class="text-secondary small mb-2">no notes yet</p>`}
      <textarea class="form-control form-control-sm" rows="4" placeholder="add a note — markdown welcome; Ctrl+Enter to save"
        value=${draft} onInput=${(e) => setDraft(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) add();
        }} />
      <div class="d-flex justify-content-end mt-2">
        <button class="btn btn-sm btn-primary btn-act" disabled=${!draft.trim() || busy} onClick=${add}>${busy ? "saving…" : "add note"}</button>
      </div>
    </div>
  `;
};

// domains on an item: chips with × and an input (datalist of known domains)
const DomainEditor = ({ id, ds, onChanged }) => {
  const rows = useDomains();
  const [draft, setDraft] = useState("");
  const save = async (next) => {
    try {
      await post(`/api/items/${id}/domains`, { domains: next });
      setDraft("");
      onChanged();
      refreshDomains();
    } catch (e) {
      toast(e.message);
    }
  };
  const add = () => {
    const names = draft.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    if (names.length) save([...(ds ?? []), ...names]);
  };
  return html`
    <div class="d-flex flex-wrap align-items-center gap-1 mb-2">
      <span class="text-secondary small me-1 item-lbl">domains</span>
      ${(ds ?? []).map((d) => html`<${DomainChip} key=${d} d=${d} onRemove=${(x) => save(ds.filter((y) => y !== x))} />`)}
      <input class="form-control form-control-sm domain-input" list="te-domain-list" placeholder="+ domain" value=${draft}
        onInput=${(e) => setDraft(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }} />
      <datalist id="te-domain-list">${(rows ?? []).map((r) => html`<option value=${r.name}>${r.description ?? ""}</option>`)}</datalist>
    </div>
  `;
};

// ---- Item (UI-0005) ------------------------------------------------------------
// icon-only bar button — every action is the same square size; the tooltip is the label
const ActBtn = ({ variant = "outline-secondary", title, disabled, onClick, children }) => html`
  <button class="btn btn-sm btn-${variant} act-btn" disabled=${disabled} title=${title} onClick=${onClick}>${children}</button>`;

const ItemView = ({ id }) => {
  const { data: b, reload } = useApi(`/api/items/${id}`, [id]);
  const [picked, setTab] = useState(null);
  const [mdView, setMdView] = useState(loadMdView);
  const toggleMd = () => {
    const v = mdView === "formatted" ? "markdown" : "formatted";
    setMdView(v);
    saveMdView(v);
  };
  useEffect(() => setTab(null), [id]);
  if (!b) return html`<p class="text-secondary">loading…</p>`;
  const it = b.item;
  const st = it.meta.status;
  const sec = (n) => it.sections.find((s) => s.heading.toLowerCase() === n.toLowerCase())?.body.trim() ?? "";
  // open on the plain-English tab only when the item has one
  const tab = picked ?? (b.source?.simple?.text || sec("simple") ? "simple" : "technical");
  const act = async (action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => toast(e.message));
    reload();
  };
  // the answer the human gave on this item (its latest decision) - changeable until the item is closed
  const ownLast = (b?.decisions ?? []).filter((d) => d.meta.item === id).map((d) => d.meta.id)
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).pop();
  // a cancelled prompt (null) aborts the action — only OK fires it
  const askThen = async (action, label) => {
    const reason = await promptDialog(label);
    if (reason !== null) act(action, { reason });
  };
  const TABS = ["simple", "technical", "evidence"];
  // "graph" like the plans-page action: an epic opens its plan subtree
  // (#/graph/<id>); a task opens the full graph searched on its id with
  // + linked on — itself plus everything one step away
  const openGraph = () => {
    if (it.meta.type === "epic") return nav(`graph/${id}`);
    try {
      sessionStorage.setItem("te.graph.f", JSON.stringify({ q: id, status: "", domain: "", linked: true }));
    } catch {
      /* storage blocked — the graph still opens, just unfiltered */
    }
    nav("graph");
  };
  const remove = async () => {
    const msg =
      `Its tracking and history entry go away. ` +
      (b.source ? `The task file ${b.source.path} stays as plain Markdown (te: line removed, path ignored).` : "");
    if (!(await confirmDialog(`delete ${it.meta.id}?`, msg, { ok: "delete", danger: true }))) return;
    const reason = await promptDialog("delete reason", { label: "reason (optional)" });
    if (reason === null) return;
    try {
      await post(`/api/items/${id}/delete`, { reason });
      nav("board");
    } catch (e) {
      toast(e.message);
    }
  };
  const history = parseLog(sec("log"));
  const last = history.at(-1);
  const dependents = b.dependents ?? [];
  const closed = st === "done" || st === "dropped";
  // unblocks policy as a radio line — in the chain strip for real items;
  // for drafts it stays one level down inside details (nothing waits on a draft)
  const policy = it.meta.unblocks_on ?? "default";
  const polLine = html`
    <span class="pol-r">
      ${[
        ["default", `default (${b.reviewUnblocks === false ? "at acceptance" : "at review"})`],
        ["review", "at review"],
        ["done", "🔑 only after acceptance"],
      ].map(
        ([v, l]) => html`
          <label key=${v} class=${policy === v ? "on" : ""} title="when dependents may start">
            <input type="radio" name="unblocks-on-${id}" checked=${policy === v}
              onChange=${() => v !== policy && act("unblocks", { on: v })} />${l}
          </label>`,
      )}
    </span>`;
  // a dep/dependent chip inside the chain strip: id link + status badge
  const depLink = (d) => html`<span key=${d.ref} class="d-inline-flex align-items-center gap-1">
    ${d.ref.includes(":")
      ? html`<span class="id">${d.ref}</span>`
      : html`<a class="item id" onClick=${() => nav(`item/${d.ref}`)}>${d.ref}</a>`}
    <${Badge} s=${d.status} />
    ${d.key && html`<span title="key task — dependents wait for its acceptance">🔑</span>`}
    ${d.pending && html`<span class="text-secondary" title="satisfied only by review_unblocks — it may still be rejected">pending</span>`}
  </span>`;
  // utility buttons after the workflow ones: star/graph always enabled;
  // archive & delete are disabled while a claim holds the item — release it first
  const claimed = Boolean(it.claim);
  return html`
    <div class="sticky-top bg-body border-bottom py-1 d-flex align-items-center gap-2" style=${{ top: "2.75rem", zIndex: 1010 }}>
      <span class="id flex-shrink-0">${it.meta.id}</span>
      <${Badge} s=${st} />
      ${it.meta.type === "epic" && html`<${PlanBadge} i=${it} />`}
      ${it.meta.type === "idea" && html`<span class="badge text-bg-info" title="idea — a source document; agents plan from it, it is never claimed">idea</span>`}
      ${it.meta.archived && html`<span class="badge text-bg-secondary">archived</span>`}
      <span class="text-truncate text-secondary" title=${it.meta.title}>${it.meta.title}</span>
      <div class="d-flex gap-2 ms-auto flex-nowrap flex-shrink-0">
        ${st === "draft" && html`<${ActBtn} variant="primary" title="approve — promote the draft to ready" onClick=${() => act("approve")}><${CheckIcon} /></${ActBtn}>`}
        ${st === "hold" && html`<${ActBtn} variant="primary" title="resume — take it off hold" onClick=${() => act("unhold")}><${PlayIcon} /></${ActBtn}>`}
        ${(st === "draft" || st === "ready") && html`<${ActBtn} title="hold — park it with an optional reason" onClick=${() => askThen("hold", "hold reason (optional)")}><${PauseIcon} /></${ActBtn}>`}
        ${(st === "ready" || st === "hold" || st === "done") && html`<${ActBtn} title=${st === "done" ? "reopen — back to draft" : "to draft — pull it back for edits"} onClick=${() => askThen("draft", st === "done" ? "reopen — why back to draft? (optional)" : "why back to draft? (optional)")}>${st === "done" ? html`<${UndoIcon} />` : html`<${PencilIcon} />`}</${ActBtn}>`}
        ${st === "in_review" && html`<${ActBtn} variant="success" title="accept — merge the claim's worktrees, the item becomes done" onClick=${async () => { if (await confirmDialog(`accept ${id}?`, "the claim's worktrees merge into the task repo(s) and the item becomes done — the merges cannot be undone from here.", { ok: "accept" })) act("accept"); }}><${CheckCircleIcon} /></${ActBtn}><${ActBtn} variant="outline-danger" title="reject — send the submission back with a reason" onClick=${() => askThen("reject", "reject reason")}><${XCircleIcon} /></${ActBtn}>`}
        ${it.claim && html`<${ActBtn} variant="outline-primary" disabled=${!canRelease(st)} title=${releaseTitle(st)} onClick=${async () => { if (await confirmDialog(`release the claim on ${id}?`, `held by ${it.claim.holder}@${it.claim.machine} — the item goes back to ready; work in its worktree is kept but the claim record is gone.`, { ok: "release", danger: true })) act("release", { note: "released by human" }); }}><${UnlockIcon} /></${ActBtn}>`}
        ${st === "dropped" && html`<${ActBtn} variant="outline-primary" title="undrop — bring it back" onClick=${() => act("undrop")}><${UndoIcon} /></${ActBtn}>`}
        ${it.meta.type === "epic" && !it.meta.plan_closed && html`<${ActBtn} variant="outline-primary" title="close plan — no more parts are coming; the plan becomes active, then done when every part finishes" onClick=${() => act("close_plan")}><${LockIcon} /></${ActBtn}>`}
        ${it.meta.type === "epic" && it.meta.plan_closed && html`<${ActBtn} variant="outline-primary" title="reopen plan — more parts may still be added" onClick=${() => act("reopen_plan")}><${PlusSquareIcon} /></${ActBtn}>`}
        ${st !== "done" && html`<${ActBtn} variant="outline-success" title="mark done — complete it now, optional note" onClick=${async () => { const note = await promptDialog("mark done", { label: "note (optional)" }); if (note !== null) act("complete", { note }); }}><${CheckSquareIcon} /></${ActBtn}>`}
        ${!closed && html`<${ActBtn} variant="outline-danger" title="drop — abandon it with a reason" onClick=${() => askThen("drop", "drop reason")}><${XIcon} /></${ActBtn}>`}
        ${it.meta.archived && html`<${ActBtn} variant="primary" title="unarchive — back to the lists" onClick=${() => act("unarchive")}><${UndoIcon} /></${ActBtn}>`}
        <${ActBtn} title=${it.meta.star_color ? `starred ${it.meta.star_color} — click to flip, ends on unstar` : "star — bookmark this task"}
          onClick=${() => { const next = nextStarColor(it.meta.star_color); act(next ? "star" : "unstar", next ? { color: next } : undefined); }}>
          <span class=${STAR_TEXT[it.meta.star_color] ?? ""}><${StarIcon} filled=${Boolean(it.meta.star_color)} /></span>
        </${ActBtn}>
        <${ActBtn} title=${it.meta.type === "epic" ? "open this plan's dependency graph" : "open the graph around this item — itself plus everything linked to it"}
          onClick=${openGraph}><${GraphIcon} /></${ActBtn}>
        ${!it.meta.archived && html`<${ActBtn} disabled=${claimed}
          title=${claimed ? "archive — the claim holds it; release the claim first" : "archive — file away out of the lists"}
          onClick=${() => askThen("archive", "archive note (optional)")}><${ArchiveIcon} /></${ActBtn}>`}
        <${ActBtn} variant="outline-danger" disabled=${claimed}
          title=${claimed ? "delete — the claim holds it; release the claim first" : "delete — remove tracking, keep the task file"}
          onClick=${remove}><${TrashIcon} /></${ActBtn}>
      </div>
    </div>
    ${it.meta.drop_request && html`<div class="alert alert-warning py-2 px-2 small mb-2 d-flex align-items-center gap-2 flex-wrap">
      <span><b>flagged for drop</b> by <b class=${whoCls(it.meta.drop_request.by)}>${it.meta.drop_request.by}</b> · ${ago(it.meta.drop_request.at)} ago${it.meta.drop_request.reason ? html` — ${it.meta.drop_request.reason}` : ""}</span>
      <span class="ms-auto d-flex gap-2">
        <button class="btn btn-sm btn-outline-danger py-0" onClick=${async () => {
          if (await confirmDialog(`drop ${id}?`, `flagged by ${it.meta.drop_request.by}${it.meta.drop_request.reason ? `: ${it.meta.drop_request.reason}` : ""} — dependents treat a dropped task as done.`, { ok: "drop", danger: true })) act("drop", { reason: it.meta.drop_request.reason });
        }}>drop</button>
        <button class="btn btn-sm btn-outline-secondary py-0" title="dismiss the flag — the item stays" onClick=${() => act("unflag")}>keep</button>
      </span>
    </div>`}
    <div class="chain st-${st}">
      <span class="text-secondary">waits on</span>
      ${b.deps.length === 0 ? html`<span class="text-secondary">nothing</span>` : b.deps.slice(0, 4).map(depLink)}
      ${b.deps.length > 4 && html`<span class="text-secondary">+${b.deps.length - 4} more</span>`}
      ${!closed && html`<a class="ms-1" title="edit dependencies — comma-separated ids; empty clears" onClick=${async () => {
        const v = await promptDialog(`depends on — ${id}`, { label: "comma-separated ids (empty = nothing)", value: (it.meta.depends_on ?? []).join(", ") });
        if (v === null) return;
        act("deps", { depends_on: v.split(",").map((s) => s.trim()).filter(Boolean) });
      }}><${PencilIcon} /></a>`}
      <span class="sep">·</span>
      <span class="text-secondary">unblocks →</span>
      ${dependents.length === 0 ? html`<span class="text-secondary">nothing yet</span>` : dependents.map(depLink)}
      ${st === "draft"
        ? html`<span class="text-secondary ms-auto">policy lives in details</span>`
        : html`<span class="sep">·</span><span class="text-secondary">when:</span>${polLine}
          ${st === "done" && html`<span class="text-secondary" title="done satisfies dependents under every setting — this is stored policy for a rerun">applies if reopened</span>`}`}
    </div>
    ${(it.meta.type === "idea" || (b.relates ?? []).length > 0 || (b.referenced_by ?? []).length > 0) && html`
    <div class="chain st-${st}">
      <span class="text-secondary">relates</span>
      ${(b.relates ?? []).length === 0 ? html`<span class="text-secondary">nothing</span>` : b.relates.map(depLink)}
      ${!closed && html`<a class="ms-1" title="edit relates — comma-separated ids this item references (ideas, other sources); empty clears" onClick=${async () => {
        const v = await promptDialog(`relates — ${id}`, { label: "comma-separated ids (empty = nothing)", value: (it.meta.relates ?? []).join(", ") });
        if (v === null) return;
        act("relate", { relates: v.split(",").map((s) => s.trim()).filter(Boolean) });
      }}><${PencilIcon} /></a>`}
      <span class="sep">·</span>
      <span class="text-secondary">referenced by ←</span>
      ${(b.referenced_by ?? []).length === 0 ? html`<span class="text-secondary">nothing yet</span>` : b.referenced_by.map(depLink)}
    </div>`}
    <details class="disc">
      <summary class="disc-bar"><span class="caret"></span><span class="disc-t fw-semibold">details</span>
        <span>v${it.meta.version} · ${it.meta.type}${it.meta.project ? " · " + it.meta.project : ""}${(it.meta.domains ?? []).map((d) => " #" + d).join("")}${it.claim ? ` · claim ${it.claim.holder}@${it.claim.machine}` : ""}</span>
      </summary>
      <div class="disc-panel">
        <${DomainEditor} id=${id} ds=${it.meta.domains} onChanged=${reload} />
        <div class="d-flex align-items-center gap-2 mb-1 small"><span class="text-secondary item-lbl">meta</span><span class="text-secondary">v${it.meta.version} · ${it.meta.type}${it.meta.project ? " · " + it.meta.project : ""}${it.meta.archived ? " · archived" : ""}</span></div>
        ${it.claim && html`<div class="d-flex align-items-center gap-2 mb-1 small"><span class="text-secondary item-lbl">claim</span><span>${it.claim.holder}@${it.claim.machine}${it.claim.claimed_at && html` <span class="text-secondary">· ${ago(it.claim.claimed_at)} ago — release via the button above</span>`}</span></div>`}
        ${b.source && html`<div class="d-flex align-items-center gap-2 mb-1 small"><span class="text-secondary item-lbl">source</span><span class="text-secondary">${b.source.path}${b.source.missing ? " (MISSING)" : b.source.moved ? " (moved)" : ""}</span></div>`}
        ${st === "draft" && html`<div class="d-flex align-items-center gap-2 small"><span class="text-secondary item-lbl">unblocks</span>${polLine}</div>`}
      </div>
    </details>
    ${last && html`<div class="d-flex align-items-baseline gap-2 mt-2 small flex-wrap">
      <span class="text-secondary">latest</span>
      ${last.who && html`<b class=${whoCls(last.who)}>${last.who}</b>`}
      <span class="md-inline" dangerouslySetInnerHTML=${{ __html: inlineMarkdown(last.text) }} />
      ${last.ts && html`<span class="text-secondary">· ${ago(last.ts)} ago</span>`}
    </div>`}
    ${it.meta.ai_review && html`<div class="alert ${it.meta.ai_review.verdict === "ok" ? "alert-success" : "alert-danger"} py-2 px-2 small mb-2">
      <b>AI review: ${it.meta.ai_review.verdict === "ok" ? "ok ✓" : "issues ✗"}</b>
      <span class="text-secondary">— peer-reviewed by <b class=${whoCls(it.meta.ai_review.reviewed_by)}>${it.meta.ai_review.reviewed_by}</b> · ${ago(it.meta.ai_review.reviewed_at)} ago · ${b.autoAcceptAt ? "" : "advisory, the accept is still yours"}</span>
      ${b.autoAcceptAt && html`<div class="mt-1 d-flex align-items-center gap-2 flex-wrap">
        <span class="badge text-bg-warning">⏱ auto-accept ${untilText(b.autoAcceptAt)}</span>
        <span class="text-secondary">autonomy: solo — the daemon accepts (local merge, no push) unless you accept, reject or stop it</span>
        <button class="btn btn-sm btn-outline-secondary py-0" title="keep this submission for your own accept/reject (a resubmit re-arms it)" onClick=${() => act("stop-auto-accept")}>stop auto-accept</button>
      </div>`}
      ${it.meta.ai_review.summary && html`<div class="md-view mt-1" dangerouslySetInnerHTML=${{ __html: markdownToHtml(it.meta.ai_review.summary) }} />`}
      ${it.meta.ai_review.note && html`<div class="md-view mt-1 text-secondary" dangerouslySetInnerHTML=${{ __html: markdownToHtml(it.meta.ai_review.note) }} />`}
    </div>`}
    ${it.meta.question && html`<div class="alert alert-info py-2 px-2 small mb-2">
      <b>question</b>${it.meta.question.asked_by ? html` <span class="text-secondary">from <b class=${whoCls(it.meta.question.asked_by)}>${it.meta.question.asked_by}</b></span>` : ""}
      <div class="md-view mt-1" dangerouslySetInnerHTML=${{ __html: markdownToHtml(it.meta.question.text) }} />
      ${it.meta.status === "waiting" && html`<div class="mt-2"><${AnswerBox} id=${id} opts=${it.meta.question.options} onAnswer=${(text) => act("answer", { text })} /></div>`}
    </div>`}
    <div class="card mt-2">
      <div class="card-header d-flex align-items-center gap-3 py-1 flex-wrap">
        <div class="vtabs">
          ${TABS.map((t) => html`<a key=${t} class=${tab === t ? "on" : ""} onClick=${() => setTab(t)}>${t}</a>`)}
        </div>
        <span class="ms-auto d-flex align-items-center gap-3">
          ${b.source && html`<span class="text-secondary small text-truncate d-inline-block" style=${{ maxWidth: "22rem" }} title=${b.source.path}>${b.source.path}${b.source.missing ? " (MISSING)" : b.source.moved ? " (moved)" : ""}</span>`}
          ${(tab === "simple" || tab === "technical") && html`<a class="small text-nowrap" onClick=${toggleMd}
            title="switch between formatted text and the markdown source">${mdView === "formatted" ? "⟨/⟩ markdown" : "formatted"}</a>`}
        </span>
      </div>
      <div class="card-body">
        ${tab === "simple" && html`<${MdBox} view=${mdView} text=${b.source?.simple?.text ?? (sec("Simple") || "(no simple version — ask an agent: simple <id> {text})")} />`}
        ${tab === "technical" && html`
          <${MdBox} view=${mdView} text=${b.source ? (b.source.text?.trim() || "(the task file is empty)") : `${sec("Summary")}\n\n## Acceptance\n${sec("Acceptance")}`} />
          ${b.targets.map((t) => html`<div class="text-secondary small">target ${t.ref} → ${t.kind}${t.path ? " " + t.path : ""}${t.host ? " " + t.host : ""}</div>`)}
        `}
        ${tab === "evidence" && html`<pre class="mb-0">${sec("Evidence") || "(none)"}</pre>
          ${(it.meta.deliveries ?? []).map((d) => html`<div class="text-secondary small">delivery ${d.resource} ${d.merge_commit?.slice(0, 12)} — ${d.pushed ? "pushed" : "not pushed"}</div>`)}`}
      </div>
    </div>
    ${b.decisions.map((d) => html`<${DecisionCard} d=${d} canChange=${!closed && d.meta.id === ownLast}
      onChange=${(text) => act("change_answer", { text })} />`)}
    ${b.deps.length > 0 && html`
      <details class="sec"><summary><span class="caret"></span><b>Dependencies</b><span class="text-secondary small">${b.deps.length} — what this task waits on</span></summary>
        <div class="sec-bd"><${Deps} deps=${b.deps} /></div></details>`}
    <details class="sec"><summary><span class="caret"></span><b>Notes</b><span class="text-secondary small">${parseNotes(b.source ? notesSection(b.source.text ?? "") : sec("notes")).length} — kept in the task file's ## Notes, agents see them too</span></summary>
      <div class="sec-bd"><${Notes} id=${id} text=${b.source ? notesSection(b.source.text ?? "") : sec("notes")} onAdded=${reload} /></div></details>
    <details class="sec"><summary><span class="caret"></span><b>History</b><span class="text-secondary small">${history.length} — newest first, notes and reasons</span></summary>
      <div class="sec-bd"><${History} entries=${history} /></div></details>
  `;
};

// ---- Activity (UI-0006) ---------------------------------------------------------
const Activity = () => {
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState("");
  const listRef = useRef(null);
  useEffect(() => {
    // dedicated stream: ?replay back-fills the daemon's event buffer so the
    // page never opens empty (the shared stream stays live-only)
    const src = new EventSource("/events?replay=200");
    src.onmessage = (e) => setEvents((ev) => [...ev.slice(-499), JSON.parse(e.data)]);
    for (const kind of ["watch", "reconcile"]) {
      src.addEventListener(kind, (e) => {
        const d = JSON.parse(e.data);
        setEvents((ev) => [...ev.slice(-499), { ts: new Date().toISOString(), machine: "-", actor: kind, action: d.kind ?? d.message ?? "notice", item: d.item ?? "" }]);
      });
    }
    return () => src.close();
  }, []);
  useEffect(() => { listRef.current?.scrollTo(0, listRef.current.scrollHeight); }, [events]);
  const f = filter.toLowerCase();
  const shown = f ? events.filter((e) => [e.machine, e.actor, e.item, e.action, e.note ?? ""].join(" ").toLowerCase().includes(f)) : events;
  return html`
    <h2 class="h4 mb-3">Activity</h2>
    <div class="mb-2">
      <input class="form-control form-control-sm w-auto" placeholder="filter machine / agent / item / action" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
    </div>
    <div class="card card-body overflow-y-auto" ref=${listRef} style=${{ maxHeight: "70vh" }}>
      ${shown.map((e, i) => html`
        <div class="evt" key=${i}>
          ${e.ts.slice(11, 19)} <span class="text-secondary">${e.machine}</span>${" "}
          <b class=${whoCls(e.actor)}>${e.actor}</b> <b>${e.action}</b> ${e.item} <span class="text-secondary">${e.from ? `${e.from}→${e.to}` : ""}</span>
          ${e.note && html` — <i>${e.note}</i>`}
        </div>
      `)}
      ${!shown.length && html`<p class="text-secondary mb-0">waiting for events…</p>`}
    </div>
  `;
};

// ---- Sync (UI-0007) ----------------------------------------------------------------
// the task folder's own git: what the other machines see after a pull
const p2 = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const PlansGit = () => {
  const [g, setG] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState(null);
  const remembered = (k) => {
    try {
      return localStorage.getItem(k) ?? "";
    } catch {
      return "";
    }
  };
  const [pullFrom, setPullFrom] = useState(() => remembered("te.sync.pull"));
  const [pushTo, setPushTo] = useState(() => remembered("te.sync.push"));
  const choose = (k, set) => (v) => {
    set(v);
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered */
    }
  };
  const load = (fetch) =>
    api(`/api/plans-git${fetch ? "?fetch=1" : ""}`)
      .then((r) => {
        setG(r);
        refreshSyncBadge(r);
      })
      .catch((e) => setNote({ kind: "danger", text: e.message }));
  useEffect(() => {
    load(true);
  }, []);
  // pre-fill the suggested message once the status knows the machine name — never overwrite typing;
  // after a commit, msg resets to "" and the box refills with a fresh timestamp
  useEffect(() => {
    if (g?.machine && !msg) setMsg(`Tasks: ${g.machine} — ${stamp(new Date())}`);
  }, [g, msg]);
  const run = async (what, path, body) => {
    setBusy(what);
    setNote(null);
    try {
      const r = await post(path, body);
      setG(r.status);
      refreshSyncBadge(r.status);
      setNote({
        kind: "success",
        text:
          what === "pull"
            ? r.pulled ? `pulled ${r.pulled} commit(s) from ${r.remote}${r.stashed ? " (stashed + restored local changes)" : ""}` : `already up to date with ${r.remote}`
            : what === "commit"
              ? r.committed ? `committed ${r.committed} change(s) locally — push when ready` : "nothing to commit"
              : what === "syncnow"
                ? `synced with ${r.remote}: ${[r.pulled ? `pulled ${r.pulled}` : "", r.committed ? `committed ${r.committed}` : "", r.pushed ? "pushed" : ""].filter(Boolean).join(", ") || "already in sync"}`
                : `${r.committed ? `committed ${r.committed} change(s), ` : ""}${r.pushed ? `pushed to ${r.remote}` : `nothing to push to ${r.remote}`}`,
      });
      if (what !== "pull") setMsg("");
    } catch (e) {
      setNote({ kind: "danger", text: e.message });
    } finally {
      setBusy("");
    }
  };
  if (!g) return html`<div class="card card-body mb-3">${note ? html`<span class="text-danger">${note.text}</span>` : "checking the task folder's git…"}</div>`;
  // a remembered choice that no longer exists falls back to the upstream's remote
  const names = g.remotes.map((r) => r.name);
  const pullR = names.includes(pullFrom) ? pullFrom : (g.defaultRemote ?? names[0] ?? "");
  const pushR = names.includes(pushTo) ? pushTo : (g.defaultRemote ?? names[0] ?? "");
  const rp = g.remotes.find((r) => r.name === pullR);
  const rs = g.remotes.find((r) => r.name === pushR);
  // scenario flags — enable only the commands that can actually succeed.
  // diverged (ahead>0 AND behind>0) can't fast-forward or push → terminal only.
  // unverified counts (fetched !== true) keep commands enabled — each action
  // re-fetches server-side, so a last-known "0" may still turn out pullable.
  const syncR = g.defaultRemote ?? g.remotes[0]?.name;
  const sd = g.remotes.find((r) => r.name === syncR);
  const diverged = (r) => Boolean(r?.ref && r.behind > 0 && r.ahead > 0);
  const pullable = Boolean(rp?.ref) && !diverged(rp) && (rp.behind > 0 || rp.fetched !== true);
  const pushable = Boolean(rs) && rs.behind === 0 && (g.changes.length > 0 || !rs.ref || rs.ahead > 0);
  const syncable = Boolean(sd?.ref) && !diverged(sd) && (sd.behind > 0 || sd.ahead > 0 || g.changes.length > 0 || sd.fetched !== true);
  const div = [rp, rs, sd].find(diverged); // the diverged remote the alert explains
  // per-direction status: pull only cares about `behind`; push about uncommitted + `ahead` (blocked while `behind`).
  // green = verified this call; ⚠ only when a fetch was tried and failed — an unasked remote stays neutral
  const okBadge = (r, text) =>
    r.fetched === true
      ? html`<span class="badge text-bg-success">${text}</span>`
      : r.fetched === false
        ? html`<span class="badge text-bg-secondary" title="remote not reachable — counts are last-known">${text} — last known</span>`
        : html`<span class="badge text-bg-secondary">${text}</span>`;
  const pullState = !rp?.ref
    ? html`<span class="small text-secondary">no ${g.branch} there</span>`
    : diverged(rp)
      ? html`<span class="badge text-bg-danger">diverged ↑${rp.ahead} ↓${rp.behind}</span>`
      : rp.behind > 0
        ? html`<span class="badge text-bg-warning">↓ ${rp.behind} to pull</span>`
        : okBadge(rp, "nothing to pull");
  const pushState = !rs?.ref
    ? html`<span class="small text-secondary">no ${g.branch} there</span>`
    : diverged(rs)
      ? html`<span class="badge text-bg-danger">diverged — terminal only</span>`
      : rs.behind > 0
        ? html`<span class="badge text-bg-warning">↓ ${rs.behind} — pull first</span>`
        : rs.ahead > 0
          ? html`<span class="badge text-bg-info">↑ ${rs.ahead} to push</span>`
          : g.changes.length
            ? null // the "N uncommitted" badge already says what needs doing
            : okBadge(rs, "nothing to push");
  const state = (r) =>
    !r.ref ? html`<span class="text-secondary">no ${g.branch} there</span>`
    : !r.ahead && !r.behind ? okBadge(r, "in sync")
    : html`${r.behind > 0 && html`<span class="badge text-bg-warning me-1">↓ ${r.behind} to pull</span>`}${r.ahead > 0 && html`<span class="badge text-bg-info">↑ ${r.ahead} to push</span>`}`;
  const remoteSelect = (value, onChange) => html`
    <select class="form-select form-select-sm w-auto" value=${value} onChange=${(e) => onChange(e.target.value)}>
      ${g.remotes.map((r) => html`<option value=${r.name}>${r.name}${r.name === g.defaultRemote ? ` (upstream of ${g.branch})` : ""}</option>`)}
    </select>`;
  return html`
    <div class="card mb-3">
      <div class="card-header py-2 d-flex align-items-center gap-2 flex-wrap">
        <b>Task folder git</b>
        <span class="badge text-bg-secondary">branch ${g.branch ?? "?"}</span>
        ${g.changes.length > 0 && html`<span class="badge text-bg-primary">${g.changes.length} uncommitted</span>`}
        ${g.remotes.length > 0 && html`<button class="btn btn-sm btn-outline-primary ms-auto py-0 px-2" disabled=${!!busy || !syncable}
          title=${!sd?.ref
            ? `${syncR} has no branch ${g.branch} — Commit & Push creates it`
            : diverged(sd)
              ? `diverged from ${syncR} — needs a terminal rebase/merge (steps below)`
              : "fetch → pull (stashing local changes) → commit the task folder → push"}
          onClick=${async () => {
            const ok = await confirmDialog(
              `sync now — ${syncR}`,
              `1. fetch + fast-forward pull${g.changes.length ? ` (stashing ${g.changes.length} local change(s) first)` : ""}\n` +
                `2. commit the task folder\n` +
                `3. push\n\n` +
                `message: ${msg.trim() || `Tasks: ${g.machine ?? "this machine"} — ${stamp(new Date())}`}`,
              { ok: "sync" },
            );
            if (ok) run("syncnow", "/api/plans-git/sync-now", { remote: syncR, message: msg });
          }}>${busy === "syncnow" ? "syncing…" : "⟳ sync now"}</button>`}
        <button class="btn btn-sm btn-link ${g.remotes.length ? "" : "ms-auto "}py-0" onClick=${() => load(true)}>check remotes</button>
      </div>
      <div class="card-body">
        <dl class="row small mb-2">
          <dt class="col-sm-3 col-lg-2">repository</dt><dd class="col-sm-9 col-lg-10 mb-1"><code>${g.repo}</code></dd>
          <dt class="col-sm-3 col-lg-2">task folder</dt><dd class="col-sm-9 col-lg-10 mb-1"><code>${g.scope === "." ? g.repo : `${g.repo}/${g.scope}`}</code>
            <span class="text-secondary">— the only path Pull / Commit & Push touch</span></dd>
        </dl>
        ${div && html`<div class="alert alert-warning small py-2 px-2 mb-2">
          <b>Diverged from ${div.name}</b> — you have ${div.ahead} local commit(s) ${div.name} doesn't, and it has ${div.behind} you don't.
          Fast-forward and push are impossible, so the buttons stay disabled until a terminal rebase/merge:
          <pre class="mb-1 mt-1 p-2 bg-body-tertiary rounded">${[
            `cd ${g.repo}`,
            ...(g.changes.length
              ? [`git stash push -u -m "wip" -- "${g.scope}"   # set uncommitted task-folder changes aside`]
              : []),
            `git pull --rebase ${div.name} ${g.branch}   # replay your commits on top of ${div.name}'s`,
            `# conflicts? edit → git add <file> → git rebase --continue   (or: git rebase --abort)`,
            ...(g.changes.length
              ? [`git stash pop   # restore the task-folder changes`]
              : []),
            `git push ${div.name} HEAD:${g.branch}`,
          ].join("\n")}</pre>
          prefer a merge? <code>git pull ${div.name} ${g.branch}</code> works too — once ${div.name}/${g.branch} is an ancestor of HEAD the buttons re-enable
        </div>`}
        ${g.remotes.length === 0 && html`<p class="small text-secondary mb-0">no remotes — add one in a terminal: git remote add origin ${"<url>"}</p>`}
        ${g.remotes.length > 0 && html`<details class="small mb-2"><summary class="text-secondary">${g.remotes.length} remote(s)</summary>
          <div class="table-responsive"><table class="table table-sm align-middle small mb-0 mt-1">
            <thead><tr><th>remote</th><th>fetch</th><th>push</th><th>${g.branch}</th></tr></thead>
            <tbody>
              ${g.remotes.map((r) => html`<tr key=${r.name}>
                <td><b>${r.name}</b>${r.name === g.defaultRemote ? html` <span class="text-secondary">(upstream of ${g.branch})</span>` : ""}${r.fetched === false ? html` <span class="text-warning" title="fetch failed — counts are last-known">⚠</span>` : ""}</td>
                <td><code class="small">${r.fetchUrl}</code></td>
                <td>${r.pushUrl === r.fetchUrl ? html`<span class="text-secondary">same</span>` : html`<code class="small">${r.pushUrl}</code>`}</td>
                <td>${state(r)}</td>
              </tr>`)}
            </tbody>
          </table></div>
        </details>`}
        <details class="small"><summary class="text-secondary">check it yourself in a terminal</summary>
          <pre class="mb-0 mt-1 p-2 bg-body-tertiary rounded">${[
            `cd ${g.repo}`,
            `git status -- ${g.scope}`,
            `git diff -- ${g.scope}`,
            `git remote -v`,
            ...g.remotes.filter((r) => r.ref).map((r) => `git log --oneline ${r.ref}..HEAD -- ${g.scope}   # to push to ${r.name}`),
            ...g.remotes.filter((r) => r.ref).map((r) => `git log --oneline HEAD..${r.ref}   # to pull from ${r.name}`),
          ].join("\n")}</pre>
        </details>
      </div>
    </div>
    ${g.remotes.length > 0 && html`
    <div class="row">
      <div class="col-md-6">
        <div class="card mb-3 h-100">
          <div class="card-header py-2 d-flex align-items-center gap-2 border-bottom border-primary border-2">
            <span class="fs-5 lh-1 text-primary">⇩</span>
            <div><b>Pull</b><div class="small text-secondary">other machines → this one</div></div>
            <div class="ms-auto d-flex align-items-center gap-1">${rp?.fetched === false && html`<span class="text-warning" title="fetch failed — counts are last-known">⚠</span>`}${pullState}</div>
          </div>
          <div class="card-body">
            <div class="d-flex gap-2 align-items-center">
              <span class="small text-secondary" style=${{ width: "3rem" }}>from</span>
              ${remoteSelect(pullR, choose("te.sync.pull", setPullFrom))}
            </div>
            <div class="small mt-1 text-break"><code class="small text-secondary">${rp?.fetchUrl ?? ""}</code></div>
            <button class="btn btn-sm btn-outline-primary w-100 mt-2" disabled=${!!busy || !pullable}
              title=${!rp?.ref
                ? `${pullR} has no branch ${g.branch} yet`
                : diverged(rp)
                  ? `diverged from ${pullR} — needs a terminal rebase/merge (steps above)`
                  : rp.behind === 0 && rp.fetched === true
                    ? `verified up to date with ${pullR}`
                    : "fetch from this remote and fast-forward — brings in the other machines' work"}
              onClick=${() => run("pull", "/api/plans-git/pull", { remote: pullR })}>${busy === "pull" ? "pulling…" : `↓ Pull${rp?.behind ? ` (${rp.behind})` : ""} from ${pullR}`}</button>
            ${g.changes.length > 0 && html`<button class="btn btn-sm btn-link w-100 py-0" disabled=${!!busy || !pullable}
              title="stash the task folder's uncommitted changes, pull, then unstash — pop conflicts keep the stash for a terminal"
              onClick=${async () => {
                const ok = await confirmDialog(
                  "stash → pull → unstash",
                  `stash ${g.changes.length} local change(s) in the task folder, pull from ${pullR}, then unstash.\n` +
                    `Conflicts on unstash stay in the worktree for a terminal — the stash is kept.`,
                  { ok: "pull" },
                );
                if (ok) run("pull", "/api/plans-git/pull", { remote: pullR, stash: true });
              }}>stash → pull → unstash</button>`}
            <div class="small text-secondary mt-2">fetch + fast-forward only — never writes to the remote</div>
          </div>
        </div>
      </div>
      <div class="col-md-6">
        <div class="card mb-3 h-100">
          <div class="card-header py-2 d-flex align-items-center gap-2 border-bottom border-success border-2">
            <span class="fs-5 lh-1 text-success">⇧</span>
            <div><b>Commit & Push</b><div class="small text-secondary">this machine → other machines</div></div>
            <div class="ms-auto d-flex align-items-center gap-1">${rs?.fetched === false && html`<span class="text-warning" title="fetch failed — counts are last-known">⚠</span>`}${g.changes.length > 0 && html`<span class="badge text-bg-primary">${g.changes.length} uncommitted</span>`}${pushState}</div>
          </div>
          <div class="card-body">
            <div class="d-flex gap-2 align-items-center">
              <span class="small text-secondary" style=${{ width: "3rem" }}>to</span>
              ${remoteSelect(pushR, choose("te.sync.push", setPushTo))}
            </div>
            <div class="small mt-1 text-break"><code class="small text-secondary">${rs?.pushUrl ?? ""}</code></div>
            <input class="form-control form-control-sm mt-2" placeholder="commit message"
              value=${msg} onInput=${(e) => setMsg(e.target.value)} />
            <div class="d-flex gap-2 mt-2">
              <button class="btn btn-sm btn-outline-success" disabled=${!!busy || !g.changes.length}
                title="commit every change in the task folder locally (no push)"
                onClick=${() => run("commit", "/api/plans-git/commit", { message: msg })}>${busy === "commit" ? "committing…" : `Commit${g.changes.length ? ` (${g.changes.length})` : ""}`}</button>
              <button class="btn btn-sm btn-success flex-grow-1" disabled=${!!busy || !pushable}
                title=${diverged(rs)
                  ? `diverged from ${pushR} — needs a terminal rebase/merge (steps above)`
                  : (rs?.behind ?? 0) > 0
                    ? `pull from ${pushR} first`
                    : !pushable && rs?.ref && !rs?.ahead && !g.changes.length
                      ? `nothing to push to ${pushR}`
                      : `commit every change in the task folder and push to ${pushR}`}
                onClick=${async () => {
                  const ok = await confirmDialog(
                    `commit & push — ${pushR}`,
                    `repository:   ${g.repo}\n` +
                      `task folder:  ${g.scope === "." ? g.repo : `${g.repo}/${g.scope}`}\n` +
                      `branch:       ${g.branch}\n` +
                      `remote:       ${pushR} → ${rs?.pushUrl ?? "?"}\n\n` +
                      `${g.changes.length ? `commit ${g.changes.length} change(s) in the task folder` : "no new changes to commit"}` +
                      `${rs?.ahead ? `, push ${rs.ahead} existing commit(s)` : ""}` +
                      `\nmessage: ${msg.trim() || `Tasks: ${g.machine ?? "this machine"} — ${stamp(new Date())}`}`,
                    { ok: "commit & push" },
                  );
                  if (ok) run("push", "/api/plans-git/push", { message: msg, remote: pushR });
                }}>${busy === "push" ? "pushing…" : `↑ Commit & Push to ${pushR}`}</button>
            </div>
            ${g.changes.length > 0 && html`<details class="mt-2"><summary class="small text-secondary">${g.changes.length} uncommitted change(s) in the task folder</summary>
              <ul class="small mb-0 overflow-y-auto" style=${{ maxHeight: "46vh" }}>${g.changes.slice(0, 200).map((c) => html`<li><code>${c.status}</code> ${c.path}</li>`)}</ul></details>`}
            <div class="small text-secondary mt-2">commits only the task folder · refuses while behind the chosen remote</div>
          </div>
        </div>
      </div>
    </div>`}
    ${note && html`<div class="alert alert-${note.kind} py-1 px-2 small mb-3">${note.text}</div>`}
    <p class="small text-secondary mb-0">Pull only fast-forwards and stays disabled while verified-up-to-date or diverged; Commit & Push stays disabled while behind — diverged history gets terminal steps above, never an automatic merge.</p>
  `;
};

// nav badge on "sync": something to pull / push (cheap local status, refreshed on events)
function refreshSyncBadge(g) {
  const a = document.querySelector('#nav a[data-r="sync"]');
  if (!a) return;
  const n = (g?.behind ?? 0) + (g?.ahead ?? 0) + (g?.changes?.length ?? 0);
  a.dataset.badge = n ? (g.behind ? `↓${g.behind}` : "●") : "";
}
// nav count on "inbox": everything waiting on the human
function refreshInboxBadge(d) {
  const a = document.querySelector('#nav a[data-r="inbox"]');
  if (!a) return;
  const n = ["questions", "drafts", "reviews", "drop_flags", "claims", "findings"].reduce((s, k) => s + (d?.[k]?.length ?? 0), 0);
  a.dataset.count = n || "";
}
const pollNavBadges = () => {
  api("/api/plans-git").then(refreshSyncBadge).catch(() => {});
  api("/api/inbox").then(refreshInboxBadge).catch(() => {});
};
setTimeout(pollNavBadges, 500);
setInterval(pollNavBadges, 60_000);
onEvent(() => {
  clearTimeout(pollNavBadges.t);
  pollNavBadges.t = setTimeout(pollNavBadges, 1500);
});

const Sync = () => {
  const { data: s } = useApi("/api/sync");
  if (!s) return html`<p class="text-secondary">loading…</p>`;
  return html`
    <h2 class="h4 mb-3">Sync</h2>
    <${PlansGit} />
    <div class="card card-body mb-2">
      plans repo: ${s.repo.remote ? html`${s.repo.ahead} ahead / ${s.repo.behind} behind <span class="text-secondary">${s.repo.upstream ?? ""}</span>` : "no remote"}
    </div>
    ${s.unsyncedClaims.length > 0 && html`<div class="alert alert-warning py-2">unsynced claims: ${s.unsyncedClaims.join(", ")}</div>`}
    <h3 class="h6 mt-3">Merged, not pushed</h3>
    <div class="list-group overflow-y-auto" style=${{ maxHeight: "46vh" }}>
      ${s.notPushed.map((d) => html`<div class="list-group-item"><span class="id">${d.item}</span> ${d.resource} <span class="text-secondary">${d.merge_commit.slice(0, 12)}</span></div>`)}
      ${!s.notPushed.length && html`<div class="list-group-item text-secondary">nothing pending</div>`}
    </div>
    <h3 class="h6 mt-3">Detected pushes</h3>
    <div class="list-group overflow-y-auto" style=${{ maxHeight: "46vh" }}>
      ${s.pushed.map((d) => html`<div class="list-group-item"><span class="id">${d.item}</span> ${d.resource} → ${d.remotes.join(", ")}</div>`)}
      ${!s.pushed.length && html`<div class="list-group-item text-secondary">none seen yet</div>`}
    </div>
  `;
};

// ---- shell ------------------------------------------------------------------------
const routes = { inbox: Inbox, board: Board, plans: Plans, graph: Graph, activity: Activity, sync: Sync, domains: Domains, archive: Archive };
const App = () => {
  const [r, setR] = useState(route());
  useEffect(() => {
    const f = () => setR(route());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const [name, itemId] = r.split("/");
  // a known route name wins even with a second segment (#/graph/<plan>) —
  // only unknown names like `item/<id>` fall through to the item page
  const View = routes[name] ?? (itemId ? ItemView : Inbox);
  useEffect(() => {
    document.querySelectorAll("#nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.r === (routes[name] ? name : "items")));
  });
  const onOpen = (id) => nav(`item/${id}`);
  return html`<${View} onOpen=${onOpen} id=${itemId} /><${DialogHost} />`;
};

document.getElementById("nav").innerHTML = Object.keys(routes)
  .map((r) => `<a href="#/${r}" data-r="${r}" class="nav-link d-flex align-items-center gap-1 small fw-medium">${r}</a>`)
  .join("");
document.getElementById("theme-toggle").onclick = () => {
  const el = document.documentElement;
  const next = el.dataset.theme === "dark" ? "light" : "dark";
  el.dataset.theme = next;
  el.dataset.bsTheme = next; // bootstrap dark/light mode
  localStorage.teTheme = next;
};
document.documentElement.dataset.theme = localStorage.teTheme ?? "light";
document.documentElement.dataset.bsTheme = localStorage.teTheme ?? "light";
render(html`<${App} />`, document.getElementById("app"));
