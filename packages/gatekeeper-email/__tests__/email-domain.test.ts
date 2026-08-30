import { describe, expect, it } from "vitest";

import { normalizeEmailDomain } from "../src/email-domain.js";

describe("normalizeEmailDomain", () => {
  it("normalizes a valid domain", () => {
    expect(normalizeEmailDomain(" Mail.CinaSeek.AI. ")).toBe("mail.cinaseek.ai");
  });

  it.each([
    "localhost",
    "https://mail.cinaseek.ai",
    "-mail.cinaseek.ai",
    "mail..cinaseek.ai",
  ])("rejects %s", (value) => {
    expect(() => normalizeEmailDomain(value)).toThrow(/Invalid email domain/);
  });
});
