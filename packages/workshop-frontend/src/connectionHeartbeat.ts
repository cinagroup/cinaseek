/** Interval between lightweight RPC probes while the Workshop connection should stay warm. */
export const RPC_HEARTBEAT_INTERVAL_MS = 25_000

/**
 * Start the lightweight heartbeat which keeps the top-level Public API WebSocket from entering a
 * reconnect loop during otherwise idle periods. Workspace RPC stubs have their own suspension
 * lease, so keeping this transport warm does not keep a suspended Workspace Durable Object alive.
 */
export function startRpcHeartbeat(
  probe: () => void | Promise<void>,
  intervalMs = RPC_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => void probe(), intervalMs)
  return () => clearInterval(timer)
}
