# Security Policy

## Supported versions

ShowTalk Taishi is pre-release software. Security fixes target the latest code
on the repository's default branch; older snapshots and downstream forks may
not receive fixes.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting from this repository's **Security**
tab and choose **Report a vulnerability**. Include, where possible:

- a concise description and expected impact;
- the affected version or commit;
- minimal reproduction steps or a proof of concept;
- relevant environment details; and
- any known workaround or mitigation.

Redact credentials, private workspace paths, Slack content, and personal data.
Use synthetic identifiers and placeholders whenever possible.

If Private Vulnerability Reporting is not enabled, do not disclose sensitive
details, exploit code, secrets, or private logs in a public issue. A public
issue may contain only a non-sensitive request for the maintainers to enable a
private reporting channel.

## Safe research

Test only with systems, accounts, Slack workspaces, and data you own or have
explicit permission to use. Avoid privacy violations, service disruption,
social engineering, persistence, and access beyond the minimum needed to show
the issue. Do not retain or publish data obtained during testing.

For the project's trust assumptions and implemented boundaries, see the
[security model](docs/security.md) and the README's
[security boundaries](README.md#security-boundaries). Reports are evaluated
against the current local-first, trusted-workstation model as well as the
documented Slack, MCP, credential, approval, and permission boundaries.
