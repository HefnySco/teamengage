import { Index } from "../../core/index/index.js";
import { resolveWorkspace } from "../../core/config/config.js";
import { parseItemRef } from "../../core/address/refs.js";
import type { Status } from "../../core/model/item.js";
import type { LoadedWorkspace } from "../../core/config/config.js";
import type { Links } from "../api/ops.js";

/**
 * Cross-workspace links (DESIGN §4.1, DM-0007): linked workspaces are loaded
 * read-only so `ws:ID` refs resolve in index, brief, graph and validator.
 * A missing linked workspace is a finding, not a crash.
 */
export class LinkedWorkspaces implements Links {
  private indexes = new Map<string, Index>();
  private missingLinks: string[] = [];

  static async load(ws: LoadedWorkspace, home?: string): Promise<LinkedWorkspaces> {
    const lw = new LinkedWorkspaces();
    for (const [name, root] of Object.entries(ws.config.links)) {
      try {
        const linked = resolveWorkspace(root, { home });
        lw.indexes.set(name, await Index.load(linked.plansDir));
      } catch {
        lw.missingLinks.push(name);
      }
    }
    return lw;
  }

  /** `ws:ID` → that item's status in the linked workspace. */
  statusOf(ref: string): Status | undefined {
    try {
      const parsed = parseItemRef(ref);
      if (!parsed.workspace) return undefined;
      return this.indexes.get(parsed.workspace)?.get(parsed.id)?.meta.status;
    } catch {
      return undefined;
    }
  }

  index(name: string): Index | undefined {
    return this.indexes.get(name);
  }

  missing(): string[] {
    return this.missingLinks;
  }
}
