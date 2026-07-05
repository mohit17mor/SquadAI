# Remote Runner Desktop Integration

## Goal

Make remote runners feel native in Command Center: users can select a VM directory, open a VM worktree in VS Code on the control-plane Mac, and see which machine owns every topology agent.

## Runner contract

- Runner registration gains an optional `sshHost`. It is supplied once through `--ssh-host` or `CODEX_AGENT_MANAGER_SSH_HOST` and represents a `Host` understood by the control machine's SSH configuration.
- The runner protocol gains a read-only directory-list command. It returns the resolved current path, parent path, home path, and readable child directories.
- Directory listing never creates, edits, or deletes files. Permission and missing-path errors return a clear message.
- Creating or moving an agent to a nonexistent runner directory fails instead of silently continuing without a worktree.

## Directory selection

- Local agents keep the existing native macOS directory picker.
- Remote agents open a lightweight modal using the existing Command Center visual language.
- The modal starts from the current valid path or the runner user's home directory, supports parent navigation and child-directory navigation, and selects the displayed directory.
- The selected VM path is written into the agent form. Git worktree creation remains the responsibility of the runner.

## VS Code behavior

- Local worktrees keep the existing local VS Code opening behavior.
- Remote worktrees use the owning runner's `sshHost` to build a VS Code Remote SSH folder URI.
- The control plane opens that URI on the Mac. If `sshHost` is missing, the UI reports the exact runner startup option required instead of hiding the button.
- The SSH host is runner-level configuration, never agent-level configuration and never hardcoded to one VM.

## Topology behavior

- Agent snapshots already include `runnerId`; topology additionally loads runner registration data.
- Each agent label shows its status and concise machine name.
- The inspector shows runner name, runner ID, hostname, and local/remote placement.
- Unknown or offline runners remain visible and are labelled accordingly.

## Error handling and compatibility

- Existing agents without `runnerId` continue to use the local runner.
- Existing remote runners without `sshHost` can still execute agents and browse directories; only one-click VS Code opening reports a configuration error.
- An offline runner produces a clear Browse/Open error without changing the form or agent state.

## Verification

- Unit tests cover runner registration metadata, remote directory listing, invalid paths, and Remote SSH URI construction.
- Server tests cover directory API routing and local versus remote workspace opening.
- The existing suite must continue to pass.
- Browser verification covers the remote picker, topology machine labels, and disabled/error states.
