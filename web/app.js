import "bootstrap/dist/css/bootstrap.min.css";
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

const api = async (path, init) => {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
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
const ItemLine = ({ i, onOpen }) => html`
  <div class="d-flex align-items-baseline gap-2 flex-wrap">
    <a class="item id" onClick=${() => onOpen(i.id)}>${i.id}</a>
    <span class="badge ${ST_BADGE[i.status] ?? "text-bg-secondary"}">${i.status}</span>
    <span>${i.title}</span>
    ${i.claim && html`<span class="claim-note">held by ${i.claim.holder}@${i.claim.machine}</span> <${ClaimBadges} c=${i.claim} />`}
    ${i.blocked && html`<span class="text-secondary">blocked</span>`}
  </div>
`;

const Badge = ({ s }) => html`<span class="badge ${ST_BADGE[s] ?? "text-bg-secondary"}">${s}</span>`;

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
const Inbox = ({ onOpen }) => {
  const { data, reload } = useApi("/api/inbox");
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const act = async (id, action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => alert(e.message));
    reload();
  };
  // a cancelled prompt (null) aborts the action — only OK fires it
  const askThen = (id, action, label) => {
    const reason = prompt(label);
    if (reason !== null) act(id, action, { reason });
  };
  const AnswerBox = ({ q }) => {
    const [text, setText] = useState("");
    const opts = q.question?.options ?? [];
    return html`
      <div class="d-flex gap-2 flex-wrap align-items-center">
        <input class="form-control form-control-sm w-auto" value=${text} onInput=${(e) => setText(e.target.value)} placeholder="answer…" />
        ${opts.map((o, i) => html`<button class="btn btn-sm btn-outline-secondary" onClick=${() => act(q.id, "answer", { text: o })}>opt ${i + 1}: ${o}</button>`)}
        <button class="btn btn-sm btn-primary btn-act" onClick=${() => text && act(q.id, "answer", { text })}>answer</button>
      </div>
    `;
  };
  const Section = ({ title, tone, items, children }) =>
    items.length === 0 ? null : html`
      <div class="col-lg-6 col-xl-4">
        <div class="card">
          <div class="card-header py-2 d-flex justify-content-between">
            <b>${title}</b><span class="badge text-bg-${tone}">${items.length}</span>
          </div>
          <div class="list-group list-group-flush scroll-list">${children}</div>
        </div>
      </div>
    `;
  const empty =
    !data.questions.length && !data.drafts.length && !data.reviews.length &&
    !data.claims.length && !data.findings.length;
  return html`
    <h2 class="h4 mb-3">Inbox</h2>
    <div class="row g-3">
      <${Section} title="Questions" tone="info" items=${data.questions}>
        ${data.questions.map(
          (q) => html`
            <div class="list-group-item" key=${q.id}>
              <${ItemLine} i=${{ id: q.id, status: "waiting", title: "" }} onOpen=${onOpen} />
              <p class="my-2">${q.question?.text}</p>
              <${AnswerBox} q=${q} />
            </div>
          `,
        )}
      <//>
      <${Section} title="Drafts to approve" tone="secondary" items=${data.drafts}>
        ${data.drafts.map(
          (id) => html`
            <div class="list-group-item" key=${id}>
              <${ItemLine} i=${{ id, status: "draft", title: "" }} onOpen=${onOpen} />
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-primary btn-act" onClick=${() => act(id, "approve")}>approve</button>
                <button class="btn btn-sm btn-outline-success btn-act" onClick=${() => act(id, "complete", { note: "already done" })}>already done</button>
                <button class="btn btn-sm btn-outline-danger btn-act" onClick=${() => askThen(id, "drop", "drop reason")}>drop</button>
              </div>
            </div>
          `,
        )}
      <//>
      <${Section} title="Submissions to review" tone="success" items=${data.reviews}>
        ${data.reviews.map(
          (id) => html`
            <div class="list-group-item" key=${id}>
              <${ItemLine} i=${{ id, status: "in_review", title: "" }} onOpen=${onOpen} />
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-success btn-act" onClick=${() => act(id, "accept")}>accept (merge)</button>
                <button class="btn btn-sm btn-outline-danger btn-act" onClick=${() => askThen(id, "reject", "reject reason")}>reject</button>
              </div>
            </div>
          `,
        )}
      <//>
      <${Section} title="Conflicted claims" tone="danger" items=${data.claims}>
        ${data.claims.map(
          (c) => html`
            <div class="list-group-item" key=${c.item}>
              <span class="id">${c.item}</span> <span class="text-danger">conflicted claim</span>
              <span class="text-secondary"> ${c.holder}@${c.machine} since ${ago(c.claimed_at)}</span>
              <div class="mt-2"><button class="btn btn-sm btn-outline-primary btn-act" onClick=${() => act(c.item, "release", { note: "resolve" })}>release</button></div>
            </div>
          `,
        )}
      <//>
      <${Section} title="Findings" tone="warning" items=${data.findings}>
        ${data.findings.map(
          (f, i) => html`
            <div class="list-group-item" key=${i}>
              <span class="badge text-bg-${f.severity === "error" ? "danger" : "warning"}">${f.severity}</span>
              ${" "}
              ${f.item
                ? html`<a class="item id" onClick=${() => onOpen(f.item)}>${f.item}</a>`
                : html`<span class="id">${f.path ?? ""}</span>`}
              ${" "}
              <${LinkedText} text=${f.message} onOpen=${onOpen} />
            </div>
          `,
        )}
      <//>
    </div>
    ${empty && html`<p class="text-success mt-3">inbox zero — nothing needs you</p>`}
  `;
};

