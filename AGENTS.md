# Merlin Finance · Open-source development

This directory is a separate open-source candidate. It contains a fresh code snapshot, not the private deployment's Git history, credentials, database or financial backup. Do not edit or publish the private source checkout while working here.

Read README.md and docs/OPERATING_RULES.md before making changes. Preserve the existing feature set: imports and classification, balance synchronization, cash planning, actual versus scheduled calendar entries, recurring expenses and finite installments, monthly reporting, intercompany loans and settlements, administrator access and optional external integrations.

## Data and configuration

Only synthetic examples belong in source, tests, screenshots and documentation. Never copy private financial files, named employee rules, account numbers, login sessions, keys or production project identifiers into this release. Business names, accounts, installation owner and integration settings must be supplied by each installer. New installations must not depend on the original team's users or infrastructure.

Keep transaction originals, manual classifications, saved plans and exclusions intact. Deduplicate by evidence and identity; equal dates and amounts alone do not prove duplication. Keep actual withdrawals separate from remaining budgets and do not deduct already-paid amounts from current balances twice. Every installer owns an isolated database; this app performs no bank transfers.

## Implementation and verification

Use Node.js 22 and the committed package lock. Run meaningful tests for the change and complete npm test, npm run build and npm run doctor before release. Database tests use synthetic local data only. Validate a clean installation and the initial administrator path; preserve RLS, ownership checks, signing verification and conflict guards.

Other workers may be editing this candidate. Respect file ownership and do not revert their work. Record unresolved release concerns clearly. Keep credentials and local tool state outside Git. Repository ownership does not grant access to an installed database or third-party accounts.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
