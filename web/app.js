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

const ItemLine = ({ i, onOpen }) => html`
  <div class="d-flex align-items-baseline gap-2 flex-wrap">
    <a class="item id" onClick=${() => onOpen(i.id)}>${i.id}</a>
    <span class="badge ${ST_BADGE[i.status] ?? "text-bg-secondary"}">${i.status}</span>
    <span>${i.title}</span>
    <${DomainChips} ds=${i.domains} />
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
  // the inbox lists ids; the item list supplies titles, projects and files to search
  const { data: all } = useApi("/api/items?archived=all");
  const [q, setQ] = useState(() => loadSearch("te.inbox.q"));
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const byId = Object.fromEntries((all ?? []).map((i) => [i.id, i]));
  const title = (id) => byId[id]?.title ?? "";
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
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h2 class="h4 mb-0">Inbox</h2>
      <input type="search" class="form-control form-control-sm" style=${{ maxWidth: "24rem" }}
        placeholder="search id, title, project, file, text…" value=${q}
        onInput=${(e) => setSearch(e.target.value)}
        onKeyDown=${(e) => e.key === "Escape" && setSearch("")} />
      ${words.length > 0 && html`<span class="text-secondary small">${shown} of ${total}</span>`}
    </div>
    <div class="row g-3">
      <${Section} title="Questions" tone="info" items=${view.questions}>
        ${view.questions.map(
          (q) => html`
            <div class="list-group-item" key=${q.id}>
              <${ItemLine} i=${{ id: q.id, status: "waiting", title: title(q.id), domains: byId[q.id]?.domains }} onOpen=${onOpen} />
              <div class="my-2 md-view" dangerouslySetInnerHTML=${{ __html: markdownToHtml(q.question?.text ?? "") }} />
              <${AnswerBox} q=${q} />
            </div>
          `,
        )}
      <//>
      <${Section} title="Drafts to approve" tone="secondary" items=${view.drafts}>
        ${view.drafts.map(
          (id) => html`
            <div class="list-group-item" key=${id}>
              <${ItemLine} i=${{ id, status: "draft", title: title(id), domains: byId[id]?.domains }} onOpen=${onOpen} />
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-primary btn-act" onClick=${() => act(id, "approve")}>approve</button>
                <button class="btn btn-sm btn-outline-success btn-act" onClick=${() => act(id, "complete", { note: "already done" })}>already done</button>
                <button class="btn btn-sm btn-outline-danger btn-act" onClick=${() => askThen(id, "drop", "drop reason")}>drop</button>
              </div>
            </div>
          `,
        )}
      <//>
      <${Section} title="Submissions to review" tone="success" items=${view.reviews}>
        ${view.reviews.map(
          (id) => html`
            <div class="list-group-item" key=${id}>
              <${ItemLine} i=${{ id, status: "in_review", title: title(id), domains: byId[id]?.domains }} onOpen=${onOpen} />
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-success btn-act" onClick=${() => act(id, "accept")}>accept (merge)</button>
                <button class="btn btn-sm btn-outline-danger btn-act" onClick=${() => askThen(id, "reject", "reject reason")}>reject</button>
              </div>
            </div>
          `,
        )}
      <//>
      <${Section} title="Conflicted claims" tone="danger" items=${view.claims}>
        ${view.claims.map(
          (c) => html`
            <div class="list-group-item" key=${c.item}>
              <a class="item id" onClick=${() => onOpen(c.item)}>${c.item}</a> ${title(c.item)} <span class="text-danger">conflicted claim</span>
              <span class="text-secondary"> ${c.holder}@${c.machine} since ${ago(c.claimed_at)}</span>
              <div class="mt-2"><button class="btn btn-sm btn-outline-primary btn-act" onClick=${() => act(c.item, "release", { note: "resolve" })}>release</button></div>
            </div>
          `,
        )}
      <//>
      <${Section} title="Findings" tone="warning" items=${view.findings}>
        ${view.findings.map(
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

const Board = ({ onOpen }) => {
  const { data, reload } = useApi("/api/items");
  const [q, setQ] = useState(() => loadSearch("te.board.q"));
  const [domain, setDomainState] = useState(() => loadSearch("te.board.domain"));
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
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const inDomain = domain ? data.filter((i) => (i.domains ?? []).includes(domain)) : data;
  const hits = words.length ? inDomain.filter((i) => matches(i, words)) : inDomain;
  const domainCounts = {};
  for (const i of data) for (const d of i.domains ?? []) domainCounts[d] = (domainCounts[d] ?? 0) + 1;
  const untagged = data.filter((i) => !(i.domains ?? []).length).length;
  const setSearch = (v) => {
    setQ(v);
    saveSearch("te.board.q", v);
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
      ${(words.length > 0 || domain) && html`<span class="text-secondary small">${hits.length} of ${data.length}${hits.length === 1 ? " — Enter opens it" : ""}</span>`}
    </div>
    ${Object.keys(domainCounts).length > 0 && html`<div class="d-flex flex-wrap gap-1 mb-2 align-items-center">
      <span class="text-secondary small me-1">domains:</span>
      ${Object.entries(domainCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([d, n]) => html`<span class="badge domain-chip ${domain === d ? "active" : ""}" style=${{ background: domainColors[d] ?? fallbackColor(d) }}
          onClick=${() => setDomain(d)} title="show only #${d} (click again to clear)">#${d} <span class="opacity-75">${n}</span></span>`)}
      <span class="text-secondary small ms-1">${untagged} untagged</span>
      ${domain && html`<button class="btn btn-sm btn-link py-0" onClick=${() => setDomain(domain)}>clear</button>`}
    </div>`}
    <div class="d-flex gap-3 overflow-x-auto pb-2">
      ${STATUSES.map((s) => {
        const items = hits.filter((i) => i.status === s);
        return html`
          <div class="board-col flex-shrink-0" key=${s}>
            <h3 class="h6 text-uppercase text-secondary d-flex justify-content-between">
              <span>${s.replace("_", " ")}</span>
              <span class="d-flex align-items-center gap-1">
                ${s === "done" && items.some((i) => !i.claim) && html`<button class="btn btn-sm btn-outline-secondary py-0 px-1 board-archive-all"
                  title="archive every done card shown (respects the search)"
                  onClick=${() => {
                    const ids = items.filter((i) => !i.claim).map((i) => i.id);
                    if (confirm(`Archive ${ids.length} done item(s)${words.length ? " matching the search" : ""}?\nThey move to the archive page and can be unarchived.`)) archive(ids);
                  }}>archive all</button>`}
                <span class="badge ${ST_BADGE[s]}">${items.length}</span>
              </span>
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
                    ${(i.domains ?? []).length > 0 && html`<div class="mt-1"><${DomainChips} ds=${i.domains} onClick=${setDomain} active=${domain} /></div>`}
                    ${i.claim && html`<div class="claim-note">${i.claim.holder.split("@")[0]} · ${ago(i.claim.claimed_at)} <${ClaimBadges} c=${i.claim} /></div>`}
                    ${s === "done" && !i.claim && html`<div class="text-end mt-1">
                      <button class="btn btn-sm btn-outline-secondary py-0 px-2" title="archive"
                        onClick=${(e) => {
                          e.stopPropagation(); // don't open the item
                          archive([i.id]);
                        }}>archive</button>
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
            <button class="btn btn-sm btn-outline-secondary py-0" onClick=${() => edit(r, "color", "Colour (css, e.g. #2e7d32 — empty for automatic)")}>colour</button>
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
      <span class="text-secondary small me-1">domains</span>
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
      ${it.meta.archived && html`<span class="badge text-bg-secondary">archived</span>`}
      <span class="text-secondary small">v${it.meta.version} · ${it.meta.type}${it.meta.project ? " · " + it.meta.project : ""}</span>
    </div>
    <${DomainEditor} id=${id} ds=${it.meta.domains} onChanged=${reload} />
    ${last && html`<div class="alert alert-light border py-1 px-2 small mb-2">
      <span class="text-secondary">latest:</span> ${last.who && html`<b>${last.who}</b> `}${last.text}${last.ts && html` <span class="text-secondary">· ${ago(last.ts)} ago</span>`}
    </div>`}
    ${it.meta.question && html`<div class="alert alert-info py-2 px-2 small mb-2">
      <b>question</b>${it.meta.question.asked_by ? html` <span class="text-secondary">from ${it.meta.question.asked_by}</span>` : ""}
      <div class="md-view mt-1" dangerouslySetInnerHTML=${{ __html: markdownToHtml(it.meta.question.text) }} />
      ${(it.meta.question.options ?? []).length > 0 && html`<div class="mt-1">options: ${it.meta.question.options.map((o, i) => html`<span class="badge text-bg-secondary me-1">${i + 1}. ${o}</span>`)}</div>`}
    </div>`}
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
      ${!it.meta.archived && !it.claim && html`<button class="btn btn-sm btn-outline-secondary btn-act" onClick=${() => askThen("archive", "archive note (optional)")}>archive</button>`}
      ${it.meta.archived && html`<button class="btn btn-sm btn-primary btn-act" onClick=${() => act("unarchive")}>unarchive</button>`}
      ${!it.claim && html`<button class="btn btn-sm btn-danger btn-act" onClick=${async () => {
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
      ${b.deps.map((d) => html`<div class="text-secondary small">dep ${d.ref} ${d.status}${d.outcome ? " — " + d.outcome : ""}</div>`)}
    `}
    ${tab === "evidence" && html`<div class="card card-body"><pre class="mb-0">${sec("Evidence") || "(none)"}</pre>
      ${(it.meta.deliveries ?? []).map((d) => html`<div class="text-secondary small">delivery ${d.resource} ${d.merge_commit?.slice(0, 12)} — ${d.pushed ? "pushed" : "not pushed"}</div>`)}
    </div>`}
    ${b.decisions.map((d) => html`<div class="card card-body mt-2"><b>${d.meta.id}</b> ${d.meta.title}</div>`)}
    <${Notes} id=${id} text=${b.source ? notesSection(b.source.text ?? "") : sec("notes")} onAdded=${reload} />
    <${History} entries=${history} />
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
