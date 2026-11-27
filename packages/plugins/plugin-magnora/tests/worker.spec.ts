import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { ACTION_KEYS, TOOL_NAMES } from "../src/constants.js";
import { MemoryStore } from "../src/store.js";
import { createService, registerMagnora } from "../src/worker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function setup() {
  const harness = createTestHarness({ manifest, config: { social: { facebook: { enabled: true, accountId: "1", accessToken: { type: "secret_ref", secretId: "s" } } } } });
  harness.seed({
    agents: [
      { id: "22222222-2222-4222-8222-222222222222", companyId: COMPANY, name: "Social Media", urlKey: "social-media" } as never,
      { id: "33333333-3333-4333-8333-333333333333", companyId: COMPANY, name: "Sales", urlKey: "sales" } as never,
    ],
  });
  const store = new MemoryStore();
  registerMagnora(harness.ctx, createService(harness.ctx, store));
  return { harness, store };
}

describe("worker registration", () => {
  it("declares a handler for every manifest tool", async () => {
    const { harness } = setup();
    expect(manifest.tools?.length).toBeGreaterThan(5);
    for (const tool of manifest.tools ?? []) {
      // Unregistered tools throw; registered ones resolve (possibly with a structured error).
      await expect(harness.executeTool(tool.name, {}, { companyId: COMPANY, agentId: "22222222-2222-4222-8222-222222222222" })).resolves.toBeDefined();
    }
  });

  it("returns a structured permission error to unassigned agents", async () => {
    const { harness } = setup();
    const result = await harness.executeTool(TOOL_NAMES.socialSubmitPost, { channel: "facebook", text: "hi" }, { companyId: COMPANY, agentId: "33333333-3333-4333-8333-333333333333" });
    expect(result.error).toMatch(/PERMISSION DENIED/);
  });

  it("queues a post for approval from an assigned agent", async () => {
    const { harness, store } = setup();
    const result = await harness.executeTool(TOOL_NAMES.socialSubmitPost, { channel: "facebook", text: "hi" }, { companyId: COMPANY, agentId: "22222222-2222-4222-8222-222222222222" });
    expect(result.error).toBeUndefined();
    expect([...store.outbox.values()][0]!.status).toBe("pending_approval");
  });

  it("only lets signed-in board users approve", async () => {
    const { harness, store } = setup();
    const item = await store.createOutbox({ companyId: COMPANY, kind: "social_post", channel: "facebook", payload: { text: "x" }, status: "pending_approval" });
    await expect(harness.performAction(ACTION_KEYS.reject, { id: item.id }, { companyId: COMPANY, actor: { type: "agent", agentId: "a" } })).rejects.toThrow(/board user/);
    const rejected = await harness.performAction<{ status: string }>(ACTION_KEYS.reject, { id: item.id }, { companyId: COMPANY, actor: { type: "user", userId: "u1" } });
    expect(rejected.status).toBe("rejected");
  });
});
