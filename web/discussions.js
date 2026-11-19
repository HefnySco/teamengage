import { useState, useEffect, useMemo } from "preact/hooks";
import { html, api, post, useApi, nav } from "./app.js";
import { toast, confirmDialog } from "./dialogs.js";
import { markdownToHtml } from "./markdown.js";

/**
 * Discussions page (TE-0159): list → view → transcript reader → paste form.
 * A discussion is a saved chat — a source document, never claimed. The
 * distilled DISC file renders as cards; the raw transcript pages ~200
 * lines at a time with tool calls folded. Kept in its own module so it
 * can move to the shared kernel later.
 */

const STATE_BADGE = {
  draft: "text-bg-secondary",
  unplanned: "text-bg-secondary",
  planned: "text-bg-info",
  in_progress: "text-bg-warning",
  done: "text-bg-success",
  dropped: "text-bg-dark",
};

const StateChip = ({ st }) =>
  html`<span class=${`badge ${STATE_BADGE[st] ?? "text-bg-secondary"}`}>${st ?? "?"}</span>`;

/** `## ` sections of a DISC/markdown file → [{heading, body}] in document order. */
const sectionsOf = (text) => {
  const body = (text ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const out = [];
  for (const line of body.split("\n")) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) out.push({ heading: m[1].trim(), body: [] });
    else if (out.length) out.at(-1).body.push(line);
  }
  return out.map((s) => ({ ...s, body: s.body.join("\n").trim() }));
};

