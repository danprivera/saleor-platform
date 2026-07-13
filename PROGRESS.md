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

## Rover Pay (payments container, added 2026-07-12)

Container app **`rover-pay`** (rg-rover-saleor-prod, `rover-ai-env`) runs the Saleor Stripe
payment app — image `ghcr.io/djkato/saleor-app-payment-stripe:0.4.0` (community dockerization
of saleor/saleor-app-payment-stripe; **listens on port 3000**, not the 3001 its compose example
suggests). Env: `SECRET_KEY` (KV `rover-pay-app-secret-key`), `APL=redis`,
`REDIS_URL=redis://valkey:6379/5`, `APP_API_BASE_URL`/`APP_IFRAME_BASE_URL`. Custom domain
**pay.rovershop.io** (CNAME + `asuid.pay` TXT at the registrar) because Saleor's SSRF guard
(`HTTP_IP_FILTER_ENABLED=True`) blocks same-environment FQDNs, which resolve to private IPs —
app installs/webhooks require a publicly-resolving host. Manifest id `app.saleor.stripe`
matches the storefront checkout's `stripeGatewayId`; when a channel has a mapped config the
checkout's Stripe card UI automatically replaces the PayLater fallback.

**Stripe sandbox config**: keys in KV — `rovershop-stripe-sandbox-secret-key` (sk_test, the
app rejects restricted rk_ keys), `-publishable-key` (pk_test), `-api-key` (rk_test, unused by
this app). Config entry "RoverShop sandbox" is mapped to every channel so all vendors test
through the shared sandbox; per-vendor Stripe accounts come later. Configuration is scriptable:
the app's tRPC (`/api/trpc/paymentConfig.add`, `mapping.update`) accepts a Saleor staff JWT via
`authorization-bearer` + `saleor-api-url` headers (needs MANAGE_APPS + MANAGE_SETTINGS; the
`Origin` header must be the app URL — it's used to build the auto-created Stripe webhook).

**Rover Pay evolution plan**: this container is the seed of Rover Pay (roverpay.ai). Path:
fork `saleor/saleor-app-payment-stripe` → `rover-pay` repo; keep the transaction-flow webhook
surface (`PAYMENT_GATEWAY_INITIALIZE_SESSION`, `TRANSACTION_INITIALIZE/PROCESS/...`) and add
processors behind per-vendor configuration entries (the app's config-entry + channel-mapping
model already supports N configs → N channels — exactly the multi-vendor shape needed). The
storefront gateway id can stay `app.saleor.stripe` until the fork renames it (renaming requires
updating the checkout's `stripeGatewayId` + reinstall). Infra TODO: pin `rover-pay` in bicep
(it was created imperatively) and bind api.roverpay.ai when the product brand goes live.

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
