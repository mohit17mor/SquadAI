import { createHash } from "node:crypto";

import type {
  AgentDefinition,
  AgentModelCatalog,
  AgentModelOption,
  CompatibilityIssue,
  CompatibilityIssueKind,
  ReasoningEffort,
} from "./types.js";

export type CompatibilitySnapshot = {
  catalog: AgentModelCatalog;
  fetchedAt: string;
  fetchedAtMs: number;
  codexVersion: string | null;
  binaryPath: string | null;
  fingerprint: string;
};

export type CompatibilityGuardianOptions = {
  now?: () => number;
  catalogTtlMs?: number;
};

export class CompatibilityGuardian {
  private readonly now: () => number;
  private readonly catalogTtlMs: number;
  private current: CompatibilitySnapshot | null = null;

  constructor(options: CompatibilityGuardianOptions = {}) {
    this.now = options.now ?? Date.now;
    this.catalogTtlMs = options.catalogTtlMs ?? 3_600_000;
  }

  updateCatalog(
    catalog: AgentModelCatalog,
    metadata: { codexVersion?: string; binaryPath?: string } = {},
  ): CompatibilitySnapshot {
    const fetchedAtMs = this.now();
    this.current = {
      catalog,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      fetchedAtMs,
      codexVersion: metadata.codexVersion ?? null,
      binaryPath: metadata.binaryPath ?? null,
      fingerprint: catalogFingerprint(catalog, metadata.codexVersion ?? null),
    };
    return this.current;
  }

  snapshot(): CompatibilitySnapshot | null {
    return this.current;
  }

  needsRefresh(): boolean {
    return !this.current || this.now() - this.current.fetchedAtMs > this.catalogTtlMs;
  }

  validate(agent: AgentDefinition): CompatibilityIssue[] {
    const pinnedModel = agent.model?.trim();
    if (!pinnedModel || !this.current) return [];

    const available = visibleModels(this.current.catalog);
    const model = this.current.catalog.models.find((item) =>
      item.model === pinnedModel || item.id === pinnedModel
    );
    if (!model || model.hidden) {
      return [{
        kind: "model_unavailable",
        fingerprint: fingerprint(agent.id, "model_unavailable", pinnedModel),
        agentId: agent.id,
        model: pinnedModel,
        configuredValue: pinnedModel,
        recommendedValue: available[0]?.model ?? null,
        message: `Pinned model ${pinnedModel} is not available from Codex.`,
        suggestedModels: available,
      }];
    }

    const issues: CompatibilityIssue[] = [];
    if (agent.reasoningEffort && !supportsReasoning(model, agent.reasoningEffort)) {
      issues.push({
        kind: "reasoning_effort_unsupported",
        fingerprint: fingerprint(agent.id, "reasoning_effort_unsupported", `${model.model}:${agent.reasoningEffort}`),
        agentId: agent.id,
        model: model.model,
        configuredValue: agent.reasoningEffort,
        recommendedValue: model.defaultReasoningEffort,
        message: `Reasoning effort ${agent.reasoningEffort} is not supported by ${model.displayName || model.model}.`,
        suggestedModels: [],
      });
    }
    if (agent.serviceTier && !supportsServiceTier(model, agent.serviceTier)) {
      issues.push({
        kind: "service_tier_unsupported",
        fingerprint: fingerprint(agent.id, "service_tier_unsupported", `${model.model}:${agent.serviceTier}`),
        agentId: agent.id,
        model: model.model,
        configuredValue: agent.serviceTier,
        recommendedValue: null,
        message: `Service tier ${agent.serviceTier} is not supported by ${model.displayName || model.model}.`,
        suggestedModels: [],
      });
    }
    return issues;
  }

  classifyFailure(error: unknown): "compatibility_suspected" | "other" {
    const evidence = failureEvidence(error).toLowerCase();
    if (/model_(not_found|unavailable|unsupported|invalid)/.test(evidence)) {
      return "compatibility_suspected";
    }
    if (/\bmodel\b.{0,80}\b(not found|not available|unavailable|unsupported|unknown|invalid)\b/.test(evidence)) {
      return "compatibility_suspected";
    }
    if (/\b(reasoning effort|service tier)\b.{0,80}\b(not supported|unsupported|invalid|unavailable)\b/.test(evidence)) {
      return "compatibility_suspected";
    }
    return "other";
  }
}

function visibleModels(catalog: AgentModelCatalog): AgentModelOption[] {
  return catalog.models
    .filter((model) => !model.hidden)
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
}

function supportsReasoning(model: AgentModelOption, effort: ReasoningEffort): boolean {
  return model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort);
}

function supportsServiceTier(model: AgentModelOption, serviceTier: string): boolean {
  return model.serviceTiers.some((tier) => tier.id === serviceTier)
    || (model.additionalSpeedTiers ?? []).includes(serviceTier);
}

function fingerprint(agentId: string, kind: CompatibilityIssueKind, value: string): string {
  return `${agentId}:${kind}:${value}`;
}

function failureEvidence(error: unknown): string {
  if (error instanceof Error) {
    const details = error as Error & { code?: unknown; data?: unknown; rpcError?: unknown };
    return [error.name, error.message, details.code, safeJson(details.data), safeJson(details.rpcError)].join(" ");
  }
  return safeJson(error);
}

function catalogFingerprint(catalog: AgentModelCatalog, codexVersion: string | null): string {
  const models = catalog.models.map((model) => ({
    id: model.id,
    model: model.model,
    hidden: model.hidden,
    isDefault: model.isDefault,
    reasoning: model.supportedReasoningEfforts.map((option) => option.reasoningEffort).sort(),
    serviceTiers: [
      ...model.serviceTiers.map((tier) => tier.id),
      ...(model.additionalSpeedTiers ?? []),
    ].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256")
    .update(JSON.stringify({ codexVersion, models }))
    .digest("hex")
    .slice(0, 16);
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
