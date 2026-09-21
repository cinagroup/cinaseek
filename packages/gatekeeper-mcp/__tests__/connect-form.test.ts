import { describe, expect, it } from "vitest";
import { connectEndpoint, connectFormHtml } from "../src/connect-form.js";

describe("personal search connect form", () => {
  it("maps a preset to its server-owned OAuth endpoint", () => {
    const form = new FormData();
    form.set("preset", "firecrawl");
    expect(connectEndpoint(form)).toBe("https://mcp.firecrawl.dev/v2/mcp-oauth");
    form.set("preset", "tavily");
    expect(connectEndpoint(form)).toBe("https://mcp.tavily.com/mcp");
    form.set("url", "https://attacker.example");
    expect(() => connectEndpoint(form)).toThrow();
  });

  it("rejects unknown or repeated selections", () => {
    const form = new FormData();
    form.set("preset", "unknown");
    expect(() => connectEndpoint(form)).toThrow();
    form.set("preset", "tavily");
    form.append("preset", "firecrawl");
    expect(() => connectEndpoint(form)).toThrow();
  });

  it("preserves the custom endpoint flow", () => {
    const form = new FormData();
    form.set("url", "https://mcp.example.com");
    expect(connectEndpoint(form)).toBe("https://mcp.example.com");
  });

  it("offers personal-account sign-in without asking for keys", () => {
    const html = connectFormHtml('/nonce?x="test"', '<script>error</script>');
    expect(html).toContain("Connect Tavily account");
    expect(html).toContain("Connect Firecrawl account");
    expect(html).toContain("team account you authorize");
    expect(html).toContain("never a fallback CinaSeek key");
    expect(html).not.toContain("<script>error</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('name="apiKey"');
  });
});
