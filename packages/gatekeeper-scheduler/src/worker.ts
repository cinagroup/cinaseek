export { ScheduleDriver } from "./schedule-driver.js";
export {
  GatekeeperVendor,
  ScheduleAccount,
  ScheduleHookController,
  ScheduleVerifier,
  SchedulerGatekeeper,
} from "./scheduler.js";

// The Scheduler is consumed through its named RPC entrypoints. Keep its default HTTP entrypoint
// explicit so the router's public gatekeeper prefix returns a health response instead of a 1101.
export default {
  async fetch(): Promise<Response> {
    return new Response("Scheduled Tasks worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
