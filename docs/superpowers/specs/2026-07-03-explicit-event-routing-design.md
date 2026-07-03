# Explicit Event Routing Design

## Goal

Make event execution deterministic and inexpensive by allowing event producers to target a worker directly. Preserve the existing router implementation behind an optional routing mode for future use.

## Event contract

`SensorEventInput` gains an optional `targetAgentId`.

- A valid target creates the sensor event and its queued work item atomically.
- An absent target creates an `unassigned` event that waits for a human.
- An unknown target rejects ingestion with a clear client error.
- Dedupe returns the existing event and never creates duplicate work.

The work-item prompt is built deterministically from the original event rather than rewritten by a model.

## Routing modes

The server supports three modes while defaulting to `explicit`:

- `explicit`: direct targets are queued; targetless events remain unassigned.
- `router-fallback`: direct targets are queued; targetless events use the existing router.
- `router-only`: all events use the existing router behavior.

Router code, role handling, roster state, prompts, and existing thread history remain intact.

## Manual assignment

`POST /api/sensor-events/:eventId/assign` accepts `targetAgentId`. It validates the worker, creates one queued work item, updates the event, persists both, and wakes dispatch automation. Reassigning an already assigned event is rejected.

The Event Inbox shows an agent selector and Assign action for unassigned events.

## OpenPulse

The generic Command Center bridge accepts `--target-agent-id` and emits it as a top-level event field. Monitor setup scripts configure their intended workers without adding source-specific routing logic to Command Center.

## Reliability

- Busy or temporarily failed workers retain queued work.
- Invalid explicit targets fail fast.
- Existing persisted events remain readable.
- Router fallback remains opt-in.
- Tests cover direct ingestion, targetless ingestion, invalid targets, dedupe, manual assignment, and legacy router modes.
