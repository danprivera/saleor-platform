#!/usr/bin/env node
/**
 * Smoke: the Rovermail plan is in the plans channel catalogue at $2.00 USD and
 * buyable, read exactly as the dashboard and storefront read it (public,
 * unauthenticated storefront query filtered on the subscription-tier metadata).
 *
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ node scripts/smoke-rovermail-plan.mjs
 */
const url = process.env.SALEOR_API_URL;
if (!url) {
	console.error("Missing SALEOR_API_URL");
	process.exit(2);
}
const channel = process.env.ROVERSHOP_PLANS_CHANNEL || "rovershop";
const query = `query($channel: String!) {
  products(first: 50, channel: $channel, where: { metadata: [{ key: "roverstoreSubscriptionTier" }] }) {
    edges { node { id name slug isAvailableForPurchase metadata { key value } media { url }
      pricing { priceRange { start { gross { amount currency } } } } } }
  }
}`;
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { channel } }) });
const json = await res.json();
if (json.errors) throw new Error(JSON.stringify(json.errors));
const nodes = json.data.products.edges.map((e) => e.node);
const p = nodes.find((n) => n.slug === "rovermail");
const meta = (k) => p?.metadata.find((m) => m.key === k)?.value;
const gross = p?.pricing?.priceRange?.start?.gross;
const checks = [
	["product listed in channel", !!p],
	["tier metadata = rovermail", meta("roverstoreSubscriptionTier") === "rovermail"],
	["roverType = subscription", meta("roverType") === "subscription"],
	["roverstoreProduct = mail", meta("roverstoreProduct") === "mail"],
	["available for purchase", p?.isAvailableForPurchase === true],
	["price is 2.00 USD", gross?.amount === 2 && gross?.currency === "USD"],
	["has images", (p?.media ?? []).length >= 2],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log(`OK ${p.id} on ${channel}`);
