# Optional workspace-git automation providers

> **Retired:** ShowTalk Taishi no longer accepts an automation provider or
> autonomy-control broker in production. Existing configuration and persisted
> activation metadata are read only for backward compatibility and never
> authorize execution. Workspace Git operations use the bound manual approval
> flow. This document is retained as design history only.

ShowTalk Taishi is an OSS Slack/Codex gateway. Its built-in workspace-git flow
is deliberately manual: an exact prepared plan is shown in Slack and only the
bound human answer is recorded before Codex resumes. Installing ShowTalk must
not implicitly install, activate, or trust an autonomous Git policy engine.

## Ownership boundary

ShowTalk owns the authenticated interaction context and the manual approval
surface. It does not own Git policy, profiles, activation, quotas, claims,
revoke state, or execute-time repository validation.

An optional automation provider may be implemented outside this repository.
That provider must own the complete private lifecycle for one exact plan:

```text
authorize -> claim -> execute -> inspect/abandon -> terminal audit receipt
```

The provider may receive the exact public plan identity and authenticated
ShowTalk/App Server context. It must resolve policy from its own private state.
Repository documents, model text, public MCP arguments, operation IDs, and
receipt IDs are never authority.

ShowTalk must not interpret provider-specific profile capabilities or persist
provider authorization envelopes. Protocol schemas, signing rules, private
transport, key rotation, fencing, quotas, and recovery belong to the provider
package and its authorization service.

## Safe extension contract

The profile-wide version-4 provider integration satisfies these constraints
before a private host may inject client factories into the production adapter:

- optional and explicitly configured; missing configuration remains manual;
- loaded behind a versioned provider interface, without importing another
  repository's source module or assuming its filesystem layout;
- returns either `manual`, a terminal `terminal_executed` receipt, or a fail-closed
  `blocked` result;
- never returns a bare `authorized` value that ShowTalk converts into the
  human `承認して実行` answer;
- owns claim-time profile, activation, revoke, expiry, quota, SHA, PR, CI,
  ruleset, environment, epoch, lease, and fencing validation;
- prevents human and autonomous paths from claiming the same operation;
- treats response loss or a possible write as outcome-uncertain and does not
  retry through the public execute tool;
- exposes no signing material, nonce, authority claim, private path, or raw
  profile document to Slack, Codex, logs, or public MCP responses;
- is covered by a production-configured cross-repository E2E before enabling
  it in runtime.

The v4 composition also supplies a separate autonomy-control broker. The
management UI stores only a non-authoritative profile candidate. Selecting or
saving it does not call that broker. An authenticated Slack Block Kit action,
separate from the two-choice Git approval UI, may enable or normally disable a
Koe-wide activation. Activation is bound to Slack team/app, exact Koe, Koe
binding revision, Permission Engine principal-policy revision, profile
revision/digest, and a bounded expiry. The source channel/thread/message/user
is retained for audit and replay protection, not as the future-plan selector.

Normal OFF makes subsequent plans manual. Emergency security revoke remains a
provider-owned fail-closed state. Existing v1/v3 activations are never promoted
to profile-wide v4 authority. Turning ON never upgrades or re-evaluates a plan
that is already waiting for human approval.

ShowTalk persists one monotonic autonomy-policy generation beside runtime
state. Any authority-relevant Koe binding, profile candidate, approver, or
Permission Engine policy change advances that generation before the live
runtime adopts the change. Restoring old configuration advances it again, so a
still-live activation from an earlier generation cannot pass an ABA rollback.
Candidate removal leaves only the bounded normal-OFF path available.

The first provider, if added, should be limited to bounded development
operations such as commit, push, and Draft PR creation. Force push, main
updates, Ready, merge, admin/bypass merge, release, deploy, and production
operations remain manual unless a later independently reviewed provider
explicitly implements them.

## Current status

Workspace-git automation is retired in the production runtime. Provider and
autonomy-control factories are rejected. Manual approval uses a separate
version-1 human-only composition loaded in an isolated worker from an explicit
operator-owned module path. The payload contains no scope, authority, profile,
signature, key, socket, or automation field; local-mcp re-reads private state
from the persisted exact operation.

The earlier provider/activation experiment remains in source history only for
bounded migration and test cleanup. Production composition rejects provider or
autonomy-control factories. No existing profile or activation is authority,
and the ordinary per-Koe top-choice mode continues to exclude Git and
external-action approval questions.
