#!/usr/bin/env node
/**
 * Smoke: the two Rovermail plans are in the plans channel catalogue, read exactly as the dashboard
 * and storefront read it (public, unauthenticated, filtered on the subscription-tier metadata):
 *   - rovermail-pro: $2.50 USD, 20480 MB; rovermail-basic: $0.99 USD, 1024 MB; both listed with images
 *     and catalogue-only (billed by Stripe Checkout, roverCheckout=stripe);
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
const basic = by("rovermail-basic");
const checks = [
	["Pro listed", !!pro],
	["Pro tier rovermail-pro, product mail", meta(pro, "roverstoreSubscriptionTier") === "rovermail-pro" && meta(pro, "roverstoreProduct") === "mail"],
	["Pro $2.50 USD", price(pro)?.amount === 2.5 && price(pro)?.currency === "USD"],
	["Pro catalogue-only (Stripe checkout)", pro?.isAvailableForPurchase === false && meta(pro, "roverCheckout") === "stripe"],
	["Pro storage 20480 MB", meta(pro, "roverMailStorageMb") === "20480"],
	["Pro has 2 images", (pro?.media ?? []).length === 2],
	["Basic listed", !!basic],
	["Basic tier rovermail-basic, product mail", meta(basic, "roverstoreSubscriptionTier") === "rovermail-basic" && meta(basic, "roverstoreProduct") === "mail"],
	["Basic $0.99 USD", price(basic)?.amount === 0.99 && price(basic)?.currency === "USD"],
	["Basic catalogue-only (Stripe checkout)", basic?.isAvailableForPurchase === false && meta(basic, "roverCheckout") === "stripe"],
	["Basic storage 1024 MB", meta(basic, "roverMailStorageMb") === "1024"],
	["Basic has 2 images", (basic?.media ?? []).length === 2],
	["no stray rovermail or rovermail-free product", !by("rovermail") && !by("rovermail-free") && !nodes.some((n) => ["rovermail", "rovermail-free"].includes(meta(n, "roverstoreSubscriptionTier")))],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
console.log(`OK ${pro.id} ${basic.id} on ${channel}`);
