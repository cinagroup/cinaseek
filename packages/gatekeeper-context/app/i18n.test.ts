import { describe, expect, it } from "vitest";
import { contextMessageForLocale } from "./i18n";

describe("Context Library translations", () => {
  it("renders first-party copy in simplified and traditional Chinese", () => {
    expect(contextMessageForLocale("zh-CN", "Context & Skills")).toBe("上下文与技能");
    expect(contextMessageForLocale("zh-TW", "Context & Skills")).toBe("上下文與技能");
    expect(contextMessageForLocale("zh-TW", "Create collection")).toBe("建立集合");
    expect(
      contextMessageForLocale("zh-CN", "Failed to refresh: {{error}}", { error: "timeout" }),
    ).toBe("刷新失败：timeout");
    expect(
      contextMessageForLocale("zh-TW", "Failed to refresh: {{error}}", { error: "timeout" }),
    ).toBe("刷新失敗：timeout");
  });

  it("keeps unknown provider-owned text unchanged", () => {
    expect(contextMessageForLocale("zh-CN", "Customer supplied title")).toBe(
      "Customer supplied title",
    );
  });
});
