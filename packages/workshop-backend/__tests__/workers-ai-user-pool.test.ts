import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const MODEL_ID = "@cf/zai-org/glm-5.2";

describe("user-contributed Workers AI models", () => {
  it("publishes an opted-in model and withdraws it without exposing credentials", async () => {
    const contributor = env.TEST_USER.getByName("workers-ai-contributor");
    const recipient = env.TEST_USER.getByName("workers-ai-recipient");

    await runInDurableObject(contributor, async (user: UserDurableObject) => {
      await user.addModel({ type: "agent", id: MODEL_ID, name: "GLM 5.2" }, {
        provider: "cloudflare",
        model: MODEL_ID,
        accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        apiToken: "workers-ai-contributor-token",
        shareWithUsers: true,
      });
      expect(await user.listWorkersAiModelAccess()).toContainEqual({
        modelId: MODEL_ID,
        access: "shared-by-you",
        poolSize: 1,
        availableCredentials: 1,
      });
    });

    await runInDurableObject(recipient, async (user: UserDurableObject) => {
      expect((await user.listModels()).map(model => model.id)).toContain(MODEL_ID);
      expect(await user.listWorkersAiModelAccess()).toContainEqual({
        modelId: MODEL_ID,
        access: "shared-pool",
        poolSize: 1,
        availableCredentials: 1,
      });
      const context = await user.getChatContext(MODEL_ID);
      expect(context.aiModel?.config).toEqual({
        provider: "cloudflare",
        model: MODEL_ID,
        apiToken: "",
        shareWithUsers: true,
      });
    });

    await runInDurableObject(contributor, async (user: UserDurableObject) => {
      await user.setWorkersAiModelShared(MODEL_ID, false);
      expect(await user.listWorkersAiModelAccess()).toContainEqual({
        modelId: MODEL_ID,
        access: "private",
        poolSize: 0,
        availableCredentials: 0,
      });
    });

    await runInDurableObject(recipient, async (user: UserDurableObject) => {
      expect((await user.listModels()).map(model => model.id)).not.toContain(MODEL_ID);
      expect(await user.listWorkersAiModelAccess()).not.toContainEqual(
          expect.objectContaining({ modelId: MODEL_ID }));
    });
  });

  it("rejects malformed private credentials before storing them", async () => {
    const stub = env.TEST_USER.getByName("workers-ai-invalid-credential");
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      await expect(user.addModel({ type: "agent", id: MODEL_ID, name: "GLM 5.2" }, {
        provider: "cloudflare",
        model: MODEL_ID,
        accountId: "not-an-account-id",
        apiToken: "workers-ai-contributor-token",
      })).rejects.toThrow("32 hexadecimal characters");
      expect((await user.listModels()).map(model => model.id)).not.toContain(MODEL_ID);
    });
  });
});
