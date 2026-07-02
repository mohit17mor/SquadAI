import assert from "node:assert/strict";
import test from "node:test";

import { CompatibilityGuardian } from "../src/compatibility.js";
import type { AgentDefinition, AgentModelCatalog } from "../src/types.js";

const catalog: AgentModelCatalog = {
  models: [
    {
      id: "gpt-current",
      model: "gpt-current",
      displayName: "GPT Current",
      description: "Current default",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
      ],
      defaultReasoningEffort: "medium",
      additionalSpeedTiers: ["fast"],
      serviceTiers: [{ id: "priority", name: "Fast", description: "Lower latency" }],
      isDefault: true,
    },
    {
      id: "gpt-small",
      model: "gpt-small",
      displayName: "GPT Small",
      description: "Efficient",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
      defaultReasoningEffort: "low",
      additionalSpeedTiers: [],
      serviceTiers: [],
      isDefault: false,
    },
  ],
};

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "worker",
    name: "Worker",
    cwd: "/tmp/project",
    instructions: "Do work.",
    ...overrides,
  };
}

test("refreshes a missing or expired compatibility snapshot", () => {
  let now = 1_000;
  const guardian = new CompatibilityGuardian({ now: () => now, catalogTtlMs: 3_600_000 });

  assert.equal(guardian.needsRefresh(), true);
  guardian.updateCatalog(catalog, { codexVersion: "0.130.0" });
  assert.equal(guardian.needsRefresh(), false);
  assert.equal(guardian.snapshot()?.codexVersion, "0.130.0");
  assert.match(guardian.snapshot()?.fingerprint ?? "", /^[a-f0-9]{16}$/);

  now += 3_600_001;
  assert.equal(guardian.needsRefresh(), true);
});

test("allows agents using the Codex default without pin validation", () => {
  const guardian = new CompatibilityGuardian();
  guardian.updateCatalog(catalog);

  assert.deepEqual(guardian.validate(agent()), []);
});

test("reports a removed pinned model with the current default first", () => {
  const guardian = new CompatibilityGuardian();
  guardian.updateCatalog(catalog);

  const issues = guardian.validate(agent({ model: "gpt-retired" }));

  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, "model_unavailable");
  assert.equal(issues[0]?.configuredValue, "gpt-retired");
  assert.deepEqual(issues[0]?.suggestedModels.map((model) => model.model), [
    "gpt-current",
    "gpt-small",
  ]);
  assert.match(issues[0]?.fingerprint ?? "", /model_unavailable:gpt-retired/);
});

test("reports reasoning and service settings unsupported by the pinned model", () => {
  const guardian = new CompatibilityGuardian();
  guardian.updateCatalog(catalog);

  const issues = guardian.validate(agent({
    model: "gpt-small",
    reasoningEffort: "xhigh",
    serviceTier: "priority",
  }));

  assert.deepEqual(issues.map((issue) => issue.kind), [
    "reasoning_effort_unsupported",
    "service_tier_unsupported",
  ]);
  assert.equal(issues[0]?.recommendedValue, "low");
  assert.equal(issues[1]?.recommendedValue, null);
});

test("classifies only configuration-shaped app-server failures as compatibility suspects", () => {
  const guardian = new CompatibilityGuardian();

  assert.equal(guardian.classifyFailure({
    name: "CodexAppServerError",
    message: "Model gpt-retired is not available",
    code: -32602,
    data: { kind: "model_not_found", model: "gpt-retired" },
  }), "compatibility_suspected");
  assert.equal(guardian.classifyFailure(new Error("network connection reset")), "other");
  assert.equal(guardian.classifyFailure(new Error("tool execution failed")), "other");
});
