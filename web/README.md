# web/ — the web UI

The browser UI the daemon serves at `/` (UI-0001). A dependency-light SPA:
**Preact + htm** (tagged templates, no JSX step), **Bootstrap 5** for styles,
**mermaid** for the graph view, bundled by **esbuild**
(`npm run build:web` → `dist/`).

- `app.js` — the whole app: auth (`?token=`/`#t=` → `te_token` cookie),
  board/inbox/graph views, SSE live updates via `/events`, calls the JSON
  API.
- `markdown.js` — renders task-file Markdown in the UI (sections, checklists,
  refs, notes).
- `index.html`, `favicon.svg`, `logo.svg` — the shell page and assets.
- `dist/` — generated bundle, do not edit (rebuilt by `npm run build:web`).

The UI is a pure client: it never writes files — every action goes through
the daemon API.
