#!/usr/bin/env node
/**
 * Provisions the standalone Rovermail subscription ($2.00/month) on the
 * `rovershop` plans channel, beside RoverShop's store plans.
 *
 * Modelled exactly like the store plans (provision-rovershop-subscriptions.mjs
 * and the live catalogue): a plain Saleor product on the shared `subscription`
 * kind, category "Plans", one non-shippable variant, priced and listed for
 * purchase on the channel. Saleor has no recurring-billing primitive; the
 * product metadata is what marks it a subscription:
 *
 *   roverType                  = subscription  (storefront cart rule: one plan per order)
 *   roverstoreSubscriptionTier = rovermail     (the order webhook's subscription marker)
 *   roverstoreProduct          = mail          (which platform product to provision)
 *
 * The tier is deliberately NOT starter/pro/enterprise: rover-strapi provisions a
 * personal Rovermail mailbox for it and never a store, so buying it can never
 * grant Pro store features.
 *
 * Idempotent: the product is found by its tier marker (then by slug), never by
 * search, which lags in this instance. Images are attached only when the
 * product has none, so a re-run never duplicates them.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_ADMIN_EMAIL=... SALEOR_ADMIN_PASSWORD=... \   (or SALEOR_TOKEN=<token with MANAGE_PRODUCTS>)
 *   node scripts/provision-rovermail-subscription.mjs
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SALEOR_API_URL = requireEnv("SALEOR_API_URL", "the target GraphQL endpoint, e.g. http://localhost:8000/graphql/");
// Either a staff/app token with MANAGE_PRODUCTS (SALEOR_TOKEN) or admin credentials.
const SALEOR_TOKEN = process.env.SALEOR_TOKEN || "";
const SALEOR_ADMIN_EMAIL = SALEOR_TOKEN ? "" : requireEnv("SALEOR_ADMIN_EMAIL");
const SALEOR_ADMIN_PASSWORD = SALEOR_TOKEN ? "" : requireEnv("SALEOR_ADMIN_PASSWORD");

const CHANNEL_SLUG = process.env.ROVERSHOP_PLANS_CHANNEL || "rovershop";
const TIER_KEY = "roverstoreSubscriptionTier";

export const ROVERMAIL = {
	tier: "rovermail",
	slug: "rovermail",
	name: "Rovermail",
	sku: "rovermail-monthly",
	price: "2.00",
	metadata: [
		{ key: "roverType", value: "subscription" },
		{ key: TIER_KEY, value: "rovermail" },
		{ key: "roverstoreProduct", value: "mail" },
		{ key: "roverBillingInterval", value: "monthly" },
	],
	summary:
		"Your AI powered email, calendar, and notes: your own address at your-name@rovermail.ai, for $2 a month. Rovermail is a standalone plan and does not include RoverShop store features.",
	features: [
		"AI-powered email at your-name@rovermail.ai",
		"Calendar with invites and reminders",
		"Notes, synced with Apple Notes",
		"Rover Vault for your private files",
		"The Rover Assistant for drafts, summaries and triage",
		"The Rovermail iPhone app",
	],
	images: [
		["rovermail-product-1-icon.png", "Rovermail app icon"],
		["rovermail-product-2-wordmark.png", "Rovermail: your AI powered email, calendar, and notes"],
		["rovermail-product-3-features.png", "Rovermail features: email, calendar, notes, Rover Vault, Rover Assistant, iPhone app"],
	],
};

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "rovermail");

function requireEnv(name, hint) {
	const value = process.env[name];
	if (!value) {
		console.error(hint
			? `Missing required env var ${name}: set it to ${hint}. It has no default, so a run never targets production by accident.`
			: `Missing required env var ${name}`);
		process.exit(1);
	}
	return value;
}

let saleorToken;

async function saleor(query, variables = {}) {
	const response = await fetch(SALEOR_API_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(saleorToken ? { Authorization: `Bearer ${saleorToken}` } : {}) },
		body: JSON.stringify({ query, variables }),
	});
	const json = await response.json();
	if (json.errors) throw new Error(`Saleor GraphQL error: ${JSON.stringify(json.errors)}`);
	return json.data;
}

function assertNoErrors(result, key, label) {
	const errors = result?.[key]?.errors;
	if (errors && errors.length > 0) throw new Error(`${label} failed: ${JSON.stringify(errors)}`);
}

/** Paragraph = summary, list = features: the shape the plan cards read (dashboard plan-catalogue.ts). */
export function description(item = ROVERMAIL) {
	return JSON.stringify({
		time: 0,
		blocks: [
			{ type: "paragraph", data: { text: item.summary } },
			{ type: "list", data: { style: "unordered", items: item.features } },
		],
		version: "2.22.2",
	});
}

async function allNodes(field, selection) {
	const nodes = [];
	let after = null;
	for (let page = 0; page < 50; page++) {
		const data = await saleor(
			`query($after: String) { ${field}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } edges { node { ${selection} } } } }`,
			{ after },
		);
		const connection = data?.[field];
		if (!connection || !Array.isArray(connection.edges)) throw new Error(`${field}: unreadable response`);
		nodes.push(...connection.edges.map((e) => e.node));
		if (!connection.pageInfo.hasNextPage) return nodes;
		after = connection.pageInfo.endCursor;
	}
	throw new Error(`${field}: more than 50 pages; refusing to decide on a partial list`);
}

