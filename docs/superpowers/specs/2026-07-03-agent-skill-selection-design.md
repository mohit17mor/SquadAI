# Per-agent skill selection

## Goal

Let Command Center users choose whether an agent inherits all available Codex skills or receives only an explicit selection, without changing the user's global Codex configuration or affecting Codex Desktop and CLI.

## Agent model

Each agent stores `skillMode` (`all` or `selected`) and logical skill references. `all` is the backward-compatible default. In `selected` mode, an empty selection means no skills.

A skill reference uses the skill name and scope for display and persistence, plus the discovered path only as a runtime resolution detail. Command Center refreshes the catalog with App Server `skills/list` before starting a restricted agent so plugin upgrades do not leave stale versioned paths.

## Runtime behavior

For `all`, Command Center starts the thread without skill overrides. For `selected`, it discovers the current catalog for the agent's working directory, validates every selected reference, and passes thread-scoped `skills.config` entries through `thread/start.config`: selected skills are enabled and every other discovered skill is disabled.

If discovery fails, a selected skill is missing or ambiguous, or the installed App Server rejects the override, agent startup fails closed with a visible error. Command Center never writes `~/.codex/config.toml` and never calls the persistent `skills/config/write` API.

Changing skill mode or selection invalidates the current runtime session. The prior conversation remains visible, but the next turn starts a fresh Codex thread with the new effective skill set.

## User interface

Agent creation and editing include a Skills section:

- **All available skills**: inherits current and future enabled skills.
- **Selected skills only**: searchable checkboxes grouped by scope; no selection means no skills.

Agent details show the configured mode and selected skill names. The editor warns that changing skills starts a new thread while preserving history.

## Compatibility

`codex-control` exposes `skills/list`, generic thread configuration overrides, and resume options without writing persistent Codex state. Command Center treats missing protocol support as an upgrade-compatibility issue rather than silently falling back to all skills.

## Verification

Tests cover catalog normalization, path-based override generation, missing/ambiguous selections, persistence, fresh-session invalidation, API payloads, and create/edit UI rendering. A live smoke check verifies that App Server accepts the generated thread configuration.
