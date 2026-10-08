import type { LoadedWorkspace } from "../../core/config/config.js";
import type { PlansStore } from "../store/store.js";
import type { PlansWatcher } from "../watch/watch.js";
import type { SessionRegistry } from "../sessions/sessions.js";
import type { EventBus } from "../api/events.js";
import type { Links } from "../api/ops.js";

/** A workspace the daemon has loaded. */
export interface WorkspaceRuntime {
  ws: LoadedWorkspace;
  store: PlansStore;
  watcher?: PlansWatcher;
  links?: Links;
}

/** Shared daemon state passed to route registrars. */
export interface DaemonCtx {
  home: string;
  machine: string;
  workspaces: Map<string, WorkspaceRuntime>;
  sessions: SessionRegistry;
  bus: EventBus;
}
