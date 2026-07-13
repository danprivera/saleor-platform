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

## Rover Pay (payments service, added 2026-07-12, LIVE & E2E-verified 2026-07-13)

**Live at `https://api.roverpay.io`** — container app **`rover-pay`** in its **own environment
`rover-pay-env` (rg-rover-pay-prod)** with a private `valkey` sidecar app (APL storage). Runs
the Saleor Stripe payment app — image `ghcr.io/djkato/saleor-app-payment-stripe:0.4.0`
(community dockerization of saleor/saleor-app-payment-stripe; **listens on port 3000**, not
the 3001 its compose example suggests). Env: `SECRET_KEY` (KV `rover-pay-app-secret-key`),
`APL=redis`, `REDIS_URL=redis://valkey:6379/0`, `APP_API_BASE_URL`/`APP_IFRAME_BASE_URL`
(**required** — RedisAPL throws without APP_API_BASE_URL, every request 500s). Installed in
Saleor as app `QXBwOjM=` ("Rover Pay (Stripe sandbox)"), manifest id `app.saleor.stripe` =
the storefront checkout's `stripeGatewayId`; with a channel mapped, the Stripe card UI
automatically replaces the PayLater fallback.

**Why its own environment**: Saleor's SSRF guard (`HTTP_IP_FILTER_ENABLED=True`) blocks
targets resolving to private IPs, and **within an ACA environment every same-env FQDN —
including custom domains CNAME'd to it — resolves internally**. A custom domain alone does
NOT help; the app must live in a different environment (or the filter must be disabled).
Also: Saleor retries `install_app_task` with backoff — a first "Failed to connect to app"
installation attempt can still succeed ~1 min later, leaving a surprise app registration
(poll `appsInstallations` until the row disappears rather than failing on first FAILED).

**Stripe sandbox config**: keys in KV — `rovershop-stripe-sandbox-secret-key` (sk_test, the
app rejects restricted rk_ keys), `-publishable-key` (pk_test), `-api-key` (rk_test, unused by
this app). Config entry "RoverShop sandbox" (Stripe webhook auto-created:
`we_1TsZPZKCiofHBeSmDeYlhHst`) is mapped to **all three channels** so every vendor transacts
through the shared sandbox; per-vendor Stripe accounts come later. Config auth gotcha: the
app's tRPC requires a JWT whose `app` claim matches the app ID — plain admin `tokenCreate`
JWTs are REJECTED; configure via the admin dashboard UI (its iframe gets app-scoped tokens),
or capture that token from the iframe's requests and replay tRPC calls
(`paymentAppConfigurationRouter.paymentConfig.add` / `.mapping.update`; no superjson — raw
JSON in/out; `Origin` header must be the app URL, it builds the Stripe webhook URL).
The app's channel-mapping UI shows no rows on self-hosted installs (its channels fetch comes
back empty) — `mapping.update` works regardless, it only validates the config entry.

**E2E-verified 2026-07-13**: prod storefront checkout with test card 4242→ Stripe
paymentIntent confirmed → Saleor order **Paid** in the vendor dashboard (orders #9/#10,
`stripe-e2e@`/`stripe-prod-e2e@example.com`). Full loop: storefront → Stripe Elements →
rover-pay webhooks → Saleor transaction → dashboard Orders (Fulfill enabled, Mark-as-Paid
correctly hidden).

**Rover Pay evolution plan**: this container is the seed of Rover Pay (roverpay.ai). Path:
fork `saleor/saleor-app-payment-stripe` → `rover-pay` repo; keep the transaction-flow webhook
surface (`PAYMENT_GATEWAY_INITIALIZE_SESSION`, `TRANSACTION_INITIALIZE/PROCESS/...`) and add
processors behind per-vendor configuration entries (the app's config-entry + channel-mapping
model already supports N configs → N channels — exactly the multi-vendor shape needed). The
storefront gateway id can stay `app.saleor.stripe` until the fork renames it (renaming requires
updating the checkout's `stripeGatewayId` + reinstall). Infra TODO: pin `rover-pay` in bicep
(it was created imperatively) and bind api.roverpay.ai when the product brand goes live.

## ⚠️ Provisioning gap found 2026-07-13: shipping-method channel listings

A real payment got stuck ("Almost done…" hang; charged but uncompletable checkout) because the
**Default shipping method had a channel listing (price) only for `default-channel`** — the
vendor channels had zero available shipping methods, so shipping-required checkouts could
never complete. Zone assignment (`addShippingZones` at channelCreate) is **not enough**:
every new channel also needs `shippingMethodChannelListingUpdate` with
`addChannels: [{ channelId, price }]` for each method it should offer. Fixed live for
`deliajewelry`/`illnails` ($0 listings); **add this step to the provisioning scripts/portal.**

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
