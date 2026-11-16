import type { LoadedWorkspace } from "../../core/config/config.js";
import type { PlansStore } from "../store/store.js";
import type { PlansWatcher } from "../watch/watch.js";
import type { OverlayTracker } from "../overlay/tracker.js";
import type { SessionRegistry } from "../sessions/sessions.js";
import type { Dispatcher } from "../dispatch/dispatch.js";
import type { EventBus } from "../api/events.js";
import type { Links } from "../api/ops.js";

/** A workspace the daemon has loaded. */
export interface WorkspaceRuntime {
  ws: LoadedWorkspace;
  store: PlansStore;
  watcher?: PlansWatcher;
  /** overlay mode: task-folder tracker */
  overlay?: OverlayTracker;
  links?: Links;
}

/** Shared daemon state passed to route registrars. */
export interface DaemonCtx {
  home: string;
  machine: string;
  workspaces: Map<string, WorkspaceRuntime>;
  /** GL-0367: workspaces that failed to load (name → error) — surfaced on
   * /health and /api/inbox so a bad config is visible, not silently absent */
  loadErrors?: Map<string, string>;
  sessions: SessionRegistry;
  bus: EventBus;
  /** per-workspace agent launcher (GL-0328) — absent in tests that build ctx by hand */
  dispatchers?: Map<string, Dispatcher>;
}
