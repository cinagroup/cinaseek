import { describe, expect, it } from "vitest";
import type { BlueprintBinding } from "@gadgets/workshop-shared/api";
import { DEFAULT_ADMIN_CONFIG, blueprintBindingsAvailable, defaultOutputFormatId, parseAdminConfig, reorderFormats, resolveFormatOutput, sanitizeOutputOverrides, serializeAdminConfig } from "../src/admin-config.js";

describe("parseAdminConfig", () => {
  it("backfills fields missing from a config persisted before they existed", () => {
    // A config written before `formats` was added. Every consumer indexes into these, so a missing
    // field must come back as its default rather than undefined.
    let stored = JSON.stringify({ signupsEnabled: false, siteName: "acme" });
    let config = parseAdminConfig(stored);

    expect(config.signupsEnabled).toBe(false);
    expect(config.siteName).toBe("acme");
    expect(config.formats).toEqual([]);
    for (let key of Object.keys(DEFAULT_ADMIN_CONFIG)) {
      expect(config[key as keyof typeof config], key).toBeDefined();
    }
  });

  it("drops malformed format entries rather than the whole list", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "good", enabled: true, agentHint: "  prefer me  " },
        { enabled: true },                       // no blueprintId
        "nonsense",
        { blueprintId: "defaults-enabled" },     // enabled omitted
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "good", enabled: true, agentHint: "prefer me" },
      { blueprintId: "defaults-enabled", enabled: true },
    ]);
  });

  // Everything downstream keys formats by blueprint id; setFormatOrder() in particular treats the
  // list as a set and refuses every reordering if it isn't one. A duplicate would make the menu
  // permanently unorderable, so it can't be allowed to survive a read.
  it("keeps only the first entry for a repeated blueprint", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "dup", enabled: true, agentHint: "first" },
        { blueprintId: "other", enabled: true },
        { blueprintId: "dup", enabled: false, agentHint: "second" },
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "dup", enabled: true, agentHint: "first" },
      { blueprintId: "other", enabled: true },
    ]);
  });
});

describe("reorderFormats", () => {
  let promoted = [
    { blueprintId: "a", enabled: true },
    { blueprintId: "b", enabled: true },
    { blueprintId: "c", enabled: true },
  ];

  it("rearranges into the order given", () => {
    expect(reorderFormats(promoted, ["c", "a", "b"]).map(f => f.blueprintId))
        .toEqual(["c", "a", "b"]);
  });

  // A repeated id passes both a length and a membership test, so without an explicit uniqueness
  // check it would drop "b" and leave a duplicate that makes every later reorder throw.
  it("refuses a repeated id", () => {
    expect(() => reorderFormats(promoted, ["a", "a", "c"])).toThrow(/exactly once/);
  });

  it("refuses a short list, a long list, and an unknown id", () => {
    expect(() => reorderFormats(promoted, ["a", "b"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "c", "a"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "z"])).toThrow(/exactly once/);
  });
});

describe("format presentation", () => {
  let declared = { id: "presentation", noun: "Slides", plural: "Slides", icon: "presentation" } as const;

  it("applies overrides over the blueprint's own declaration", () => {
    expect(resolveFormatOutput(declared, { noun: "Briefing", plural: "Briefings" }))
        .toEqual({ ...declared, noun: "Briefing", plural: "Briefings" });
  });

  it("has no format to offer when neither side supplies a complete one", () => {
    expect(resolveFormatOutput(undefined, { noun: "Briefing" })).toBeUndefined();
    expect(resolveFormatOutput(undefined, undefined)).toBeUndefined();
  });

  it("keeps only well-formed override fields", () => {
    expect(sanitizeOutputOverrides({ noun: "  Deck  ", icon: "notAnIcon", plural: "" }))
        .toEqual({ noun: "Deck" });
    expect(sanitizeOutputOverrides({ icon: "notAnIcon" })).toBeUndefined();
    expect(sanitizeOutputOverrides({ noun: "x".repeat(41) })).toBeUndefined();
  });

  it("derives a stable, valid grouping id without asking the admin for one", () => {
    expect(defaultOutputFormatId("acme.contract-memo")).toBe("acme.contract-memo");
    let long = "acme." + "contract-".repeat(8);
    expect(defaultOutputFormatId(long)).toBe(defaultOutputFormatId(long));
    expect(defaultOutputFormatId(long)).toHaveLength(40);
    expect(defaultOutputFormatId(long)).not.toBe(defaultOutputFormatId(long + "other"));
  });
});

describe("blueprint binding availability", () => {
  let emailPattern = "https://cinaseek.ai/gatekeeper/email/_resource/mailbox/:mailboxId";
  let emailBinding: BlueprintBinding = {
    type: "gatekeeper",
    title: "Email mailbox",
    description: "Read and send email.",
    gatekeeperName: "Email",
    typeUrlPattern: emailPattern,
  };
  let config = {
    disabledGatekeepers: [] as string[],
    disabledResources: {} as Record<string, string[]>,
  };

  it("accepts blueprints with no external gatekeeper requirements", () => {
    expect(blueprintBindingsAvailable({}, new Set(), config)).toBe(true);
    expect(blueprintBindingsAvailable({model: {
      type: "aiModel", title: "Model", description: "Choose a model.",
    }}, new Set(), config)).toBe(true);
  });

  it("rejects a blueprint whose gatekeeper Worker is not bound", () => {
    expect(blueprintBindingsAvailable({mailbox: emailBinding}, new Set(), config)).toBe(false);
  });

  it("accepts a bound gatekeeper regardless of identifier casing", () => {
    expect(blueprintBindingsAvailable({mailbox: emailBinding}, new Set(["EMAIL"]), config)).toBe(true);
  });

  it("rejects a disabled vendor or resource type", () => {
    expect(blueprintBindingsAvailable({mailbox: emailBinding}, new Set(["email"]), {
      ...config, disabledGatekeepers: ["EMAIL"],
    })).toBe(false);
    expect(blueprintBindingsAvailable({mailbox: emailBinding}, new Set(["email"]), {
      ...config,
      disabledResources: {EMAIL: [emailPattern]},
    })).toBe(false);
    expect(blueprintBindingsAvailable({mailbox: emailBinding}, new Set(["email"]), {
      ...config,
      disabledResources: {email: ["https://example.com/another-resource/:id"]},
    })).toBe(true);
  });

  it("requires every external gatekeeper in a multi-connector blueprint", () => {
    let githubBinding: BlueprintBinding = {
      ...emailBinding,
      gatekeeperName: "github",
      typeUrlPattern: "https://cinaseek.ai/gatekeeper/github/_resource/repository/:owner/:repo",
    };
    expect(blueprintBindingsAvailable(
        {mailbox: emailBinding, repository: githubBinding}, new Set(["email"]), config)).toBe(false);
    expect(blueprintBindingsAvailable(
        {mailbox: emailBinding, repository: githubBinding}, new Set(["email", "github"]), config))
        .toBe(true);
  });
});

describe("admin config site logo", () => {
  it("defaults legacy and malformed values to no custom logo", () => {
    expect(parseAdminConfig("{}").siteLogoConfigured).toBe(false);
    expect(parseAdminConfig('{"siteLogoConfigured":"yes"}').siteLogoConfigured).toBe(false);
  });

  it("round-trips configured logo state", () => {
    let config = parseAdminConfig('{"siteLogoConfigured":true}');
    expect(config.siteLogoConfigured).toBe(true);
    expect(parseAdminConfig(serializeAdminConfig(config))).toEqual(config);
  });
});
