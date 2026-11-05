# Security

This application stores sensitive financial records. Each installer controls their database, OAuth applications, hosting secrets and external integrations; repository ownership does not grant access to an installation.

For a suspected vulnerability, use the repository's **Security → Report a vulnerability** private reporting feature when available. If it is unavailable, open a public issue that only requests a private contact channel. Do not include credentials, financial records, personal details, tokens or a working exploit against an active installation in that issue.

In a private report, provide the affected version or commit, expected and observed behavior, a minimal synthetic reproduction, and the affected permission boundary. Do not test against another installer's deployment or data.

Never place secret/service-role keys in `NEXT_PUBLIC_` variables. Keep environment files and integration keys outside Git, use isolated preview databases, and preserve RLS, administrator checks, signed server operations and version-conflict guards. If a credential is exposed, revoke or rotate it with its provider and review affected access; removing a commit alone does not invalidate the credential.

Only the latest repository version is maintained unless a release states otherwise. Security fixes should include a regression test with synthetic data when the behavior can be reproduced locally.
