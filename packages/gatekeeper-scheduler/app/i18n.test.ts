import { describe, expect, it } from "vitest";
import { schedulerMessageForLocale } from "./i18n";

describe("Scheduler translations", () => {
  it("renders first-party copy in simplified and traditional Chinese", () => {
    expect(schedulerMessageForLocale("zh-CN", "Scheduled tasks")).toBe("定时任务");
    expect(schedulerMessageForLocale("zh-TW", "Scheduled tasks")).toBe("排程任務");
    expect(
      schedulerMessageForLocale("zh-TW", "Every {{count}} hours", { count: 2 }),
    ).toBe("每 2 小時");
    expect(
      schedulerMessageForLocale("zh-CN", "Show why {{title}} needs attention", {
        title: "每日简报",
      }),
    ).toBe("展开 每日简报 需要处理的原因");
  });
});
