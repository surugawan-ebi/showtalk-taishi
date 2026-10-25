# Optional workspace-git integration

ShowTalk Taishi can run its Slack and Codex routing without workspace-git. Exact
Git approval buttons are an optional operator integration: they require a
separately installed workspace-git MCP plus a compatible, operator-owned manual
decision composition. This repository does not distribute that package,
initialize its private state, or grant Git authority.

## Manual decision composition

The external module must export:

```ts
createWorkspaceGitManualCompositionFromStateRoot({ stateRoot })
```

The returned composition must implement the version-1 human-only contract
validated in `src/approvals/workspace-git-decision-worker.ts`. Automation and
autonomy-control factories are rejected. Do not add signing keys, authority
identifiers, profiles, or private scope data to ShowTalk configuration.

Configure both environment variables together:

```bash
export SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE=/opt/example/workspace-git/manual.js
export WORKSPACE_GIT_STATE_ROOT=/var/example/workspace-git-state
```

These are synthetic paths. The module path must be absolute, owned by the
current user, a regular non-symlink file, and not group/world writable. The
state root must be an absolute private directory managed by the external
integration.

`taishi doctor` performs metadata-only checks. It never imports the module or
opens provider state, and reports one of:

- `not configured; exact Git approvals unavailable`;
- `configuration present; live decision round-trip unverified`;
- a sanitized configuration error.

The second result proves only local metadata. A real decision remains
unverified until an exact plan is prepared and a bound Slack approval completes
through the normal fail-closed flow.

## Operational boundary

Without this integration, Taishi may display ordinary choices and native Codex
approvals, but exact workspace-git decisions fail closed. Never substitute a
typed Slack message, a copied button, a relay Koe, or a direct `git`/`gh`
command for the missing broker.

The external workspace-git service remains responsible for persisting the
operation, recomputing its plan hash under its private lock, recording the
authenticated human decision, and revalidating before execution. ShowTalk
retains only the minimum public binding required to connect that decision to
the originating Slack turn.

## Exact public plan compatibility

For a `push_base_merge` update, the base synchronization request uses the
PR-read base SHA (B), while the publication preparation input
`expected_base_sha` uses the receipt's fetched base tip (T). The prepared public
scope and approval scope carry B separately as
`expected_pull_request_base_sha`. ShowTalk validates and retains both values,
displays them separately, and rejects a missing or substituted binding instead
of assuming B equals T. The backend remains responsible for ancestry, receipt,
lease, remote-state, and execution-time checks.

Dependabot merge evidence is bound to the same PR, head, base, author, and exact
file hashes. ShowTalk validates the evidence fingerprint, retains immutable
evidence, and presents it for review; the backend still revalidates GitHub and
CI before execution. Neither evidence nor an ordinary choice replaces the
exact human approval boundary.

When a file contains unrelated local hunks, a path list alone is not evidence
that publication commits only staged hunks. Use a documented partial-index
contract or isolate the intended patch through the normal supported workspace
workflow before preparing its plan. A safety rejection must be resolved through
the rejecting service rather than retried through another Git path.
