# rovershop-saleor-platform — Progress & Next Steps

Companion to [PROJECT.md](./PROJECT.md) and [DEPLOYMENT.md](./DEPLOYMENT.md). Scope: this repo
only; platform-wide status lives in
[rovershop-saleor-storefront/PROGRESS.md](../rovershop-saleor-storefront/PROGRESS.md) (doc of
record).

> **Agents:** treat the Next Steps below as standing tasks — persist them (and anything you
> learn working here) into your session memory so they survive context loss, and update this
> file whenever you finish or reprioritize one.

## Status (2026-07-11)

| Area | Status |
| --- | --- |
| Production deployment (api.rovershop.io / admin.rovershop.io) | ✅ Live |
| Vendor channels | ✅ `illnails` (11 real services as products), `deliajewelry` (6 placeholder products), `default-channel` placeholder catalog |
| Per-channel `featured-products-{channel}` collections | ✅ Done |
| Provisioning pattern | ✅ Proven twice, idempotent (`scripts/provision-*.mjs`) |
| Automated provisioning (MCP tools / portal) | ⏳ Not started — explicit next phase |
| First Saleor app token | ✅ 2026-07-11 — app `rovershop-vendor-dashboard` (`QXBwOjE=`), MANAGE_PRODUCTS + MANAGE_ORDERS, token in Key Vault `rovershop-dashboard-saleor-app-token`; powers dashboard product CRUD (non-expiring, replaces admin-JWT pattern for the dashboard) |
| Product media / blob storage | ✅ **Fixed 2026-07-11** — media upload had never worked: Saleor called `strovershopmediaprod` over plain HTTP → `AccountRequiresHttps`. `AZURE_SSL=True` set on `saleor-api` + `saleor-worker` (revisions `--0000005`). `productMediaCreate` verified working. |

## Next steps

1. **Wrap the provisioning-script pattern as MCP tools and/or a vendor-provisioning portal** so
   onboarding a vendor doesn't require hand-running a bespoke Node script (explicitly called
   out as the next phase; needs its own least-privilege credential pattern rather than a human
   operator's full Key Vault pull — storefront PROGRESS §5.6).
2. Replace Delia Jewelry's placeholder catalog with real inventory when available.
3. Model the provisioning workflow as an idempotent, retryable state machine on
   `vendor.vendorStatus` (rollback/dead-letter semantics — storefront PROGRESS §5.4).
4. Decide the vendor-count threshold at which a single Saleor instance needs sharding
   (storefront PROGRESS §5.5).
5. Tax/compliance integration (Avalara/TaxJar or Saleor tax app) before Phase 2 nears
   production (storefront PROGRESS §5.10).
6. Automated secret rotation for the Saleor admin credentials in
   `rover-technologies-vault`.

## Cross-references

- Platform doc of record + theming-system status:
  [storefront PROGRESS.md](../rovershop-saleor-storefront/PROGRESS.md) (§1b documents both
  vendor onboardings done from this repo; §1d the theming stack awaiting deploy)
- Tenant config source of truth (`vendor.saleorChannel`):
  [roverai-strapi-platform/PROGRESS.md](../roverai-strapi-platform/PROGRESS.md)
- Dashboard that will eventually drive provisioning:
  [rovershop-dashboard-web/PROGRESS.md](../rovershop-dashboard-web/PROGRESS.md)
