import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { PERSONAL_SEARCH_PROVIDERS } from "../packages/workshop-shared/src/search-providers.ts";

const root = new URL("../packages/workshop-backend/connector-blueprints/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const source = await readFile(new URL("search-server.js", root), "utf8");
const client = await readFile(new URL("search-client.js", root), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeGadget(config, callTool) {
  class Base {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  }
  const context = vm.createContext({ DurableObject: Base, WorkerEntrypoint: Base, URL });
  const Gadget = vm.runInContext(source.replace(/^import .*;\r?\n/, "")
    .replaceAll("export class", "class")
    .replace("__CONNECTOR_CONFIG__", JSON.stringify(config)) + "\nGadget", context);
  return new Gadget({}, { [config.binding.name]: callTool ? { callTool } : undefined });
}

for (const provider of PERSONAL_SEARCH_PROVIDERS) {
  const config = manifest.find(entry => entry.connector === provider.id);
  test(`${provider.name}: metadata requires personal MCP search scope`, () => {
    assert.equal(config.title, `${provider.name} Search`);
    assert.equal(config.binding.gatekeeperName, "mcp");
    assert.equal(config.binding.typeUrlPattern, "https://*");
    assert.equal(config.binding.resourceUrl, `${provider.endpoint}#tool=${provider.tool}`);
    assert.notEqual(config.blueprintId, "integration.mcp");
  });
  const payload = provider.id === "tavily" ? { results: [{ title: "Result", url: "https://example.com", content: "Found" }] }
    : { success: true, data: { web: [{ title: "Result", url: "https://example.com", description: "Found" }] }, creditsUsed: 2 };
  test(`${provider.name}: one explicit bounded call and honest credit reporting`, async () => {
    const calls = [];
    const gadget = makeGadget(config, async (...args) => { calls.push(args); return { status: "ok", text: JSON.stringify(payload) }; });
    await gadget.getConfig();
    assert.equal(calls.length, 0);
    const result = await gadget.search(" test ", 5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], provider.tool);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), provider.id === "tavily"
      ? { query: "test", max_results: 5, search_depth: "basic" } : { query: "test", limit: 5 });
    assert.equal(result.rows[0].description, "Found");
    assert.equal(result.creditsUsed, provider.id === "tavily" ? null : 2);
  });
  test(`${provider.name}: invalid inputs and missing account make no paid calls`, async () => {
    let calls = 0;
    const gadget = makeGadget(config, async () => { calls++; });
    for (const [query, limit] of [["", 5], ["x".repeat(2001), 5], ["x", 0], ["x", 11], ["x", 1.5], ["x", "5"]]) {
      await assert.rejects(gadget.search(query, limit));
    }
    await assert.rejects(makeGadget(config).search("test", 5), /Connect your personal account/);
    assert.equal(calls, 0);
  });
  test(`${provider.name}: failures never retry and release the in-flight guard`, async () => {
    let calls = 0;
    const gadget = makeGadget(config, async () => { calls++; throw new Error("provider timeout"); });
    await assert.rejects(gadget.search("test", 5), /timeout/);
    assert.equal(calls, 1);
    await assert.rejects(gadget.search("new explicit request", 5), /timeout/);
    assert.equal(calls, 2);
  });
  test(`${provider.name}: duplicate in-flight submission is refused`, async () => {
    let finish;
    let calls = 0;
    const gadget = makeGadget(config, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const running = gadget.search("test", 5);
    await assert.rejects(gadget.search("test", 5), /already running/);
    finish({ status: "ok", structuredContent: payload });
    await running;
    assert.equal(calls, 1);
  });
  test(`${provider.name}: error, pending, and malformed results are not success`, async () => {
    for (const response of [{ status: "pending" }, { status: "ok", isError: true },
      { status: "ok", text: "not json" }, { status: "ok", structuredContent: { success: false } },
      { status: "ok", text: "{}" }]) {
      await assert.rejects(makeGadget(config, async () => response).search("test", 5));
    }
  });
  test(`${provider.name}: UI never auto-searches, disables duplicates and renders text safely`, async () => {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { runScripts: "outside-only", url: "https://sandbox.example/" });
    let calls = 0;
    let finish;
    dom.window.gadget = {
      getConfig: async () => ({ title: config.title, logoUrl: "data:image/svg+xml,", minResults: provider.id === "tavily" ? 5 : 1 }),
      search: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    };
    try {
      dom.window.eval(client);
      await tick();
      assert.equal(calls, 0);
      assert.equal(dom.window.document.title, config.title);
      const form = dom.window.document.querySelector("form");
      form.elements.query.value = "test";
      form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      assert.equal(calls, 1);
      assert.equal(form.querySelector("button").disabled, true);
      finish({ rows: [{ title: "<img onerror=alert(1)>", description: "<script>bad()</script>", url: "https://example.com" }], creditsUsed: null });
      await tick();
      assert.equal(form.querySelector("button").disabled, false);
      assert.equal(dom.window.document.querySelectorAll("article img, article script").length, 0);
      assert.match(dom.window.document.querySelector("#status").textContent, /did not report/);
      assert.equal(calls, 1);
    } finally { dom.window.close(); }
  });
}

test("search normalization bounds result size and refuses unsafe links", async () => {
  const config = manifest.find(entry => entry.connector === "firecrawl");
  const gadget = makeGadget(config, async () => ({ status: "ok", structuredContent: {
    data: { web: [{ url: "javascript:alert(1)", title: "x".repeat(400), description: "y".repeat(4000) }, { url: "https://user:pass@example.com" }] },
    creditsUsed: -1,
  } }));
  const result = await gadget.search("test", 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].url, "");
  assert.equal(result.rows[0].title.length, 300);
  assert.equal(result.rows[0].description.length, 3000);
  assert.equal(result.creditsUsed, null);
});