/** `## Participants` → the `- name` lines. */
const participantsOf = (text) =>
  (sectionsOf(text).find((s) => /^participants$/i.test(s.heading))?.body ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

// ---- transcript reader: ## user/assistant turn headers, ### tool blocks folded
// a ## inside a fenced code block is code, not a turn header
const transcriptBlocks = (text) => {
  const blocks = [];
  let fence = null;
  for (const line of (text ?? "").split("\n")) {
    let m;
    const f = /^(```|~~~)/.exec(line.trim());
    if (f) {
      if (fence === null) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      blocks.at(-1)?.body.push(line);
      continue;
    }
    if (fence) {
      blocks.at(-1)?.body.push(line);
      continue;
    }
    if ((m = /^##\s+(.+)$/.exec(line))) blocks.push({ kind: "turn", head: m[1], body: [] });
    else if ((m = /^###\s+(.+)$/.exec(line))) blocks.push({ kind: "tool", head: m[1], body: [] });
    else if (blocks.length) blocks.at(-1).body.push(line);
  }
  return blocks.map((b) => ({ ...b, body: b.body.join("\n").trim() }));
};

const TranscriptReader = ({ id }) => {
  const [page, setPage] = useState(1);
  const { data: t, err } = useApi(`/api/discussions/${id}/transcript?page=${page}`, [id, page]);
  if (err) return html`<p class="small text-secondary">no transcript saved yet</p>`;
  if (!t) return html`<p class="text-secondary">loading…</p>`;
  const blocks = transcriptBlocks(t.text);
  return html`
    <div class="card mt-3">
      <div class="card-header d-flex align-items-center gap-2 py-2">
        <span class="fw-semibold">transcript</span>
        <span class="small text-secondary">${t.path}</span>
        <span class="ms-auto small text-secondary">page ${t.page}/${t.pages} · ${t.total} lines</span>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-secondary" disabled=${t.page <= 1} onClick=${() => setPage(t.page - 1)}>‹</button>
          <button class="btn btn-outline-secondary" disabled=${t.page >= t.pages} onClick=${() => setPage(t.page + 1)}>›</button>
        </div>
      </div>
      <div class="card-body small disc-transcript">
        ${blocks.map((b, i) =>
          b.kind === "turn"
            ? html`<div key=${i} class="disc-turn mb-3">
                <div class=${`disc-turn-head ${/^assistant/i.test(b.head) ? "disc-assistant" : "disc-user"}`}>${b.head}</div>
                ${b.body && html`<div class="mt-1 md-view" dangerouslySetInnerHTML=${{ __html: markdownToHtml(b.body) }} />`}
              </div>`
            : html`<details key=${i} class="disc-tool ms-3 mb-2">
                <summary class="text-secondary">${b.head}</summary>
                <pre class="small mt-1 mb-0 disc-tool-body">${b.body}</pre>
              </details>`,
        )}
        ${!blocks.length && html`<div class="small md-view" dangerouslySetInnerHTML=${{ __html: markdownToHtml(t.text) }} />`}
      </div>
    </div>`;
};

// ---- one discussion: distilled cards, referenced-by, transcript -------------
const DiscussionView = ({ id }) => {
  const { data: b, err } = useApi(`/api/items/${id}`, [id]);
  if (err) return html`<p class="text-danger">${String(err.message ?? err)}</p>`;
  if (!b) return html`<p class="text-secondary">loading…</p>`;
  const it = b.item;
  const sections = sectionsOf(b.source && !("missing" in b.source) ? b.source.text : "");
  const shown = sections.filter((s) => s.body || !/^artifacts$/i.test(s.heading));
  return html`
    <div>
      <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <a href="#/discussions" class="btn btn-sm btn-outline-secondary">‹ discussions</a>
        <span class="id">${it.meta.id}</span>
        <${StateChip} st=${it.idea_state} />
        <h2 class="h5 mb-0">${it.meta.title}</h2>
        ${(it.meta.domains ?? []).map((d) => html`<span key=${d} class="badge text-bg-light">#${d}</span>`)}
      </div>
      ${b.source && !("missing" in b.source) && html`<div class="small text-secondary mb-3">${b.source.path}</div>`}
      ${(b.referenced_by ?? []).length > 0 && html`
        <div class="mb-3 small">
          referenced by:
          ${b.referenced_by.map((r) => {
            const iid = r.ref.split(":").pop();
            return html` <a key=${r.ref} class="item id" onClick=${() => nav(`item/${iid}`)}>${iid}</a> <span class="text-secondary">(${r.status})</span>`;
          })}
        </div>`}
      <div class="row g-3">
        ${shown.map((s) => html`
          <div key=${s.heading} class=${/^summary$/i.test(s.heading) ? "col-12" : "col-md-6 col-xl-4"}>
            <div class="card h-100">
              <div class="card-header py-2 small fw-semibold">${s.heading}</div>
              <div class="card-body py-2 small disc-section" dangerouslySetInnerHTML=${{ __html: markdownToHtml(s.body || "—") }} />
            </div>
          </div>`)}
      </div>
      <${TranscriptReader} id=${id} />
    </div>`;
};

// ---- paste / upload a chat → capture ----------------------------------------
const CaptureForm = ({ projects, onSaved }) => {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState(projects[0] ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState(null);
  const pickFile = (e) => {
    const f = e.target.files?.[0];
    if (f) f.text().then(setText);
  };
  const save = async (extra = {}) => {
    setBusy(true);
    try {
      const r = await post("/api/discussions", {
        title: title.trim(),
        project: project || undefined,
        transcript_text: text,
        ...extra,
      });
      toast(`saved ${r.id}`, "success");
      onSaved(r.id);
    } catch (e) {
      const msg = String(e.message ?? e);
      // the daemon refuses and names the hit lines — show them before saving
      if (/secret-looking/.test(msg)) setHits(msg.replace(/^\d+ /, ""));
      else toast(msg);
    } finally {
      setBusy(false);
    }
  };
  return html`
    <div class="card mb-3">
      <div class="card-header py-2 small fw-semibold">save a chat as a discussion</div>
      <div class="card-body">
        <div class="row g-2 mb-2">
          <div class="col-md-8">
            <input class="form-control form-control-sm" placeholder="title — what the chat was about" value=${title}
              onInput=${(e) => setTitle(e.target.value)} />
          </div>
          <div class="col-md-4">
            <select class="form-select form-select-sm" value=${project} onChange=${(e) => setProject(e.target.value)}>
              ${projects.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}
            </select>
          </div>
        </div>
        <textarea class="form-control form-control-sm font-monospace" rows="8"
          placeholder="paste the chat — plain text, Markdown, or a Claude Code JSONL export"
          value=${text} onInput=${(e) => setText(e.target.value)} />
        <div class="d-flex align-items-center gap-2 mt-2 flex-wrap">
          <label class="btn btn-sm btn-outline-secondary mb-0">
            or pick a file…<input type="file" class="d-none" onChange=${pickFile} />
          </label>
          <button class="btn btn-sm btn-warning" disabled=${busy || !title.trim() || !text.trim()}
            title="scan for secrets, then write DISC-NN-<slug>.md and the transcript sidecar"
            onClick=${() => save()}>save discussion</button>
          <span class="small text-secondary">the transcript goes into the plans git repo</span>
        </div>
        ${hits && html`
          <div class="alert alert-warning small mt-3 mb-0">
            <div class="fw-semibold mb-1">secret scan found hits — nothing was saved</div>
            <pre class="small mb-2" style=${{ whiteSpace: "pre-wrap" }}>${hits}</pre>
            <div class="d-flex gap-2 flex-wrap">
              <button class="btn btn-sm btn-outline-danger" disabled=${busy}
                title="mask every hit as [REDACTED], then save"
                onClick=${async () => { if (await confirmDialog("save with [REDACTED] in place of each hit?", hits, { ok: "redact & save" })) save({ redact: true }); }}>redact &amp; save</button>
              <button class="btn btn-sm btn-outline-secondary" disabled=${busy}
                title="keep the text and tag the transcript artifact !sensitive"
                onClick=${async () => { if (await confirmDialog("keep the secrets and mark the transcript !sensitive?", "the text stays readable in the plans git repo", { ok: "save anyway" })) save({ sensitive: true }); }}>keep &amp; mark sensitive</button>
              <button class="btn btn-sm btn-link" onClick=${() => setHits(null)}>dismiss</button>
            </div>
          </div>`}
      </div>
    </div>`;
};

// ---- the list ----------------------------------------------------------------
const DiscussionsList = ({ onSaved }) => {
  const { data } = useApi("/api/items?type=discussion");
  const { data: ws } = useApi("/api/workspace");
  const [q, setQ] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [parts, setParts] = useState({}); // id → participants[]
  const items = useMemo(() => data ?? [], [data]);
  useEffect(() => {
    // participants live in the DISC file — one brief fetch per discussion
    let live = true;
    Promise.all(
      items.map((i) =>
        api(`/api/items/${i.id}`)
          .then((b) => [i.id, participantsOf(b.source && !("missing" in b.source) ? b.source.text : "")])
          .catch(() => [i.id, []]),
      ),
    ).then((rows) => live && setParts(Object.fromEntries(rows)));
    return () => {
      live = false;
    };
  }, [items]);
  if (!data) return html`<p class="text-secondary">loading…</p>`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = items
    .filter((i) => words.every((w) => `${i.id} ${i.title}`.toLowerCase().includes(w)))
    .sort((a, b) => (b.updated ?? b.created ?? "").localeCompare(a.updated ?? a.created ?? ""));
  const projects = (ws?.projects ?? []).map((p) => p.name);
  return html`
    <div>
      <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
        <h2 class="h4 mb-0">Discussions</h2>
        <button class="btn btn-sm btn-outline-warning" title="paste or upload a chat — secret-scanned, then saved as a source document"
          onClick=${() => setCapturing(!capturing)}>save a chat</button>
        <input class="form-control form-control-sm" style=${{ maxWidth: "22rem" }}
          placeholder="filter by title words…" value=${q} onInput=${(e) => setQ(e.target.value)} />
        <span class="ms-auto small text-secondary">${rows.length} of ${items.length}</span>
      </div>
      ${capturing && html`<${CaptureForm} projects=${projects} onSaved=${(id) => { setCapturing(false); onSaved(id); }} />`}
      ${rows.length === 0 && html`<p class="text-secondary">no discussions — save a chat above, or an agent can call <code>capture</code></p>`}
      ${rows.map((i) => html`
        <div key=${i.id} class="d-flex align-items-center gap-2 py-2 border-bottom flex-wrap disc-row"
          style=${{ cursor: "pointer" }} onClick=${() => nav(`discussions/${i.id}`)}>
          <span class="id text-nowrap">${i.id}</span>
          <${StateChip} st=${i.idea_state} />
          <span class="fw-semibold">${i.title}</span>
          ${(parts[i.id] ?? []).map((p) => html`<span key=${p} class="badge text-bg-light">${p}</span>`)}
          <span class="ms-auto d-flex align-items-center gap-3 small text-secondary">
            <span title="items that name this discussion in relates">${(i.idea_refs ?? []).length} related</span>
            <span>${(i.updated ?? i.created ?? "").slice(0, 10)}</span>
          </span>
        </div>`)}
    </div>`;
};

/** route: #/discussions → list; #/discussions/<id> → the discussion view. */
export const Discussions = ({ id }) =>
  id
    ? html`<${DiscussionView} id=${id} />`
    : html`<${DiscussionsList} onSaved=${(newId) => nav(`discussions/${newId}`)} />`;
