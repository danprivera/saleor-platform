#!/usr/bin/env node
/**
 * Smoke: the two Rovermail plans are in the plans channel catalogue, read exactly as the dashboard
 * and storefront read it (public, unauthenticated, filtered on the subscription-tier metadata):
 *   - rovermail-pro: $2.50 USD, buyable, 20480 MB storage marker, images;
 *   - rovermail-free: $0.00, listed but not buyable (signup-only), 1024 MB, images;
 *   - no stray single-plan `rovermail` product left behind.
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
const by = (slug) => nodes.find((n) => n.slug === slug);
const meta = (p, k) => p?.metadata.find((m) => m.key === k)?.value;
const price = (p) => p?.pricing?.priceRange?.start?.gross;
const pro = by("rovermail-pro");
const free = by("rovermail-free");
const checks = [
	["Pro listed", !!pro],
	["Pro tier rovermail-pro, product mail", meta(pro, "roverstoreSubscriptionTier") === "rovermail-pro" && meta(pro, "roverstoreProduct") === "mail"],
	["Pro $2.50 USD", price(pro)?.amount === 2.5 && price(pro)?.currency === "USD"],
	["Pro buyable", pro?.isAvailableForPurchase === true],
	["Pro storage 20480 MB", meta(pro, "roverMailStorageMb") === "20480"],
	["Pro has 2 images", (pro?.media ?? []).length === 2],
	["Free listed", !!free],
	["Free tier rovermail-free, product mail", meta(free, "roverstoreSubscriptionTier") === "rovermail-free" && meta(free, "roverstoreProduct") === "mail"],
	["Free $0.00", price(free)?.amount === 0],
	["Free not buyable (signup-only)", free?.isAvailableForPurchase === false],
	["Free storage 1024 MB", meta(free, "roverMailStorageMb") === "1024"],
	["Free has 2 images", (free?.media ?? []).length === 2],
	["no stray single-plan rovermail product", !by("rovermail") && !nodes.some((n) => meta(n, "roverstoreSubscriptionTier") === "rovermail")],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log(`OK ${pro.id} ${free.id} on ${channel}`);
