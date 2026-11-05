# Contributing

Use Node.js 22 and `npm ci`. Read [README](README.md), [the development guide](docs/DEVELOPMENT.md) and [the financial contracts](docs/OPERATING_RULES.md) before changing behavior.

Keep changes focused and describe the user-visible problem, resulting behavior and relevant validation in a pull request. Use synthetic examples only: remove real names, account details, financial files, service keys, sessions and installation identifiers from patches, logs and screenshots.

Preserve transaction originals, manual classifications, saved plans, exclusions, shared ownership, RLS, signatures and conflict checks. Equal dates and amounts alone are insufficient evidence of a duplicate. Keep actual withdrawals separate from remaining budgets and avoid subtracting paid expenses twice.

Run the relevant tests, then `npm test`, `npm run doctor` and `npm run build`. SQL tests use in-memory PGlite and must not connect to a live financial database. Explain any unverified installation-specific flow. Update documentation when setup or financial behavior changes.

Do not commit local environment files, hosting links, generated builds, database exports or private tool state. Keep third-party copyright and license notices intact. Contributions to this project's original code are submitted under the [MIT license](LICENSE); externally sourced code retains its own applicable license and attribution.

Report vulnerabilities through [SECURITY.md](SECURITY.md), rather than including credentials or exploitable financial details in a public issue.
