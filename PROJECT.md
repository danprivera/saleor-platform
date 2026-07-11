# rovershop-saleor-platform — Project Reference

The **Saleor commerce backend** for RoverShop: a fork of Saleor's official `saleor-platform`
repo, used two ways —

1. **Local development**: the upstream docker-compose stack (API, Dashboard, Postgres, Valkey,
   Mailpit, Jaeger) — see [README.md](./README.md), unchanged from upstream.
2. **Production**: Azure Container Apps deployment (`api.rovershop.io`,
   `admin.rovershop.io`) plus the **vendor provisioning scripts** in `scripts/` — this is the
   RoverShop-specific part. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full architecture.

This file is the agent-onboarding reference; current state and next steps live in
[PROGRESS.md](./PROGRESS.md).

## Ecosystem context

| Repo | Relationship |
| --- | --- |
| [rovershop-saleor-storefront](../rovershop-saleor-storefront) | Queries this Saleor's GraphQL API per-tenant (`tenant.saleorChannel` scopes every product/checkout query) |
| [roverai-strapi-platform](../roverai-strapi-platform) | Vendor record's `saleorChannel` field names the channel this repo provisions; booking services carry `saleorProductVariantId` back-references |
| [rovershop-dashboard-web](../rovershop-dashboard-web) | Vendor dashboard; reads Saleor data for orders/products views (channel-scoped) |

## Multi-tenancy model (core ADR)

**Channel-per-vendor.** Every vendor gets a dedicated Saleor channel (e.g. `illnails`,
`deliajewelry`) — never shared with `default-channel` — so a vendor's catalog/pricing/checkout
never mixes with another's and no later migration is needed. `default-channel` remains the
fallback for unmatched storefront hosts and carries a small placeholder catalog.

Known ceiling: Saleor isn't designed for thousands of channels in one instance; a sharding
threshold decision is an open item (storefront PROGRESS §5.5).

## Provisioning scripts (`scripts/`)

`provision-illnails.mjs` (booking vendor, with Strapi service write-back) and
`provision-deliajewelry.mjs` (commerce vendor + default-channel placeholder catalog). Both are
the **reference pattern** for onboarding any vendor:

- Plain-fetch GraphQL client + `tokenCreate` admin auth + `assertNoErrors()` helper; admin
  credentials come from env (sourced from Key Vault `rover-technologies-vault` at invocation).
- **Idempotent throughout**: check-before-create by slug (channels/categories), by
  **script-scoped metadata markers** (products — e.g. `deliaCatalogSlug`, `legacySourceId`), and
  by slug+channel (collections). Reruns update in place.
- Creates: channel → category → products/variants (with channel listings + prices) →
  `featured-products-{channel}` collection published to that channel.

### Saleor gotchas encoded in these scripts (learned live — don't relearn)

- **Collections are global, not per-channel**: one slug, one shared product list. Each channel
  needs its own collection slug (`featured-products` for default, `featured-products-{channel}`
  otherwise).
- **`filter: { search }` is unreliable for idempotency** right after creation (search-index
  lag caused duplicate-create bugs twice). Fetch broadly and match client-side on a metadata
  marker instead.
- **`trackInventory: false`** is correct for services/non-physical variants — makes
  `quantityAvailable` resolve to a large non-blocking number.
- Mutation payload field names don't always match the mutation name
  (`productVariantChannelListingUpdate` → `variant`, `collectionChannelListingUpdate` →
  `collection`) — **introspect, don't guess**.
- graphql-core rejects non-null variables with defaults (`$q: Int! = 1`) — use nullable with a
  default (`$q: Int = 1`).

## Production architecture (summary — details in DEPLOYMENT.md)

Container Apps env `rover-ai-env` in `rg-rover-saleor-prod`: `saleor-api` (external,
`api.rovershop.io`), `saleor-dashboard` (external, `admin.rovershop.io`), `saleor-worker`
(Celery), `saleor-beat` (exactly 1 replica — scheduled tasks must not double-fire), `valkey`
(internal). Postgres = Azure Flexible Server `psql-rover-saleor-prod-04` (also hosts the
`strapi` DB for rover-strapi). Media on Azure Blob (`AzureMediaStorage`), email via SendGrid.
Migrations/superuser run as manual Container Apps Jobs (`saleor-migrate`,
`saleor-createsuperuser`) — Saleor does not auto-migrate.

Key infra gotchas: Azure Postgres needs `azure.extensions` allow-listing before migrations;
`DEBUG=False` requires `ALLOWED_CLIENT_HOSTS` + `SECRET_KEY` or the container crashes at start.

## ADRs / decisions log

1. **Channel-per-vendor** isolation (above).
2. **Dedicated collection slug per channel** (Saleor collections are global).
3. **Provisioning as idempotent scripts** (for now) — explicitly slated to become MCP tools or
   a provisioning portal so onboarding isn't hand-run Node scripts (storefront PROGRESS §3).
4. **Celery beat isolated at 1 replica**, separate from the scalable worker.
5. **Shared Postgres server** with rover-strapi (cost), least-privilege roles per database.