// ---- Board (UI-0004) ---------------------------------------------------------
// remembered per browser tab, so coming back from an item keeps the search
const loadSearch = () => {
  try {
    return sessionStorage.getItem("te.board.q") ?? "";
  } catch {
    return "";
  }
};
const saveSearch = (q) => {
  try {
    sessionStorage.setItem("te.board.q", q);
  } catch {
    /* storage blocked — search just isn't remembered */
  }
};
// every word must appear in id, title, project or source path
const matches = (i, words) => {
  const hay = [i.id, i.title, i.project, i.legacy_id, i.source].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
};

const Board = ({ onOpen }) => {
  const { data } = useApi("/api/items");
  const [q, setQ] = useState(loadSearch);
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? data.filter((i) => matches(i, words)) : data;
  const setSearch = (v) => {
    setQ(v);
    saveSearch(v);
  };
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
      ${words.length > 0 && html`<span class="text-secondary small">${hits.length} of ${data.length}${hits.length === 1 ? " — Enter opens it" : ""}</span>`}
    </div>
    <div class="d-flex gap-3 overflow-x-auto pb-2">
      ${STATUSES.map((s) => {
        const items = hits.filter((i) => i.status === s);
        return html`
          <div class="board-col flex-shrink-0" key=${s}>
            <h3 class="h6 text-uppercase text-secondary d-flex justify-content-between">
              <span>${s.replace("_", " ")}</span><span class="badge ${ST_BADGE[s]}">${items.length}</span>
            </h3>
            <div class="board-list">
              ${items.map(
                (i) => html`
                  <div class="card card-body mini p-2 mb-2" key=${i.id} onClick=${() => onOpen(i.id)}>
                    <div class="d-flex justify-content-between">
                      <span class="id">${i.id}</span>
                      ${i.blocked && html`<span class="badge text-bg-secondary">blocked</span>`}
                    </div>
                    <div class="small">${i.title}</div>
                    ${i.claim && html`<div class="claim-note">${i.claim.holder.split("@")[0]} · ${ago(i.claim.claimed_at)} <${ClaimBadges} c=${i.claim} /></div>`}
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

// ---- Graph (UI-0003) ----------------------------------------------------------
const Graph = ({ onOpen }) => {
  const [filter, setFilter] = useState({ status: "", project: "" });
  const [svg, setSvg] = useState("");
  const [src, setSrc] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    api(`/api/graph${q ? "?" + q : ""}`).then(async (r) => {
      setSrc(r.mermaid);
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default" });
      const { svg } = await mermaid.render("g", r.mermaid);
      setSvg(svg);
    });
  }, [filter]);
  return html`
    <h2 class="h4 mb-3">Graph</h2>
    <div class="d-flex gap-2 mb-3">
      <select class="form-select form-select-sm w-auto" onChange=${(e) => setFilter({ ...filter, status: e.target.value })}>
        <option value="">all statuses</option>
        ${STATUSES.map((s) => html`<option>${s}</option>`)}
      </select>
      <input class="form-control form-control-sm w-auto" placeholder="project" value=${filter.project} onInput=${(e) => setFilter({ ...filter, project: e.target.value })} />
    </div>
    <div class="card card-body" dangerouslySetInnerHTML=${{ __html: svg }} onClick=${(e) => {
      const id = e.target.closest?.("[id]")?.id?.match(/[A-Z]{2,}-\d+/);
      if (id) onOpen(id[0]);
    }} />
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

const History = ({ entries, onOpen }) => html`
  <div class="card mt-3">
    <div class="card-header py-2"><b>History</b> <span class="text-secondary small">newest first — notes and reasons</span></div>
    <ul class="list-group list-group-flush scroll-list">
      ${entries.length === 0 && html`<li class="list-group-item text-secondary small">no history yet</li>`}
      ${[...entries].reverse().map(
        (e, i) => html`
          <li class="list-group-item small" key=${i}>
            ${e.ts && html`<span class="text-secondary me-2" title=${e.ts}>${e.ts.slice(0, 16).replace("T", " ")} · ${ago(e.ts)} ago</span>`}
            ${e.who && html`<b class="me-1">${e.who}</b>`}
            <${LinkedText} text=${e.text} onOpen=${onOpen} />
          </li>
        `,
      )}
    </ul>
  </div>
`;

// ---- Item (UI-0005) ------------------------------------------------------------
const ItemView = ({ id, onOpen }) => {
  const { data: b, reload } = useApi(`/api/items/${id}`, [id]);
  const [picked, setTab] = useState(null);
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
  // a cancelled prompt (null) aborts the action — only OK fires it
  const askThen = (action, label) => {
    const reason = prompt(label);
    if (reason !== null) act(action, { reason });
  };
  const TABS = ["simple", "technical", "evidence"];
  const history = parseLog(sec("log"));
  const last = history.at(-1);
  return html`
    <h2 class="h4"><span class="id">${it.meta.id}</span> ${it.meta.title}</h2>
    <div class="d-flex align-items-center gap-2 mb-2">
      <${Badge} s=${it.meta.status} />
      <span class="text-secondary small">v${it.meta.version} · ${it.meta.type}${it.meta.project ? " · " + it.meta.project : ""}</span>
    </div>
    ${last && html`<div class="alert alert-light border py-1 px-2 small mb-2">
      <span class="text-secondary">latest:</span> ${last.who && html`<b>${last.who}</b> `}${last.text}${last.ts && html` <span class="text-secondary">· ${ago(last.ts)} ago</span>`}
    </div>`}
    ${it.meta.question && html`<div class="alert alert-info py-1 px-2 small mb-2"><b>question:</b> ${it.meta.question.text}</div>`}
    <div class="d-flex gap-2 mb-3 flex-wrap">
      ${it.meta.status === "draft" && html`<button class="btn btn-sm btn-primary btn-act" onClick=${() => act("approve")}>approve</button>`}
      ${it.meta.status === "hold" && html`<button class="btn btn-sm btn-primary btn-act" onClick=${() => act("unhold")}>resume</button>`}
      ${(it.meta.status === "draft" || it.meta.status === "ready") && html`<button class="btn btn-sm btn-outline-secondary btn-act" onClick=${() => askThen("hold", "hold reason (optional)")}>hold</button>`}
      ${(it.meta.status === "ready" || it.meta.status === "hold") && html`<button class="btn btn-sm btn-outline-secondary btn-act" onClick=${() => askThen("draft", "why back to draft? (optional)")}>to draft</button>`}
      ${it.meta.status === "in_review" && html`<button class="btn btn-sm btn-success btn-act" onClick=${() => act("accept")}>accept</button><button class="btn btn-sm btn-outline-danger btn-act" onClick=${() => askThen("reject", "reject reason")}>reject</button>`}
      ${it.claim && html`<button class="btn btn-sm btn-outline-primary btn-act" onClick=${() => act("release", { note: "released by human" })}>release claim</button>`}
      ${it.meta.status === "dropped" && html`<button class="btn btn-sm btn-outline-primary btn-act" onClick=${() => act("undrop")}>undrop</button>`}
      ${it.meta.status !== "done" && html`<button class="btn btn-sm btn-outline-success btn-act" onClick=${() => { const note = prompt("mark done — note (optional)"); if (note !== null) act("complete", { note }); }}>mark done</button>`}
      ${!["done", "dropped"].includes(it.meta.status) && html`<button class="btn btn-sm btn-outline-danger btn-act" onClick=${() => askThen("drop", "drop reason")}>drop</button>`}
    </div>
    <ul class="nav nav-pills nav-fill gap-1 mb-3" style=${{ maxWidth: "30rem" }}>
      ${TABS.map(
        (t) => html`
          <li class="nav-item">
            <a class="nav-link py-1 ${tab === t ? "active" : ""}" style=${{ cursor: "pointer" }} onClick=${() => setTab(t)}>${t}</a>
          </li>
        `,
      )}
    </ul>
    ${b.source && html`<div class="text-secondary small mb-2">source ${b.source.path}${b.source.missing ? " (MISSING)" : b.source.moved ? " (moved)" : ""}</div>`}
    ${tab === "simple" && html`<div class="card card-body"><pre class="mb-0">${b.source?.simple?.text ?? (sec("Simple") || "(no Simple section)")}</pre></div>`}
    ${tab === "technical" && html`
      <div class="card card-body"><pre class="mb-0">${b.source?.text ?? `${sec("Summary")}\n${sec("Acceptance")}`}</pre></div>
      ${b.targets.map((t) => html`<div class="text-secondary small">target ${t.ref} → ${t.kind}${t.path ? " " + t.path : ""}${t.host ? " " + t.host : ""}</div>`)}
      ${b.deps.map((d) => html`<div class="text-secondary small">dep ${d.ref} ${d.status}${d.outcome ? " — " + d.outcome : ""}</div>`)}
    `}
    ${tab === "evidence" && html`<div class="card card-body"><pre class="mb-0">${sec("Evidence") || "(none)"}</pre>
      ${(it.meta.deliveries ?? []).map((d) => html`<div class="text-secondary small">delivery ${d.resource} ${d.merge_commit?.slice(0, 12)} — ${d.pushed ? "pushed" : "not pushed"}</div>`)}
    </div>`}
    ${b.decisions.map((d) => html`<div class="card card-body mt-2"><b>${d.meta.id}</b> ${d.meta.title}</div>`)}
    <${History} entries=${history} onOpen=${onOpen} />
  `;
};

// ---- Activity (UI-0006) ---------------------------------------------------------
const Activity = () => {
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState("");
  const listRef = useRef(null);
  useEffect(() => {
    return onEvent((e) => {
      if (e.kind === "event") setEvents((ev) => [...ev.slice(-499), e.data]);
      else setEvents((ev) => [...ev.slice(-499), { ts: new Date().toISOString(), machine: "-", actor: e.kind, action: e.data.kind ?? e.data.message ?? "notice", item: e.data.item ?? "" }]);
    });
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
const Sync = () => {
  const { data: s } = useApi("/api/sync");
  if (!s) return html`<p class="text-secondary">loading…</p>`;
  return html`
    <h2 class="h4 mb-3">Sync</h2>
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
const routes = { inbox: Inbox, board: Board, graph: Graph, activity: Activity, sync: Sync };
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
  .map((r) => `<a class="nav-link py-1 px-3" href="#/${r}" data-r="${r}">${r}</a>`)
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
