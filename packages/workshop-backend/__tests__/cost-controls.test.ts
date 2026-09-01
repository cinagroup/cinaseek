import { describe, expect, it } from "vitest";
import {
  dynamicWorkerExecutionVersion,
  resolveAgentMaxDurationMs,
  resolveAgentMaxTurns,
} from "../src/cost-controls";

describe("agent execution ceilings", () => {
  it("accepts only bounded integer turn limits", () => {
    expect(resolveAgentMaxTurns("1")).toBe(1);
    expect(resolveAgentMaxTurns("12")).toBe(12);
    expect(resolveAgentMaxTurns("30")).toBe(30);
    for (let invalid of [undefined, "", "0", "31", "1.5", "unlimited"]) {
      expect(resolveAgentMaxTurns(invalid)).toBe(30);
    }
  });

  it("accepts only wall-clock limits from one minute through one hour", () => {
    expect(resolveAgentMaxDurationMs("60000")).toBe(60_000);
    expect(resolveAgentMaxDurationMs("900000")).toBe(900_000);
    expect(resolveAgentMaxDurationMs("3600000")).toBe(3_600_000);
    for (let invalid of [undefined, "", "59999", "3600001", "60000.5", "none"]) {
      expect(resolveAgentMaxDurationMs(invalid)).toBe(1_800_000);
    }
  });
});

describe("Dynamic Worker execution identity", () => {
  it("is stable across ordinary conversation sequence changes", () => {
    let preview = {chatId: 7, generation: 3, revision: 4};
    let beforeConversation = dynamicWorkerExecutionVersion("commit-a", 2, preview);
    let afterConversation = dynamicWorkerExecutionVersion("commit-a", 2, preview);
    expect(afterConversation).toBe(beforeConversation);
    expect(beforeConversation).toBe("preview.7.3.4.r2");
  });

  it("changes only when executable code or runtime capabilities change", () => {
    expect(dynamicWorkerExecutionVersion("commit-a", 0))
        .toBe(dynamicWorkerExecutionVersion("commit-a", 0));
    expect(dynamicWorkerExecutionVersion("commit-a", 0))
        .not.toBe(dynamicWorkerExecutionVersion("commit-b", 0));
    expect(dynamicWorkerExecutionVersion("commit-a", 0))
        .not.toBe(dynamicWorkerExecutionVersion("commit-a", 1));
    expect(dynamicWorkerExecutionVersion(undefined, 0)).toBe("main.empty.r0");
  });
});
