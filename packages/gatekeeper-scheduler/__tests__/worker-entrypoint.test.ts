import { describe, expect, it } from "vitest";

import worker from "../src/worker.js";

describe("Scheduler HTTP entrypoint", () => {
  it("returns a stable health response", async () => {
    const response = await worker.fetch();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("Scheduled Tasks worker is running.");
  });
});
