# Codex Upgrade Safety Design

## Goal

Keep long-running agents reliable as the locally installed Codex app-server changes its model catalog and protocol behavior. Compatibility handling must be deterministic, visible, approval-gated, auditable, and inexpensive.

## Policy

- Agents without an explicit model continue to follow Codex's current default.
- Explicitly pinned models remain pinned while available.
- A pinned agent with an unavailable model pauses and requires human approval before migration.
- Approving a replacement automatically retries affected work with its original prompt.
- Declining a migration leaves the agent and its work blocked; nothing is discarded.
- Routine compatibility decisions use application code, not an LLM.

## Architecture

### Structured app-server errors

`codex-control` preserves JSON-RPC error code, message, and data in a typed error. This lets the manager distinguish protocol/configuration failures from ordinary agent-turn failures without parsing only a flattened string.

### Compatibility guardian

A focused `CompatibilityGuardian` in `codex-agent-manager` owns:

- a timestamped model-catalog snapshot;
- one-hour freshness rules;
- pinned model, reasoning-effort, and service-tier validation;
- deterministic failure classification;
- suggested replacement calculation;
- compatibility issue deduplication.

The manager invokes it before starting a pinned agent when the snapshot is stale. It also forces a refresh after a suspected compatibility failure. Existing running sessions do not poll before every turn.

### State and approvals

Agents gain a `blocked` status and optional compatibility issue. Work items gain a `blocked` status and a bounded retry-generation counter. Compatibility approvals are persisted separately from Codex tool approvals because resolving them mutates the stored agent definition.

Each approval records the unavailable configuration, current catalog, recommended replacement, affected work, creation time, and resolution. Only one pending approval exists per agent/configuration fingerprint.

## Failure and retry flow

1. Work is assigned to an agent.
2. Before starting a pinned agent, refresh a stale catalog and validate its configuration.
3. If invalid, block the agent and affected work before starting app-server.
4. If app-server still fails, preserve and classify the structured error.
5. Suspected model/configuration failures force a catalog refresh and revalidation.
6. Confirmed incompatibility creates one human approval and records an audit event.
7. Approval persists the replacement configuration and validates dependent settings.
8. The manager closes the stale session, unblocks work, and redispatches the original prompt.
9. A retry-generation limit prevents migration/restart loops.

Ordinary coding errors, tool failures, rate limits, authentication failures, and network failures retain distinct classifications and do not trigger model migration.

## API and UI

New command-center APIs expose compatibility health, pending migration approvals, and resolution actions. Existing agent and work APIs include blocked state and issue summaries.

The UI shows:

- a compatibility warning in Notifications;
- blocked status on topology nodes and agent lists;
- issue details and replacement choices in the agent inspector;
- Codex model-catalog freshness and current default;
- an audit trail for detection, approval, migration, session restart, and retry.

## Upgrade scope beyond models

The first implementation establishes the structured error and capability-snapshot boundary. Model, reasoning-effort, and service-tier changes are handled end to end. Codex CLI version and protocol capability fingerprints are surfaced as health metadata so future protocol migrations can use the same guardian without guessing or silently falling back.

## Error handling

- Catalog refresh failure does not invalidate a previously valid unexpired snapshot.
- With no usable snapshot, a pinned agent may attempt app-server normally; reactive diagnosis remains available.
- A confirmed missing model always blocks rather than silently selecting a replacement.
- Approval resolution is idempotent.
- Restart recovery preserves blocked agents, approvals, work, and retry generations.

## Testing

- `codex-control`: typed JSON-RPC error preservation.
- Guardian unit tests: freshness, validation, classification, suggestions, and deduplication.
- Manager tests: preflight blocking, reactive blocking, approval migration, automatic retry, decline behavior, restart recovery, and retry bounds.
- Server tests: compatibility APIs and UI affordances.
- Existing full test and coverage gates remain required.

## Non-goals

- Automatically upgrading the Codex CLI.
- Scraping public model documentation at runtime.
- Silent migration of pinned agents.
- Polling the catalog before every turn.
- LLM-based interpretation of routine compatibility errors.
