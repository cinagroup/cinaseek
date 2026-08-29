export { ScheduleDriver } from "./schedule-driver.js";
export {
  GatekeeperVendor,
  ScheduleAccount,
  ScheduleHookController,
  ScheduleVerifier,
  SchedulerGatekeeper,
} from "./scheduler.js";

/**
 * Default health endpoint for the Scheduler, whose application API is otherwise exposed through
 * named RPC entrypoints.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("Scheduled Tasks worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
