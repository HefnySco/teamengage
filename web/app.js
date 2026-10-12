import "bootstrap/dist/css/bootstrap.min.css";
import { markdownToHtml, inlineMarkdown, notesSection } from "./markdown.js";
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

const nav = (route) => (location.hash = "#/" + route);
const route = () => location.hash.replace(/^#\/?/, "") || "inbox";

// ---- shared bits ------------------------------------------------------------
const STALE_MS = 24 * 3600 * 1000;
const staleClaim = (c) => !c.conflicted && Date.now() - Date.parse(c.last_seen ?? c.claimed_at) > STALE_MS;
const ClaimBadges = ({ c }) => html`
  ${c.conflicted && html`<span class="badge text-bg-danger ms-1">conflicted</span>`}
  ${c.unsynced && html`<span class="badge text-bg-warning ms-1">unsynced</span>`}
  ${staleClaim(c) && html`<span class="badge text-bg-warning ms-1">stale</span>`}
`;
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

// bootstrap-icons glyphs, inlined (no icon font dependency)
const ArchiveIcon = () => html`
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M0 2a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1v7.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 1 12.5V5a1 1 0 0 1-1-1zm2 3v7.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V5zm13-3H1v2h14zM5 7.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5"/>
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
const STAR_BTN = { yellow: "btn-warning", red: "btn-danger", green: "btn-success", blue: "btn-primary" };
const nextStarColor = (c) => STAR_CYCLE[STAR_CYCLE.indexOf(c) + 1]; // unset → yellow; blue → undefined (unstar)

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
  const submit = () => {
    const answer = text.trim();
    if (answer && confirm(`Answer ${id ?? "this question"} with:\n\n${answer}`)) onAnswer(answer);
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
  const save = () => {
    const answer = (text ?? "").trim();
    if (!answer || answer === d.meta.title) return setText(null);
    if (confirm(`Change answer ${d.meta.id}\n\nfrom: ${d.meta.title}\nto:   ${answer}`)) {
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

// a waiting question: one row whose "answer" button expands it in place —
// full question markdown + the answer box
const QuestionRow = ({ q, item, onOpen, onAnswer }) => {
  const [open, setOpen] = useState(false);
  return html`
    <div class="triage-li">
      <span class="id-cell">
        <a class="item id" onClick=${() => onOpen(q.id)}>${q.id}</a>
        ${item?.star_color && html`<span class="${STAR_TEXT[item.star_color]}" title="starred ${item.star_color}"><${StarIcon} filled /></span>`}
      </span>
      <${InboxStatus} s="waiting" />
      <span class="t text-secondary" title=${q.question?.text}>${(q.question?.text ?? item?.title ?? "").replace(/\s+/g, " ")}</span>
      <${DomainTags} ds=${item?.domains} />
      <span class="acts">
        <button class="tbtn ${open ? "" : "primary"}" onClick=${() => setOpen(!open)}>${open ? "close" : "answer"}</button>
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
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const byId = Object.fromEntries((all ?? []).map((i) => [i.id, i]));
  const title = (id) => byId[id]?.title ?? "";
  // trailing "held by …" note for rows of claimed items
  const claimNote = (id) => {
    const c = byId[id]?.claim;
    return c ? html` <span class="text-secondary">· ${c.holder.split("@")[0]}@${c.machine} ${ago(c.claimed_at)}</span>` : null;
  };
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (id, ...extra) =>
    !words.length ||
    matches(byId[id] ?? { id }, words) ||
    words.every((w) => extra.filter(Boolean).join(" ").toLowerCase().includes(w));
  const view = {
    questions: data.questions.filter((x) => hit(x.id, x.question?.text)),
    drafts: data.drafts.filter((id) => hit(id)),
    reviews: data.reviews.filter((id) => hit(id)),
    claims: data.claims.filter((c) => hit(c.item, c.holder, c.machine)),
    findings: data.findings.filter((f) => hit(f.item, f.path, f.message, f.kind)),
  };
  const total = data.questions.length + data.drafts.length + data.reviews.length + data.claims.length + data.findings.length;
  const shown = Object.values(view).reduce((n, a) => n + a.length, 0);
  const setSearch = (v) => {
    setQ(v);
    saveSearch("te.inbox.q", v);
  };
  const act = async (id, action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => alert(e.message));
    reload();
  };
  // a cancelled prompt (null) aborts the action — only OK fires it
  const askThen = (id, action, label) => {
    const reason = prompt(label);
    if (reason !== null) act(id, action, { reason });
  };
  const empty = !total;

  // one dense line per thing that needs you; actions reveal on hover
  const idCell = (id) => html`
    <span class="id-cell">
      <a class="item id" onClick=${() => onOpen(id)}>${id}</a>
      ${byId[id]?.star_color && html`<span class="${STAR_TEXT[byId[id].star_color]}" title="starred ${byId[id].star_color}"><${StarIcon} filled /></span>`}
    </span>`;
  const itemRow = (id, st, extra, acts) => html`
    <div class="triage-li" key=${id}>
      ${idCell(id)}
      ${st}
      <span class="t" title=${title(id)}>${title(id) || "—"}${extra}</span>
      <${DomainTags} ds=${byId[id]?.domains} />
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
            <span class="acts"><button class="tbtn" onClick=${() => act(c.item, "release", { note: "resolve" })}>release</button></span>
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
          claimNote(id),
          html`<button class="tbtn primary" onClick=${() => act(id, "accept")}>accept</button>
            <button class="tbtn ghost danger" onClick=${() => askThen(id, "reject", "reject reason")}>reject</button>`,
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
            <span class="acts">${f.item && html`<button class="tbtn ghost" onClick=${() => onOpen(f.item)}>open</button>`}</span>
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
          html`<button class="tbtn primary" onClick=${() => act(id, "approve")}>approve</button>
            <button class="tbtn ghost" onClick=${() => act(id, "complete", { note: "already done" })}>done</button>
            <button class="tbtn ghost danger" onClick=${() => askThen(id, "drop", "drop reason")}>drop</button>`,
        ),
      ),
    },
  ].map((g) => ({ ...g, n: g.rows.length }));
  // when the picked group runs empty (or never had anything) fall back to all
  const effKind = groups.some((g) => g.key === kind && g.n > 0) ? kind : "all";
  const shownGroups = groups.filter((g) => g.n > 0 && (effKind === "all" || g.key === effKind));
  return html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Inbox</h2>
      <input type="search" class="form-control form-control-sm" style=${{ maxWidth: "24rem" }}
        placeholder="search id, title, project, file, text…" value=${q}
        onInput=${(e) => setSearch(e.target.value)}
        onKeyDown=${(e) => e.key === "Escape" && setSearch("")} />
      ${words.length > 0 && html`<span class="text-secondary small">${shown} of ${total}</span>`}
      ${!empty && html`
        <span class="seg ms-auto">
          <button class=${effKind === "all" ? "on" : ""} onClick=${() => setKind("all")}>All ${shown}</button>
          ${groups.map(
            (g) => g.n > 0 && html`<button key=${g.key} class=${effKind === g.key ? "on" : ""} onClick=${() => setKind(g.key)}>${g.label} ${g.n}</button>`,
          )}
        </span>`}
    </div>
    ${shownGroups.length > 0 && html`
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
// every word must appear in id, title, project or source path
const matches = (i, words) => {
  const hay = [i.id, i.title, i.project, i.legacy_id, i.source, ...(i.domains ?? []).map((d) => `#${d} ${d}`)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
};
// board card order: date = last touched (updated, else created), name = title — id breaks ties
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
const SORTS = {
  "id-asc": byId,
  "id-desc": (a, b) => byId(b, a),
  "date-desc": (a, b) => (b.updated ?? b.created ?? "").localeCompare(a.updated ?? a.created ?? "") || byId(a, b),
  "date-asc": (a, b) => (a.updated ?? a.created ?? "").localeCompare(b.updated ?? b.created ?? "") || byId(a, b),
  "name-asc": (a, b) => (a.title ?? "").localeCompare(b.title ?? "") || byId(a, b),
  "name-desc": (a, b) => (b.title ?? "").localeCompare(a.title ?? "") || byId(a, b),
};

const Board = ({ onOpen }) => {
  const { data, reload } = useApi("/api/items");
  const [q, setQ] = useState(() => loadSearch("te.board.q"));
  const [domain, setDomainState] = useState(() => loadSearch("te.board.domain"));
  const [sort, setSortState] = useState(() => loadSearch("te.board.sort"));
  const [starredOnly, setStarredOnlyState] = useState(() => loadSearch("te.board.starred") === "1");
  const [domShowAll, setDomShowAll] = useState(false);
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
        alert(`${id}: ${e.message}`);
      }
    }
    reload();
  };
  // a card's ★ flips none → yellow → red → green → blue → none — every column
  const toggleStar = async (i) => {
    const next = nextStarColor(i.star_color);
    try {
      await post(`/api/items/${i.id}/${next ? "star" : "unstar"}`, next ? { color: next } : {});
    } catch (e) {
      alert(`${i.id}: ${e.message}`);
    }
    reload();
  };
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const inDomain = domain ? data.filter((i) => (i.domains ?? []).includes(domain)) : data;
  const inStar = starredOnly ? inDomain.filter((i) => i.star_color) : inDomain;
  const hits = words.length ? inStar.filter((i) => matches(i, words)) : inStar;
  const domainCounts = {};
  for (const i of data) for (const d of i.domains ?? []) domainCounts[d] = (domainCounts[d] ?? 0) + 1;
  const untagged = data.filter((i) => !(i.domains ?? []).length).length;
  const setSearch = (v) => {
    setQ(v);
    saveSearch("te.board.q", v);
  };
  const setSort = (v) => {
    setSortState(v);
    saveSearch("te.board.sort", v);
  };
  const setStarredOnly = (v) => {
    setStarredOnlyState(v);
    saveSearch("te.board.starred", v ? "1" : "");
  };
  // id ↑↓ | date ↓↑ | AZ — clicking the active field flips its direction
  const eff = sort || "id-asc";
  const sortSeg = (field, label) => {
    const on = eff.startsWith(field);
    const desc = eff.endsWith("desc");
    const text =
      field === "name" && on ? (desc ? "Z→A" : "A→Z")
      : on ? `${label} ${desc ? "↓" : "↑"}`
      : label;
    const next = !on ? `${field}-${field === "date" ? "desc" : "asc"}` : desc ? `${field}-asc` : `${field}-desc`;
    return html`<button class=${on ? "on" : ""} title="order cards inside each column" onClick=${() => setSort(next)}>${text}</button>`;
  };
  const domEntries = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
  const domTag = ([d, n]) => html`
    <span key=${d} class="triage-tag clickable ${domain === d ? "on" : ""}" title="show only #${d} (click again to clear)"
      style=${`--c:${domainColors[d] ?? fallbackColor(d)}`} onClick=${() => setDomain(d)}><i></i>${d} <span class="n">${n}</span></span>`;
  return html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Board</h2>
      <input
        type="search"
        class="form-control form-control-sm"
        style=${{ maxWidth: "24rem" }}
        placeholder="search id, title, project, file…"
        value=${q}
        onInput=${(e) => setSearch(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Escape") setSearch("");
          if (e.key === "Enter" && hits.length === 1) onOpen(hits[0].id);
        }}
        autofocus
      />
      <span class="seg">${sortSeg("id", "id")}${sortSeg("date", "date")}${sortSeg("name", "AZ")}</span>
      <button class="tbtn ${starredOnly ? "primary" : ""}" title="show only starred" onClick=${() => setStarredOnly(!starredOnly)}><${StarIcon} filled=${starredOnly} /> starred</button>
      ${(words.length > 0 || domain || starredOnly) && html`<span class="text-secondary small">${hits.length} of ${data.length}${hits.length === 1 ? " — Enter opens it" : ""}</span>`}
    </div>
    ${domEntries.length > 0 && html`<div class="board-filters">
      <span class="lbl">Domains</span>
      ${(domShowAll ? domEntries : domEntries.slice(0, 12)).map(domTag)}
      ${!domShowAll && domEntries.length > 12 && html`<span class="triage-tag clickable" onClick=${() => setDomShowAll(true)}>+${domEntries.length - 12} more</span>`}
      <span class="faint">${untagged} untagged</span>
      ${domain && html`<button class="btn btn-sm btn-link py-0" onClick=${() => setDomain(domain)}>clear</button>`}
    </div>`}
    <div class="board-cols">
      ${STATUSES.map((s) => {
        const items = hits.filter((i) => i.status === s);
        if (SORTS[sort]) items.sort(SORTS[sort]);
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
              ${s === "done" && items.some((i) => !i.claim) && html`<button class="icon-btn x"
                title="archive every done card shown (respects the search)"
                onClick=${() => {
                  const ids = items.filter((i) => !i.claim).map((i) => i.id);
                  if (confirm(`Archive ${ids.length} done item(s)${words.length ? " matching the search" : ""}?\nThey move to the archive page and can be unarchived.`)) archive(ids);
                }}><${ArchiveIcon} /></button>`}
            </div>
            <div class="col-body">
              ${items.map(
                (i) => html`
                  <div class="bcard" key=${i.id} onClick=${() => onOpen(i.id)}>
                    <div class="bcard-top">
                      <span class="id">${i.id}${i.unblocks_on === "done" ? html` <span title="key task: dependents wait for its acceptance">🔑</span>` : ""}</span>
                      <span class="bcard-x">
                        ${s === "done" && !i.claim && html`<button class="icon-btn" title="archive"
                          onClick=${(e) => {
                            e.stopPropagation(); // don't open the item
                            archive([i.id]);
                          }}><${ArchiveIcon} /></button>`}
                        <button class="icon-btn ${i.star_color ? `on ${STAR_TEXT[i.star_color]}` : ""}"
                          title=${i.star_color ? `starred ${i.star_color} — click to flip, ends on unstar` : "star — bookmark this task"}
                          onClick=${(e) => {
                            e.stopPropagation(); // don't open the item
                            toggleStar(i);
                          }}><${StarIcon} filled=${Boolean(i.star_color)} /></button>
                      </span>
                    </div>
                    <div class="bcard-title">${i.title}</div>
                    ${((i.domains ?? []).length > 0 || i.claim || i.blocked) && html`
                      <div class="bcard-meta">
                        <${DomainTags} ds=${i.domains} onClick=${setDomain} active=${domain} />
                        ${i.blocked && html`<span>blocked</span>`}
                        ${i.claim && html`<span class="d-inline-flex align-items-center gap-1 ms-auto">
                          <span class="av" title=${`${i.claim.holder}@${i.claim.machine}`}>${(i.claim.holder[0] ?? "?").toUpperCase()}</span>
                          ${ago(i.claim.claimed_at)}
                          ${i.claim.conflicted && html`<span class="text-danger">conflict</span>`}
                          ${i.claim.unsynced && html`<span class="text-warning-emphasis">unsynced</span>`}
                          ${staleClaim(i.claim) && html`<span class="text-warning-emphasis">stale</span>`}
                        </span>`}
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
    await post(`/api/items/${id}/unarchive`).catch((e) => alert(e.message));
    reload();
  };
  return html`
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Archive</h2>
      <input type="search" class="form-control form-control-sm" style=${{ maxWidth: "24rem" }}
        placeholder="search id, title, project, file…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <span class="text-secondary small">${hits.length} of ${data.length} archived</span>
    </div>
    ${data.length === 0 && html`<p class="text-secondary">nothing archived — use "archive" on an item page</p>`}
    <div class="list-group">
      ${hits.map(
        (i) => html`
          <div class="list-group-item d-flex align-items-center gap-2 flex-wrap" key=${i.id}>
            <a class="item id" onClick=${() => onOpen(i.id)}>${i.id}</a>
            ${i.star_color && html`<span class="${STAR_TEXT[i.star_color]}" title="starred ${i.star_color}"><${StarIcon} filled /></span>`}
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
      alert(e.message);
    }
  };
  const edit = async (r, field, label) => {
    const cur = field === "keywords" ? (r.keywords ?? []).join(", ") : (r[field] ?? "");
    const v = prompt(`${label} for #${r.name}`, cur);
    if (v === null) return;
    await call("/api/domains", { name: r.name, [field]: field === "keywords" ? v.split(",").map((x) => x.trim()).filter(Boolean) : v });
  };
  const rename = async (r) => {
    const to = prompt(`Rename #${r.name} to… (an existing domain = merge into it)`, r.name);
    if (!to || to === r.name) return;
    const exists = (rows ?? []).some((x) => x.name === to.toLowerCase());
    if (exists && !confirm(`#${to} exists — merge #${r.name} (${r.count} item(s)) into it?`)) return;
    await call(`/api/domains/${encodeURIComponent(r.name)}/rename`, { to });
  };
  const del = async (r) => {
    if (!confirm(`Delete #${r.name}? It is removed from ${r.count + r.archived} item(s).`)) return;
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
    if (r) alert(`added ${r.added} tag(s) on ${r.items} item(s)`);
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
      <ul class="list-group list-group-flush scroll-list">
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
const Graph = ({ onOpen }) => {
  const domains = useDomains();
  // q / status / domain / linked, remembered per tab like the board search
  const [f, setF] = useState(() => {
    try {
      return { q: "", status: "", domain: "", linked: false, ...JSON.parse(sessionStorage.getItem("te.graph.f") ?? "{}") };
    } catch {
      return { q: "", status: "", domain: "", linked: false };
    }
  });
  const [applied, setApplied] = useState(f);
  const [svg, setSvg] = useState("");
  const [zoom, setZoom] = useState(1);
  const [src, setSrc] = useState("");
  const [count, setCount] = useState(null);
  const update = (patch) => {
    const next = { ...f, ...patch };
    setF(next);
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
  }, [applied]);
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
      <input type="search" class="form-control form-control-sm" style=${{ maxWidth: "22rem" }}
        placeholder="search id, title, project, file, #domain…" value=${f.q}
        onInput=${(e) => update({ q: e.target.value })}
        onKeyDown=${(e) => e.key === "Escape" && update({ q: "" })} />
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
      <div ref=${viewRef} class="card card-body graph-view" style=${{ "--zoom": zoom }} dangerouslySetInnerHTML=${{ __html: svg }}
        onPointerDown=${panStart} onPointerMove=${panMove} onPointerUp=${panEnd} onPointerCancel=${panEnd}
        onWheel=${wheelZoom}
        onClick=${(e) => {
          if (Date.now() < panSuppressUntil.current) return;
          // pointer capture retargets click at the view — hit-test the node actually under the pointer
          const el = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
          const id = el?.closest?.("[id]")?.id?.match(/[A-Z]{2,}[-_]\d+/);
          if (id) onOpen(id[0].replace("_", "-"));
        }} />
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

const History = ({ entries }) => html`
  <div class="card mt-3">
    <div class="card-header py-2"><b>History</b> <span class="text-secondary small">newest first — notes and reasons</span></div>
    <ul class="list-group list-group-flush scroll-list">
      ${entries.length === 0 && html`<li class="list-group-item text-secondary small">no history yet</li>`}
      ${[...entries].reverse().map(
        (e, i) => html`
          <li class="list-group-item small" key=${i}>
            ${e.ts && html`<span class="text-secondary me-2" title=${e.ts}>${e.ts.slice(0, 16).replace("T", " ")} · ${ago(e.ts)} ago</span>`}
            ${e.who && html`<b class="me-1">${e.who}</b>`}
            <span class="md-inline" dangerouslySetInnerHTML=${{ __html: inlineMarkdown(e.text) }} />
          </li>
        `,
      )}
    </ul>
  </div>
`;

// dependencies of an item: ref, live status and the dep's latest log line
const Deps = ({ deps }) => html`
  <div class="card mt-3">
    <div class="card-header py-2"><b>Dependencies</b> <span class="text-secondary small">what this task waits on</span></div>
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
              ${e.who && html`<b class="me-1">${e.who}</b>`}<span class="md-inline" dangerouslySetInnerHTML=${{ __html: inlineMarkdown(e.text) }} />
            </div>`}
          </li>
        `;
      })}
    </ul>
  </div>
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
    ? html`<div class="card card-body"><pre class="mb-0">${text}</pre></div>`
    : html`<div class="card card-body md-view" dangerouslySetInnerHTML=${{ __html: markdownToHtml(text) }} />`;

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
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`
    <div class="card mt-3">
      <div class="card-header py-2"><b>Notes</b> <span class="text-secondary small">kept in the task file's ## Notes — agents see them too</span></div>
      <div class="card-body">
        ${text
          ? html`<div class="md-view mb-3" dangerouslySetInnerHTML=${{ __html: markdownToHtml(text) }} />`
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
      alert(e.message);
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
  const sec = (n) => it.sections.find((s) => s.heading.toLowerCase() === n)?.body.trim() ?? "";
  // open on the plain-English tab only when the item has one
  const tab = picked ?? (b.source?.simple?.text || sec("simple") ? "simple" : "technical");
  const act = async (action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => alert(e.message));
    reload();
  };
  // the answer the human gave on this item (its latest decision) - changeable until the item is closed
  const ownLast = (b?.decisions ?? []).filter((d) => d.meta.item === id).map((d) => d.meta.id)
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).pop();
  // a cancelled prompt (null) aborts the action — only OK fires it
  const askThen = (action, label) => {
    const reason = prompt(label);
    if (reason !== null) act(action, { reason });
  };
  const TABS = ["simple", "technical", "evidence"];
  const history = parseLog(sec("log"));
  const last = history.at(-1);
  return html`
    <div class="item-bar d-flex align-items-center gap-2">
      <span class="id">${it.meta.id}</span>
      <${Badge} s=${it.meta.status} />
      ${it.meta.archived && html`<span class="badge text-bg-secondary">archived</span>`}
      <span class="item-bar-title text-secondary" title=${it.meta.title}>${it.meta.title}</span>
      <div class="d-flex gap-2 ms-auto flex-nowrap">
        ${it.meta.status === "draft" && html`<button class="btn btn-sm btn-primary" onClick=${() => act("approve")}>approve</button>`}
        ${it.meta.status === "hold" && html`<button class="btn btn-sm btn-primary" onClick=${() => act("unhold")}>resume</button>`}
        ${(it.meta.status === "draft" || it.meta.status === "ready") && html`<button class="btn btn-sm btn-outline-secondary" onClick=${() => askThen("hold", "hold reason (optional)")}>hold</button>`}
        ${(it.meta.status === "ready" || it.meta.status === "hold" || it.meta.status === "done") && html`<button class="btn btn-sm btn-outline-secondary" onClick=${() => askThen("draft", it.meta.status === "done" ? "reopen — why back to draft? (optional)" : "why back to draft? (optional)")}>${it.meta.status === "done" ? "reopen" : "to draft"}</button>`}
        ${it.meta.status === "in_review" && html`<button class="btn btn-sm btn-success" onClick=${() => act("accept")}>accept</button><button class="btn btn-sm btn-outline-danger" onClick=${() => askThen("reject", "reject reason")}>reject</button>`}
        ${it.claim && html`<button class="btn btn-sm btn-outline-primary" onClick=${() => act("release", { note: "released by human" })}>release claim</button>`}
        ${it.meta.status === "dropped" && html`<button class="btn btn-sm btn-outline-primary" onClick=${() => act("undrop")}>undrop</button>`}
        ${it.meta.status !== "done" && html`<button class="btn btn-sm btn-outline-success" onClick=${() => { const note = prompt("mark done — note (optional)"); if (note !== null) act("complete", { note }); }}>mark done</button>`}
        ${!["done", "dropped"].includes(it.meta.status) && html`<button class="btn btn-sm btn-outline-danger" onClick=${() => askThen("drop", "drop reason")}>drop</button>`}
        <button class="btn btn-sm ${it.meta.star_color ? STAR_BTN[it.meta.star_color] : "btn-outline-secondary"}" title=${it.meta.star_color ? `starred ${it.meta.star_color} — click to flip, ends on unstar` : "star — bookmark this task"} onClick=${() => { const next = nextStarColor(it.meta.star_color); act(next ? "star" : "unstar", next ? { color: next } : undefined); }}><${StarIcon} filled=${Boolean(it.meta.star_color)} /></button>
        ${!it.meta.archived && !it.claim && html`<button class="btn btn-sm btn-outline-secondary" onClick=${() => askThen("archive", "archive note (optional)")}>archive</button>`}
        ${it.meta.archived && html`<button class="btn btn-sm btn-primary" onClick=${() => act("unarchive")}>unarchive</button>`}
        ${!it.claim && html`<button class="btn btn-sm btn-danger" onClick=${async () => {
          const msg = `Delete ${it.meta.id} from TeamEngage?\n\nIts tracking and history entry go away. ` +
            (b.source ? `The task file ${b.source.path} stays as plain Markdown (te: line removed, path ignored).` : "");
          if (!confirm(msg)) return;
          const reason = prompt("reason (optional)");
          if (reason === null) return;
          try {
            await post(`/api/items/${id}/delete`, { reason });
            nav("board");
          } catch (e) {
            alert(e.message);
          }
        }}>delete</button>`}
      </div>
    </div>
    <div class="text-secondary small mb-2">v${it.meta.version} · ${it.meta.type}${it.meta.project ? " · " + it.meta.project : ""}</div>
    <${DomainEditor} id=${id} ds=${it.meta.domains} onChanged=${reload} />
    <div class="d-flex align-items-center gap-2 mb-2 small flex-wrap">
      <span class="text-secondary item-lbl" title="tasks depending on this may start">unblocks</span>
      <div class="btn-group btn-group-sm" role="group">
        ${[
          ["default", `default (${b.reviewUnblocks === false ? "at acceptance" : "at review"})`],
          ["review", "at review"],
          ["done", "🔑 only after acceptance"],
        ].map(
          ([v, label]) => html`<button class="btn py-0 ${(it.meta.unblocks_on ?? "default") === v ? "btn-secondary" : "btn-outline-secondary"}"
            onClick=${() => act("unblocks", { on: v })}>${label}</button>`,
        )}
      </div>
    </div>
    ${last && html`<div class="alert alert-light border py-1 px-2 small mb-2">
      <span class="text-secondary">latest:</span> ${last.who && html`<b>${last.who}</b> `}${last.text}${last.ts && html` <span class="text-secondary">· ${ago(last.ts)} ago</span>`}
    </div>`}
    ${it.meta.question && html`<div class="alert alert-info py-2 px-2 small mb-2">
      <b>question</b>${it.meta.question.asked_by ? html` <span class="text-secondary">from ${it.meta.question.asked_by}</span>` : ""}
      <div class="md-view mt-1" dangerouslySetInnerHTML=${{ __html: markdownToHtml(it.meta.question.text) }} />
      ${it.meta.status === "waiting" && html`<div class="mt-2"><${AnswerBox} id=${id} opts=${it.meta.question.options} onAnswer=${(text) => act("answer", { text })} /></div>`}
    </div>`}
    <ul class="nav nav-pills nav-fill gap-1 mb-3" style=${{ maxWidth: "30rem" }}>
      ${TABS.map(
        (t) => html`
          <li class="nav-item">
            <a class="nav-link py-1 ${tab === t ? "active" : ""}" style=${{ cursor: "pointer" }} onClick=${() => setTab(t)}>${t}</a>
          </li>
        `,
      )}
    </ul>
    <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
      ${b.source && html`<span class="text-secondary small">source ${b.source.path}${b.source.missing ? " (MISSING)" : b.source.moved ? " (moved)" : ""}</span>`}
      ${(tab === "simple" || tab === "technical") && html`<button class="btn btn-sm btn-outline-secondary py-0 ms-auto" onClick=${toggleMd}
        title="switch between formatted text and the markdown source">${mdView === "formatted" ? "show markdown" : "show formatted"}</button>`}
    </div>
    ${tab === "simple" && html`<${MdBox} view=${mdView} text=${b.source?.simple?.text ?? (sec("Simple") || "(no simple version — ask an agent: simple <id> {text})")} />`}
    ${tab === "technical" && html`
      <${MdBox} view=${mdView} text=${b.source ? (b.source.text?.trim() || "(the task file is empty)") : `${sec("Summary")}\n\n## Acceptance\n${sec("Acceptance")}`} />
      ${b.targets.map((t) => html`<div class="text-secondary small">target ${t.ref} → ${t.kind}${t.path ? " " + t.path : ""}${t.host ? " " + t.host : ""}</div>`)}
    `}
    ${tab === "evidence" && html`<div class="card card-body"><pre class="mb-0">${sec("Evidence") || "(none)"}</pre>
      ${(it.meta.deliveries ?? []).map((d) => html`<div class="text-secondary small">delivery ${d.resource} ${d.merge_commit?.slice(0, 12)} — ${d.pushed ? "pushed" : "not pushed"}</div>`)}
    </div>`}
    ${b.decisions.map((d) => html`<${DecisionCard} d=${d} canChange=${!["done", "dropped"].includes(it.meta.status) && d.meta.id === ownLast}
      onChange=${(text) => act("change_answer", { text })} />`)}
    <${Notes} id=${id} text=${b.source ? notesSection(b.source.text ?? "") : sec("notes")} onAdded=${reload} />
    ${b.deps.length > 0 && html`<${Deps} deps=${b.deps} />`}
    <${History} entries=${history} />
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
    <div class="card card-body act-log" ref=${listRef}>
      ${shown.map((e, i) => html`
        <div class="evt" key=${i}>
          ${e.ts.slice(11, 19)} <span class="text-secondary">${e.machine}</span> ${e.actor}
          <b>${e.action}</b> ${e.item} <span class="text-secondary">${e.from ? `${e.from}→${e.to}` : ""}</span>
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
    : rp.behind > 0
      ? html`<span class="badge text-bg-warning">↓ ${rp.behind} to pull</span>`
      : okBadge(rp, "nothing to pull");
  const pushState = !rs?.ref
    ? html`<span class="small text-secondary">no ${g.branch} there</span>`
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
      ${g.remotes.map((r) => html`<option value=${r.name}>${r.name}${r.name === g.defaultRemote ? " (upstream)" : ""}</option>`)}
    </select>`;
  return html`
    <div class="card mb-3">
      <div class="card-header py-2 d-flex align-items-center gap-2 flex-wrap">
        <b>Task folder git</b>
        <span class="badge text-bg-secondary">branch ${g.branch ?? "?"}</span>
        ${g.changes.length > 0 && html`<span class="badge text-bg-primary">${g.changes.length} uncommitted</span>`}
        ${g.remotes.length > 0 && html`<button class="btn btn-sm btn-outline-primary ms-auto py-0 px-2" disabled=${!!busy}
          title="fetch → pull (stashing local changes) → commit the task folder → push"
          onClick=${() => {
            const ok = confirm(
              `Sync now — ${g.defaultRemote ?? g.remotes[0]?.name}\n\n` +
                `1. fetch + fast-forward pull${g.changes.length ? ` (stashing ${g.changes.length} local change(s) first)` : ""}\n` +
                `2. commit the task folder\n` +
                `3. push\n\n` +
                `message: ${msg.trim() || `Tasks: ${g.machine ?? "this machine"} — ${stamp(new Date())}`}\n\nProceed?`,
            );
            if (ok) run("syncnow", "/api/plans-git/sync-now", { remote: g.defaultRemote, message: msg });
          }}>${busy === "syncnow" ? "syncing…" : "⟳ sync now"}</button>`}
        <button class="btn btn-sm btn-link ${g.remotes.length ? "" : "ms-auto "}py-0" onClick=${() => load(true)}>check remotes</button>
      </div>
      <div class="card-body">
        <dl class="row small mb-2">
          <dt class="col-sm-3 col-lg-2">repository</dt><dd class="col-sm-9 col-lg-10 mb-1"><code>${g.repo}</code></dd>
          <dt class="col-sm-3 col-lg-2">task folder</dt><dd class="col-sm-9 col-lg-10 mb-1"><code>${g.scope === "." ? g.repo : `${g.repo}/${g.scope}`}</code>
            <span class="text-secondary">— the only path Pull / Commit & Push touch</span></dd>
        </dl>
        ${g.remotes.length === 0 && html`<p class="small text-secondary mb-0">no remotes — add one in a terminal: git remote add origin ${"<url>"}</p>`}
        ${g.remotes.length > 0 && html`<details class="small mb-2"><summary class="text-secondary">${g.remotes.length} remote(s)</summary>
          <div class="table-responsive"><table class="table table-sm align-middle small mb-0 mt-1">
            <thead><tr><th>remote</th><th>fetch</th><th>push</th><th>${g.branch}</th></tr></thead>
            <tbody>
              ${g.remotes.map((r) => html`<tr key=${r.name}>
                <td><b>${r.name}</b>${r.name === g.defaultRemote ? html` <span class="text-secondary">(upstream)</span>` : ""}${r.fetched === false ? html` <span class="text-warning" title="fetch failed — counts are last-known">⚠</span>` : ""}</td>
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
        <div class="card mb-3 h-100 dir-pull">
          <div class="card-header py-2 d-flex align-items-center gap-2">
            <span class="dir-glyph">⇩</span>
            <div><b>Pull</b><div class="small text-secondary">other machines → this one</div></div>
            <div class="ms-auto d-flex align-items-center gap-1">${rp?.fetched === false && html`<span class="text-warning" title="fetch failed — counts are last-known">⚠</span>`}${pullState}</div>
          </div>
          <div class="card-body">
            <div class="d-flex gap-2 align-items-center">
              <span class="small text-secondary" style=${{ width: "3rem" }}>from</span>
              ${remoteSelect(pullR, choose("te.sync.pull", setPullFrom))}
            </div>
            <div class="small mt-1 text-break"><code class="small text-secondary">${rp?.fetchUrl ?? ""}</code></div>
            <button class="btn btn-sm btn-outline-primary w-100 mt-2" disabled=${!!busy}
              title="fetch from this remote and fast-forward — brings in the other machines' work"
              onClick=${() => run("pull", "/api/plans-git/pull", { remote: pullR })}>${busy === "pull" ? "pulling…" : `↓ Pull${rp?.behind ? ` (${rp.behind})` : ""} from ${pullR}`}</button>
            ${g.changes.length > 0 && html`<button class="btn btn-sm btn-link w-100 py-0" disabled=${!!busy}
              title="stash the task folder's uncommitted changes, pull, then unstash — pop conflicts keep the stash for a terminal"
              onClick=${() => {
                const ok = confirm(
                  `Stash → pull → unstash\n\n` +
                    `stash ${g.changes.length} local change(s) in the task folder, pull from ${pullR}, then unstash.\n` +
                    `Conflicts on unstash stay in the worktree for a terminal — the stash is kept.\n\nProceed?`,
                );
                if (ok) run("pull", "/api/plans-git/pull", { remote: pullR, stash: true });
              }}>stash → pull → unstash</button>`}
            <div class="dir-foot">fetch + fast-forward only — never writes to the remote</div>
          </div>
        </div>
      </div>
      <div class="col-md-6">
        <div class="card mb-3 h-100 dir-push">
          <div class="card-header py-2 d-flex align-items-center gap-2">
            <span class="dir-glyph">⇧</span>
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
              <button class="btn btn-sm btn-success flex-grow-1" disabled=${!!busy || (rs?.behind ?? 0) > 0 || (!g.changes.length && rs?.ref && !rs?.ahead)}
                title=${(rs?.behind ?? 0) > 0 ? `pull from ${pushR} first` : `commit every change in the task folder and push to ${pushR}`}
                onClick=${() => {
                  const ok = confirm(
                    `Commit & Push\n\n` +
                      `repository:   ${g.repo}\n` +
                      `task folder:  ${g.scope === "." ? g.repo : `${g.repo}/${g.scope}`}\n` +
                      `branch:       ${g.branch}\n` +
                      `remote:       ${pushR} → ${rs?.pushUrl ?? "?"}\n\n` +
                      `${g.changes.length ? `commit ${g.changes.length} change(s) in the task folder` : "no new changes to commit"}` +
                      `${rs?.ahead ? `, push ${rs.ahead} existing commit(s)` : ""}` +
                      `\nmessage: ${msg.trim() || `Tasks: ${g.machine ?? "this machine"} — ${stamp(new Date())}`}\n\nProceed?`,
                  );
                  if (ok) run("push", "/api/plans-git/push", { message: msg, remote: pushR });
                }}>${busy === "push" ? "pushing…" : `↑ Commit & Push to ${pushR}`}</button>
            </div>
            ${g.changes.length > 0 && html`<details class="mt-2"><summary class="small text-secondary">${g.changes.length} uncommitted change(s) in the task folder</summary>
              <ul class="small mb-0 scroll-list">${g.changes.slice(0, 200).map((c) => html`<li><code>${c.status}</code> ${c.path}</li>`)}</ul></details>`}
            <div class="dir-foot">commits only the task folder · refuses while behind the chosen remote</div>
          </div>
        </div>
      </div>
    </div>`}
    ${note && html`<div class="alert alert-${note.kind} py-1 px-2 small mb-3">${note.text}</div>`}
    <p class="small text-secondary mb-0">Pull only fast-forwards; Commit & Push commits only the task folder and refuses while behind the chosen remote — anything else needs a terminal.</p>
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
  const n = ["questions", "drafts", "reviews", "claims", "findings"].reduce((s, k) => s + (d?.[k]?.length ?? 0), 0);
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
    <div class="list-group scroll-list">
      ${s.notPushed.map((d) => html`<div class="list-group-item"><span class="id">${d.item}</span> ${d.resource} <span class="text-secondary">${d.merge_commit.slice(0, 12)}</span></div>`)}
      ${!s.notPushed.length && html`<div class="list-group-item text-secondary">nothing pending</div>`}
    </div>
    <h3 class="h6 mt-3">Detected pushes</h3>
    <div class="list-group scroll-list">
      ${s.pushed.map((d) => html`<div class="list-group-item"><span class="id">${d.item}</span> ${d.resource} → ${d.remotes.join(", ")}</div>`)}
      ${!s.pushed.length && html`<div class="list-group-item text-secondary">none seen yet</div>`}
    </div>
  `;
};

// ---- shell ------------------------------------------------------------------------
const routes = { inbox: Inbox, board: Board, graph: Graph, activity: Activity, sync: Sync, domains: Domains, archive: Archive };
const App = () => {
  const [r, setR] = useState(route());
  useEffect(() => {
    const f = () => setR(route());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const [name, itemId] = r.split("/");
  const View = itemId ? ItemView : (routes[name] ?? Inbox);
  useEffect(() => {
    document.querySelectorAll("#nav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.r === (itemId ? "items" : name)));
  });
  const onOpen = (id) => nav(`item/${id}`);
  return html`<${View} onOpen=${onOpen} id=${itemId} />`;
};

document.getElementById("nav").innerHTML = Object.keys(routes)
  .map((r) => `<a href="#/${r}" data-r="${r}">${r}</a>`)
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
