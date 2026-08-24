# ShowTalk Taishi repository guidelines

These instructions describe public project expectations for contributors and coding agents.

## Architecture boundaries

- Keep `src/core/` independent from Slack and concrete coding-agent protocols.
- Put coding-agent-specific behavior behind `AgentAdapter`; the first implementation is in `src/adapters/codex/`.
- Treat Slack as the human interface, activity log, and approval surface. Koe-to-Koe transport belongs to the Gateway router, not Slack events.
- Route Slack and Koe operations through the Permission Engine. Do not bypass `allow`, `deny`, or `approval` decisions.
- Persist only the minimum restart state required for sessions, bindings, approvals, and delegation continuity.

## Safety and privacy

- Never commit Slack tokens, Codex credentials, `.env`, real `config.yaml`, runtime state, management credentials, logs, or attachments.
- Use synthetic channel IDs, thread IDs, paths, usernames, and tokens in tests and documentation.
- Keep Slack OAuth scopes minimal and preserve the Gateway permission boundary even when Slack itself allows an operation.
- Do not weaken command, file-change, structured-input, or Git publication approval binding.
- In the ShowTalk App Server flow, a blocking structured-input answer from the bound Slack approval message separates the pre-approval and post-approval phases of one Codex turn. `承認して実行` is the new human decision; after exact revalidation, the post-approval phase may execute only that bound plan without waiting for another Slack message.

## Runtime diagnosis

- Do not use `session.status: running` in persisted state as proof that another turn is active; the current request can also set it.
- Determine the execution origin from the process-local turn lease and `activeTurn.type`, `channelId`, `rootThreadTs`, and `messageTs`.
- When an offline investigation cannot inspect the lease, report the state as `external_or_unknown` instead of guessing the originating Slack or Codex conversation.
- Slack threads do not need to be closed. A completed turn returns to `idle` while the persistent Codex thread binding remains.

## Gateway restart

- When a human explicitly requests a ShowTalk Taishi Gateway restart, use the Gateway restart capability. Do not use process signals or start a second worker as a substitute.
- Report a restart as scheduled only after the restart capability confirms scheduling. Do not conflate Gateway restart, Koe restart, and Codex thread reset.

## Codex subagents and Koe consultations

- Codex internal subagents stay inside the current coding task. `agent.send` creates a visible visit to another persistent Koe and is not an internal subagent operation.
- Send only to consultations explicitly configured for the source Koe and keep the request within the configured scope.
- Availability, an idle status, or a similar role name never grants consultation permission.

## Development workflow

- Preserve unrelated working-tree changes and keep patches scoped to the request.
- Run `npm run check` for normal changes. Use `npm run verify` for release-facing or cross-cutting changes.
- Keep tests aligned with the source responsibility boundaries in `src/`.
- Do not commit, push, publish packages, create releases, or change external services unless the user explicitly requests that scope.
