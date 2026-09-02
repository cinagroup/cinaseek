import { CloudflareAlertMetricsClient } from "./cloudflare-alert-metrics.ts";

const R2_LIST_LIMIT = 1_000;
const MAX_R2_OBJECTS_PER_SCAN = 50_000;
const WORKSPACE_KEY = /^workspaces\/([0-9a-f]{64})\/chat-attachments\/([0-9a-f-]{36})$/i;

/** Minimal read-only R2 interface required by the reconciler. */
export interface WorkspaceBlobBucket {
  /** List one cursor page without reading object bodies. */
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

/** Backend service-binding contract for authoritative per-workspace metadata matching. */
export interface WorkspaceBlobMetadataService {
  /** Return the submitted object keys that match committed or non-expired staged metadata. */
  matchWorkspaceBlobMetadata(
    workspaceId: string,
    objects: Array<{ key: string; size: number }>,
  ): Promise<string[]>;
}

/** Bounded evidence from one complete R2 versus Durable Object metadata scan. */
export interface WorkspaceBlobReconciliation {
  /** Total R2 bytes without valid authoritative attachment metadata. */
  orphanBytes: number;
  /** Total bytes examined under the workspace prefix. */
  scannedBytes: number;
  /** Number of objects examined. */
  scannedObjects: number;
  /** Number of stored Overseer Durable Objects used to avoid resurrecting deleted workspaces. */
  storedWorkspaces: number;
}

function isValidObject(object: { key: string; size: number }): boolean {
  return typeof object.key === "string" && Number.isSafeInteger(object.size) && object.size >= 0;
}

/**
 * Reconcile a bounded R2 inventory without downloading bodies or instantiating deleted workspace
 * Durable Objects. Any source ambiguity throws so the alert evaluator reports insufficient data.
 */
export async function reconcileWorkspaceBlobs(
  client: CloudflareAlertMetricsClient,
  bucket: WorkspaceBlobBucket,
  service: WorkspaceBlobMetadataService,
): Promise<WorkspaceBlobReconciliation> {
  const storedWorkspaceIds = new Set(await client.queryOverseerObjectIds());
  const seenKeys = new Set<string>();
  let cursor: string | undefined;
  let scannedObjects = 0;
  let scannedBytes = 0;
  let orphanBytes = 0;

  while (true) {
    const page = await bucket.list({
      prefix: "workspaces/",
      limit: R2_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.objects) || typeof page.truncated !== "boolean" ||
        page.objects.length > R2_LIST_LIMIT) {
      throw new Error("invalid R2 workspace blob listing");
    }
    scannedObjects += page.objects.length;
    if (scannedObjects > MAX_R2_OBJECTS_PER_SCAN) {
      throw new Error("R2 workspace blob scan exceeded its safe object bound");
    }
    const groups = new Map<string, Array<{ key: string; size: number }>>();
    for (const object of page.objects) {
      if (!isValidObject(object) || seenKeys.has(object.key)) {
        throw new Error("invalid or duplicate R2 workspace blob object");
      }
      seenKeys.add(object.key);
      scannedBytes += object.size;
      const parsed = WORKSPACE_KEY.exec(object.key);
      if (!parsed) {
        orphanBytes += object.size;
        continue;
      }
      const workspaceId = parsed[1].toLowerCase();
      if (!storedWorkspaceIds.has(workspaceId)) {
        orphanBytes += object.size;
        continue;
      }
      const group = groups.get(workspaceId) ?? [];
      group.push(object);
      groups.set(workspaceId, group);
    }

    for (const [workspaceId, objects] of groups) {
      const matched = await service.matchWorkspaceBlobMetadata(workspaceId, objects);
      if (!Array.isArray(matched) || matched.length > objects.length ||
          matched.some(key => typeof key !== "string")) {
        throw new Error("invalid workspace blob metadata match response");
      }
      const candidates = new Map(objects.map(object => [object.key, object.size]));
      const uniqueMatches = new Set(matched);
      if (uniqueMatches.size !== matched.length ||
          [...uniqueMatches].some(key => !candidates.has(key))) {
        throw new Error("workspace blob metadata returned an unknown or duplicate key");
      }
      for (const [key, size] of candidates) {
        if (!uniqueMatches.has(key)) orphanBytes += size;
      }
    }

    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor || page.cursor.length > 4096) {
      throw new Error("invalid R2 workspace blob listing cursor");
    }
    cursor = page.cursor;
  }

  return {
    orphanBytes,
    scannedBytes,
    scannedObjects,
    storedWorkspaces: storedWorkspaceIds.size,
  };
}
