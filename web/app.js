import { h, render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// ---- auth: `#t=<token>` from `te ui` → cookie, then strip from URL ---------
const hash = location.hash;
const tm = /[#&]t=([^&]+)/.exec(hash);
if (tm) {
  document.cookie = `te_token=${tm[1]}; path=/; samesite=strict`;
  location.hash = hash.replace(/[#&]t=[^&]+/, "").replace(/^#&/, "#");
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

const STATUSES = ["draft", "ready", "in_progress", "waiting", "in_review", "done", "dropped"];
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
  ${c.conflicted && html`<span class="err badge">conflicted</span>`}
  ${c.unsynced && html`<span class="warn badge">unsynced</span>`}
  ${staleClaim(c) && html`<span class="warn badge">stale</span>`}
`;
const ItemLine = ({ i, onOpen }) => html`
  <div class="row">
    <a class="item id" onClick=${() => onOpen(i.id)}>${i.id}</a>
    <span class="st st-${i.status}">${i.status}</span>
    <span>${i.title}</span>
    ${i.claim && html`<span class="claim-note">held by ${i.claim.holder}@${i.claim.machine}</span> <${ClaimBadges} c=${i.claim} />`}
    ${i.blocked && html`<span class="muted">blocked</span>`}
  </div>
`;

const Badge = ({ s }) => html`<span class="st st-${s}">${s}</span>`;

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
  if (!data) return html`<p class="muted">loading…</p>`;
  const act = async (id, action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => alert(e.message));
    reload();
  };
  const AnswerBox = ({ q }) => {
    const [text, setText] = useState("");
    const opts = q.question?.options ?? [];
    return html`
      <div class="row">
        <input value=${text} onInput=${(e) => setText(e.target.value)} placeholder="answer…" />
        ${opts.map((o, i) => html`<button onClick=${() => act(q.id, "answer", { text: o })}>opt ${i + 1}: ${o}</button>`)}
        <button class="primary" onClick=${() => text && act(q.id, "answer", { text })}>answer</button>
      </div>
    `;
  };
  return html`
    <h2>Inbox</h2>
    ${data.questions.map(
      (q) => html`
        <div class="card" key=${q.id}>
          <${ItemLine} i=${{ id: q.id, status: "waiting", title: "" }} onOpen=${onOpen} />
          <p>${q.question?.text}</p>
          <${AnswerBox} q=${q} />
        </div>
      `,
    )}
    ${data.drafts.map(
      (id) => html`
        <div class="card" key=${id}>
          <${ItemLine} i=${{ id, status: "draft", title: "" }} onOpen=${onOpen} />
          <div class="row">
            <button class="primary" onClick=${() => act(id, "approve")}>approve</button>
            <button onClick=${() => act(id, "reject", { reason: "no" })}>reject</button>
          </div>
        </div>
      `,
    )}
    ${data.reviews.map(
      (id) => html`
        <div class="card" key=${id}>
          <${ItemLine} i=${{ id, status: "in_review", title: "" }} onOpen=${onOpen} />
          <div class="row">
            <button class="primary" onClick=${() => act(id, "accept")}>accept (merge)</button>
            <button onClick=${() => {
              const reason = prompt("reject reason");
              if (reason !== null) act(id, "reject", { reason });
            }}>reject</button>
          </div>
        </div>
      `,
    )}
    ${data.claims.map(
      (c) => html`
        <div class="card" key=${c.item}>
          <span class="id">${c.item}</span> <span class="err">conflicted claim</span>
          <span class="muted"> ${c.holder}@${c.machine} since ${ago(c.claimed_at)}</span>
          <div class="row"><button onClick=${() => act(c.item, "release", { note: "resolve" })}>release</button></div>
        </div>
      `,
    )}
    ${data.findings.map(
      (f, i) => html`
        <div class="card" key=${i}>
          <span class="${f.severity === "error" ? "err" : "warn"}">${f.severity}</span>
          <span class="id"> ${f.item ?? f.path ?? ""}</span> ${f.message}
        </div>
      `,
    )}
    ${!data.questions.length && !data.drafts.length && !data.reviews.length && !data.claims.length && !data.findings.length &&
      html`<p class="ok">inbox zero — nothing needs you</p>`}
  `;
};

// ---- Board (UI-0004) ---------------------------------------------------------
const Board = ({ onOpen }) => {
  const { data } = useApi("/api/items");
  if (!data) return html`<p class="muted">loading…</p>`;
  return html`
    <h2>Board</h2>
    <div class="board">
      ${STATUSES.map((s) => {
        const items = data.filter((i) => i.status === s);
        return html`
          <div class="col" key=${s}>
            <h3>${s} (${items.length})</h3>
            ${items.map(
              (i) => html`
                <div class="card mini" key=${i.id} onClick=${() => onOpen(i.id)}>
                  <span class="id">${i.id}</span>
                  <div>${i.title}</div>
                  ${i.claim && html`<div class="claim-note">${i.claim.holder.split("@")[0]} · ${ago(i.claim.claimed_at)} <${ClaimBadges} c=${i.claim} /></div>`}
                </div>
              `,
            )}
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
    <h2>Graph</h2>
    <div class="toolbar">
      <select onChange=${(e) => setFilter({ ...filter, status: e.target.value })}>
        <option value="">all statuses</option>
        ${STATUSES.map((s) => html`<option>${s}</option>`)}
      </select>
      <input placeholder="project" value=${filter.project} onInput=${(e) => setFilter({ ...filter, project: e.target.value })} />
    </div>
    <div class="card" dangerouslySetInnerHTML=${{ __html: svg }} onClick=${(e) => {
      const id = e.target.closest?.("[id]")?.id?.match(/(WS|CR|DM|MC|CL|IM|UI|RS|SY|TE|GL)-\d+/);
      if (id) onOpen(id[0]);
    }} />
    <details><summary class="muted">mermaid source</summary><pre>${src}</pre></details>
  `;
};

// ---- Item (UI-0005) ------------------------------------------------------------
const ItemView = ({ id }) => {
  const { data: b, reload } = useApi(`/api/items/${id}`);
  const [tab, setTab] = useState("simple");
  if (!b) return html`<p class="muted">loading…</p>`;
  const it = b.item;
  const sec = (n) => it.sections.find((s) => s.heading.toLowerCase() === n)?.body.trim() ?? "";
  const act = async (action, body) => {
    await post(`/api/items/${id}/${action}`, body).catch((e) => alert(e.message));
    reload();
  };
  return html`
    <h2><span class="id">${it.meta.id}</span> ${it.meta.title}</h2>
    <div class="row"><${Badge} s=${it.meta.status} /><span class="muted">v${it.meta.version} · ${it.meta.type}${it.meta.project ? " · " + it.meta.project : ""}</span></div>
    <div class="toolbar">
      ${it.meta.status === "draft" && html`<button class="primary" onClick=${() => act("approve")}>approve</button>`}
      ${it.meta.status === "in_review" && html`<button class="primary" onClick=${() => act("accept")}>accept</button><button onClick=${() => act("reject", { reason: prompt("reason") ?? "" })}>reject</button>`}
      ${it.claim && html`<button onClick=${() => act("release", { note: "released by human" })}>release claim</button>`}
      <button onClick=${() => act("drop", { reason: prompt("drop reason") ?? "" })}>drop</button>
    </div>
    <div class="toolbar">
      <button class=${tab === "simple" ? "primary" : ""} onClick=${() => setTab("simple")}>simple</button>
      <button class=${tab === "technical" ? "primary" : ""} onClick=${() => setTab("technical")}>technical</button>
      <button class=${tab === "log" ? "primary" : ""} onClick=${() => setTab("log")}>log</button>
      <button class=${tab === "evidence" ? "primary" : ""} onClick=${() => setTab("evidence")}>evidence</button>
    </div>
    ${tab === "simple" && html`<div class="card"><pre>${sec("Simple") || "(no Simple section)"}</pre></div>`}
    ${tab === "technical" && html`
      <div class="card"><pre>${sec("Summary")}\n${sec("Acceptance")}</pre></div>
      ${b.targets.map((t) => html`<div class="muted">target ${t.ref} → ${t.kind}${t.path ? " " + t.path : ""}${t.host ? " " + t.host : ""}</div>`)}
      ${b.deps.map((d) => html`<div class="muted">dep ${d.ref} ${d.status}${d.outcome ? " — " + d.outcome : ""}</div>`)}
    `}
    ${tab === "log" && html`<div class="card"><pre>${sec("Log") || "(empty)"}</pre></div>`}
    ${tab === "evidence" && html`<div class="card"><pre>${sec("Evidence") || "(none)"}</pre>
      ${(it.meta.deliveries ?? []).map((d) => html`<div class="muted">delivery ${d.resource} ${d.merge_commit?.slice(0, 12)} — ${d.pushed ? "pushed" : "not pushed"}</div>`)}
    </div>`}
    ${b.decisions.map((d) => html`<div class="card"><b>${d.meta.id}</b> ${d.meta.title}</div>`)}
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
  const shown = f ? events.filter((e) => [e.machine, e.actor, e.item, e.action].join(" ").toLowerCase().includes(f)) : events;
  return html`
    <h2>Activity</h2>
    <div class="toolbar">
      <input placeholder="filter machine / agent / item / action" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
    </div>
    <div class="card" ref=${listRef} style=${{ maxHeight: "70vh", overflowY: "auto" }}>
      ${shown.map((e, i) => html`
        <div class="evt" key=${i}>
          ${e.ts.slice(11, 19)} <span class="muted">${e.machine}</span> ${e.actor}
          <b>${e.action}</b> ${e.item} <span class="muted">${e.from ? `${e.from}→${e.to}` : ""}</span>
        </div>
      `)}
      ${!shown.length && html`<p class="muted">waiting for events…</p>`}
    </div>
  `;
};

// ---- Sync (UI-0007) ----------------------------------------------------------------
const Sync = () => {
  const { data: s } = useApi("/api/sync");
  if (!s) return html`<p class="muted">loading…</p>`;
  return html`
    <h2>Sync</h2>
    <div class="card">
      plans repo: ${s.repo.remote ? html`${s.repo.ahead} ahead / ${s.repo.behind} behind <span class="muted">${s.repo.upstream ?? ""}</span>` : "no remote"}
    </div>
    ${s.unsyncedClaims.length > 0 && html`<div class="card warn">unsynced claims: ${s.unsyncedClaims.join(", ")}</div>`}
    <h3>Merged, not pushed</h3>
    ${s.notPushed.map((d) => html`<div class="card"><span class="id">${d.item}</span> ${d.resource} <span class="muted">${d.merge_commit.slice(0, 12)}</span></div>`)}
    ${!s.notPushed.length && html`<p class="muted">nothing pending</p>`}
    <h3>Detected pushes</h3>
    ${s.pushed.map((d) => html`<div class="card"><span class="id">${d.item}</span> ${d.resource} → ${d.remotes.join(", ")}</div>`)}
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
  .map((r) => `<a href="#/${r}" data-r="${r}">${r}</a>`)
  .join("");
document.getElementById("theme-toggle").onclick = () => {
  const el = document.documentElement;
  el.dataset.theme = el.dataset.theme === "dark" ? "light" : "dark";
  localStorage.teTheme = el.dataset.theme;
};
document.documentElement.dataset.theme = localStorage.teTheme ?? "light";
render(html`<${App} />`, document.getElementById("app"));
