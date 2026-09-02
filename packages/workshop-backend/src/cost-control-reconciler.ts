import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type OverseerDurableObject,
  type WorkspaceBlobObjectForCostControl,
} from "./overseer";

/**
 * Service-binding-only entrypoint for read-only workspace attachment metadata reconciliation.
 * Deployments must bind this named entrypoint explicitly; it is not routed from public `fetch`.
 */
export class CostControlReconciler extends WorkerEntrypoint<Cloudflare.Env> {
  /** Match an R2 page against one existing workspace's authoritative attachment metadata. */
  async matchWorkspaceBlobMetadata(
      workspaceId: string,
      objects: WorkspaceBlobObjectForCostControl[],
  ): Promise<string[]> {
    if (!/^[0-9a-f]{64}$/i.test(workspaceId)) throw new Error("Invalid workspace ID.");
    const namespace: DurableObjectNamespace<OverseerDurableObject> =
      this.ctx.exports.OverseerDurableObject;
    const id = namespace.idFromString(workspaceId);
    return namespace.get(id).matchWorkspaceBlobMetadataForCostControl(objects);
  }
}
