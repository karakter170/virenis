# Normalized billing privacy and retention

Virenis keeps the operational billing view in the product store and projects
accounting facts into the tenant-isolated `tcar_billing` schema. Account export
includes the operational billing view. Account deletion removes that operational
view, but it does not blindly delete the normalized accounting ledger: some
deployments must retain transaction evidence for accounting, tax, payment
reconciliation, fraud prevention, chargebacks, or legal holds.

The normalized projection uses `virenis-billing-minimized-v1`. It retains a
minimum, integrity-checked record of the charge that was recorded:

- credited, debited, reserved, charged, and resulting balance amounts;
- transaction kind, status, timestamps, provider name, and pricing version;
- pricing rules and reservation ceilings available at projection time;
- aggregate token counts and minimized per-component cost totals;
- immutable chain, idempotency, request, and source-content digests.

This evidence preserves recorded totals and supports reconciliation against the
source ledger. It is deliberately **not** an independent repricing dataset:
per-call rounding buckets and the exact applied rule are not retained, so a
charge cannot always be recomputed from aggregates alone after the operational
record is deleted.

It does not retain raw user IDs, run IDs, account IDs, ledger
references, payment-provider event/reference IDs, agent/step/model labels,
free-form pricing or release reasons, or arbitrary ledger metadata. Relationship
IDs and provider references become deterministic workspace-scoped SHA-256
pseudonyms. Free-form JSON becomes a typed digest receipt. The raw
`workspace_id` remains as the RLS partition key, and global pricing-version IDs
remain so retained records can reference their pricing version. Deployments must
therefore issue opaque, non-personal workspace and pricing IDs. A known original
can still be correlated by recomputing its digest, so this is pseudonymization,
not anonymization.

## Legacy privacy gate

Before any normalized billing insert, `syncNormalizedBilling` checks every
workspace represented by an active user or operational billing record, plus the
global pricing workspace. It fails with
`NORMALIZED_BILLING_LEGACY_PRIVACY_MIGRATION_REQUIRED` if an existing row has a
raw durable/external identifier, raw free-form reason, legacy JSON payload, or
another pre-minimization shape. All active workspaces are checked before the
first insert, so the current process cannot silently extend a legacy chain.

The request-serving database role is deliberately `NOBYPASSRLS`; therefore it
cannot discover an orphaned ledger workspace that is absent from the current
operational snapshot. Before initial launch, every projection migration, and
every retention sweep, a migration administrator must use a separate, tightly
controlled `BYPASSRLS` connection to inventory every `tcar_billing` workspace
and either:

1. perform an explicitly approved shadow-table rebuild and atomic cutover that
   preserves required accounting facts while replacing legacy identifiers and
   metadata; or
2. quarantine the legacy ledger and start a clean minimized projection under a
   documented reconciliation plan.

`BYPASSRLS` does not bypass append-only triggers, so it cannot directly rewrite
legacy immutable rows. Do not disable guards or delete accounting rows from the
serving application. Any exceptional rebuild must be reviewed, logged, backed
up, tested, and run with the application write path stopped.

## Launch policy requirement

The application does not yet enforce a normalized-ledger TTL and cannot
determine the correct legal retention period for every jurisdiction. Before
launch, the operator must document and implement the retention purpose,
jurisdiction-specific duration, legal-hold and chargeback rules, access controls,
and reviewed expiry/anonymization process. Until that deployment policy is
attested, retention is an operator obligation—not an application-enforced
property. The account export and deletion responses disclose that this
projection is not included in the JSON export and may remain.

## Current scale boundary

Projection synchronization and the legacy gate scan all active billing
workspaces and replay operational billing rows. This is intentionally a bounded
private-beta implementation, not a horizontally scalable billing data plane.
Before broad multi-user launch, move projection to a transactional outbox/worker
with per-workspace checkpoints and administrator-visible orphan inventory.