/** GraphQL multipart request (Saleor's file upload). */
async function uploadMedia(productId, file, alt) {
	const bytes = await readFile(join(ASSET_DIR, file));
	const form = new FormData();
	form.append(
		"operations",
		JSON.stringify({
			query: `mutation($product: ID!, $image: Upload!, $alt: String) {
				productMediaCreate(input: { product: $product, image: $image, alt: $alt }) { media { id url } errors { field message } }
			}`,
			variables: { product: productId, image: null, alt },
		}),
	);
	form.append("map", JSON.stringify({ 0: ["variables.image"] }));
	form.append("0", new Blob([bytes], { type: "image/png" }), basename(file));
	const response = await fetch(SALEOR_API_URL, { method: "POST", headers: { Authorization: `Bearer ${saleorToken}` }, body: form });
	const json = await response.json();
	if (json.errors) throw new Error(`productMediaCreate(${file}): ${JSON.stringify(json.errors)}`);
	assertNoErrors(json.data, "productMediaCreate", `productMediaCreate(${file})`);
	return json.data.productMediaCreate.media;
}

async function main() {
	const item = ROVERMAIL;
	if (SALEOR_TOKEN) {
		saleorToken = SALEOR_TOKEN;
	} else {
		const auth = await saleor(
			`mutation($email: String!, $password: String!) { tokenCreate(email: $email, password: $password) { token errors { field message } } }`,
			{ email: SALEOR_ADMIN_EMAIL, password: SALEOR_ADMIN_PASSWORD },
		);
		assertNoErrors(auth, "tokenCreate", "Saleor auth");
		saleorToken = auth.tokenCreate.token;
	}

	const channel = (await saleor(`query($slug: String!) { channel(slug: $slug) { id slug currencyCode } }`, { slug: CHANNEL_SLUG })).channel;
	if (!channel) throw new Error(`channel "${CHANNEL_SLUG}" does not exist; run provision-rovershop-subscriptions.mjs first`);
	if (channel.currencyCode !== "USD") throw new Error(`channel "${CHANNEL_SLUG}" is ${channel.currencyCode}, expected USD`);

	// The same product type and category the store plans use.
	const types = await allNodes("productTypes", "id name metadata { key value }");
	const productType =
		types.find((t) => t.metadata?.some((m) => m.key === "roverType" && m.value === "subscription")) ??
		types.find((t) => t.name === "Subscription Plan");
	if (!productType) throw new Error("no subscription product type; run provision-rovershop-subscriptions.mjs first");
	const category = (await allNodes("categories", "id name")).find((c) => c.name === "Plans");
	if (!category) throw new Error('no "Plans" category; run provision-rovershop-subscriptions.mjs first');

	const products = (await allNodes("products", "id slug metadata { key value } variants { id } media { id }")).filter(
		(p) => !(p.metadata ?? []).some((m) => m.key === "roverMigratedTo"),
	);
	let product =
		products.find((p) => p.metadata.some((m) => m.key === TIER_KEY && m.value === item.tier)) ??
		products.find((p) => p.slug === item.slug);

	const input = { name: item.name, slug: item.slug, category: category.id, description: description(item), metadata: item.metadata };
	if (!product) {
		const created = await saleor(
			`mutation($input: ProductCreateInput!) { productCreate(input: $input) { product { id slug variants { id } media { id } } errors { field message } } }`,
			{ input: { ...input, productType: productType.id } },
		);
		assertNoErrors(created, "productCreate", "productCreate");
		product = created.productCreate.product;
		console.log(`created product ${product.id}`);
	} else {
		const updated = await saleor(
			`mutation($id: ID!, $input: ProductInput!) { productUpdate(id: $id, input: $input) { product { id } errors { field message } } }`,
			{ id: product.id, input },
		);
		assertNoErrors(updated, "productUpdate", "productUpdate");
		console.log(`product exists, updated: ${product.id}`);
	}

	let variantId = product.variants?.[0]?.id;
	if (!variantId) {
		const v = await saleor(
			`mutation($input: ProductVariantCreateInput!) { productVariantCreate(input: $input) { productVariant { id } errors { field message } } }`,
			{ input: { product: product.id, sku: item.sku, name: "Monthly", trackInventory: false, attributes: [] } },
		);
		assertNoErrors(v, "productVariantCreate", "productVariantCreate");
		variantId = v.productVariantCreate.productVariant.id;
		console.log(`created variant ${variantId}`);
	}

	const listed = await saleor(
		`mutation($id: ID!, $input: ProductChannelListingUpdateInput!) { productChannelListingUpdate(id: $id, input: $input) { product { id } errors { field message } } }`,
		{ id: product.id, input: { updateChannels: [{ channelId: channel.id, isPublished: true, visibleInListings: true, isAvailableForPurchase: true }] } },
	);
	assertNoErrors(listed, "productChannelListingUpdate", "productChannelListingUpdate");
	const priced = await saleor(
		`mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) { productVariantChannelListingUpdate(id: $id, input: $input) { variant { id } errors { field message } } }`,
		{ id: variantId, input: [{ channelId: channel.id, price: item.price }] },
	);
	assertNoErrors(priced, "productVariantChannelListingUpdate", "productVariantChannelListingUpdate");
	console.log(`listed + priced at $${item.price}/month on ${CHANNEL_SLUG}`);

	if ((product.media ?? []).length === 0) {
		for (const [file, alt] of item.images) console.log(`image ${(await uploadMedia(product.id, file, alt)).id} <- ${file}`);
	} else {
		console.log(`product already has ${product.media.length} image(s); not re-uploading`);
	}
	console.log(`Done: ${product.id} (${item.slug})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(error.message ?? error);
		process.exit(1);
	});
}
