# Runcap Current Product Status

This is the current public boundary for Runcap.

```text
Control AI coding spend.
Require proof before merge.
```

Runcap controls AI coding missions. It caps routed AI spend, constrains what an
agent may change, and requires proof before an AI-generated pull request earns
merge eligibility.

## Available Now

- **Local-first CLI controls.** Runcap can plan, preflight, wrap, report, export,
  and display local AI coding missions from the command line.
- **Hard caps for routed AI calls.** Spend caps apply only to AI requests routed
  through the Runcap gateway/control path. Calls made directly to providers,
  subscriptions, invoices, personal cards, and unrelated tools are outside the
  metered path.
- **Mission policies.** A repository can define `.runcap/mission.yaml` with
  identity, budget limits, verification commands, protected paths, and allowed
  change scope.
- **Public GitHub Proof Gate demo.** The demo repository shows three public pull
  requests graded by a pinned Runcap GitHub Action.
- **PR verdicts.** The current public verdicts are `PASS`, `BLOCKED`, and
  `HUMAN_APPROVAL_REQUIRED`.
- **GitHub/Node/npm-oriented CI adjudication.** The current Proof Gate is built
  around GitHub Actions, Node/npm repositories, text diffs, declared mission
  policy, and base-pinned verification replay.

## Explicit Limits

- Runcap does not see all AI spend across a company.
- It does not see subscription usage, personal cards, reimbursement data,
  invoices, or AI tools outside its control path.
- CI adjudication does not independently meter all AI spend. It verifies code
  changes and policy compliance; spend enforcement remains tied to routed calls
  and mission receipts.
- Runcap does not claim cryptographic proof, fully independent verification,
  or guaranteed safe merges.
- Hosted sync, team pools, organization reporting, paid Pro features, and paid
  plans are not products available for purchase today.

## Direction, Not Current Feature Claim

The future Mission Receipt concept is:

```text
owner + workload + cap + metered coverage + PR verdict
```

That concept is a product direction, not a shipped public guarantee. Today,
Runcap can write local receipts and CI verdicts for supported coding workflows,
but it does not yet provide a hosted company-wide receipt ledger or universal
coverage across all AI work.

## Public-Interface Items Requiring Product Verification

| Location | What it appears to promise | Current public documentation support | Recommended next decision |
|---|---|---|---|
| `bin/runcap.mjs` help: `runcap login <license-key>` | Pro license login enabling cloud sync and a hosted dashboard. | README Availability says hosted sync and paid plans are not available today. | Verify end-to-end before public launch, or mark experimental/remove from public help. |
| `src/cloud.mjs`: `loginCommand`, `whoamiCommand`, `syncRun` | Stored Pro license, remote sync endpoint, hosted dashboard URL. | No current public product page documents an available hosted dashboard or purchase flow. | Verify end-to-end with real license issuance and privacy terms, or mark experimental/remove from public help. |
| `bin/runcap.mjs` help and `src/alerts.mjs`: `runcap alerts` | Pro phone alerts for cap breaches through Telegram, WhatsApp, or webhooks. | README does not document alerts as an available product; Availability says paid plans are future ideas. | Verify end-to-end and publish setup/security docs, or mark experimental/remove from public help. |
| `README.md` Availability and pricing-adjacent language | Future hosted sync, team pools, organization reporting, and paid plans. | README now labels these as future ideas only. | Keep as direction only until a purchasable product exists. |
| `PRODUCT.md` root product status | Broad "AI efficiency control layer" for a person or company, including routing, monitoring, learning, and dashboard claims. | Current public boundary is narrower: AI coding missions, routed spend caps, mission scope, and Proof Gate. | Update or mark historical in a later docs pass. |
| `docs/ROADMAP.md`, `docs/BUSINESS-PLAN.md`, `docs/product-plan.md`, `docs/LAUNCH-COPY.md` | Planning language for teams, cloud, Pro, hosted dashboards, and launch copy. | These files are now marked historical and point here for current scope. | Keep as historical planning documents unless the product decision changes. |

