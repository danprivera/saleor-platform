#!/usr/bin/env node
/**
 * Provisions the RoverChat "Bytes (⬡) top-up" products on the existing
 * `roverchat` Saleor channel (#61, epic #56). These are ONE-TIME purchases that,
 * on ORDER_CREATED, CREDIT the buyer's Bytes wallet rather than provisioning or
 * upgrading a subscription — see roverai-strapi-platform's webhook receiver, which
 * detects `roverstoreProduct: 'chat-tokens'` + `roverstoreBytes` and enqueues the
 * `credit-chat-bytes-from-order` task.
 *
 * Package pricing is the SINGLE source of truth in the dashboard
 * (roverchat-dashboard-web: src/lib/bytes-packages.ts) — keep PACKAGES below in
 * sync with it. Priced to beat Poe ($30/1M compute points) while staying cost-safe
 * on gpt-5; Bytes never expire.
 *
 * Idempotent throughout: every step checks for an existing resource first, and
 * products are matched by their `roverstoreBytes` metadata marker (NOT a search
 * filter — this Saleor instance has documented index lag; see the other provision
 * scripts). Safe to re-run; it updates price/metadata on an existing product.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_ADMIN_EMAIL=... SALEOR_ADMIN_PASSWORD=... \
 *   node scripts/provision-roverchat-bytes.mjs
 */

const SALEOR_API_URL = process.env.SALEOR_API_URL ?? "https://api.rovershop.io/graphql/";
const SALEOR_ADMIN_EMAIL = requireEnv("SALEOR_ADMIN_EMAIL");
const SALEOR_ADMIN_PASSWORD = requireEnv("SALEOR_ADMIN_PASSWORD");

const CHANNEL_SLUG = "roverchat"; // the existing ROVERCHAT channel (chat.rovershop.ai)
const PRODUCT_META_PRODUCT = "roverstoreProduct"; // = "chat-tokens" for all top-ups
const PRODUCT_META_BYTES = "roverstoreBytes"; // the credited Bytes amount (idempotency marker)

// Keep in sync with roverchat-dashboard-web/src/lib/bytes-packages.ts.
const PACKAGES = [
	{ id: "snack", name: "5,000 Bytes ⬡", bytes: 5000, price: "4.99", blurb: "A quick top-up — about 500K tokens of chat." },
	{ id: "fuel", name: "15,000 Bytes ⬡", bytes: 15000, price: "11.99", blurb: "Best value — about 1.5M tokens. Most popular." },
	{ id: "power", name: "40,000 Bytes ⬡", bytes: 40000, price: "27.99", blurb: "For power users — about 4M tokens of chat." },
	{ id: "mega", name: "100,000 Bytes ⬡", bytes: 100000, price: "59.99", blurb: "Maximum headroom — about 10M tokens. Bytes never expire." },
];

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing required env var ${name}`);
		process.exit(1);
	}
	return value;
}

let saleorToken;

async function saleor(query, variables = {}) {
	const response = await fetch(SALEOR_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(saleorToken ? { Authorization: `Bearer ${saleorToken}` } : {}),
		},
		body: JSON.stringify({ query, variables }),
	});
	const json = await response.json();
	if (json.errors) throw new Error(`Saleor GraphQL error: ${JSON.stringify(json.errors)}`);
	return json.data;
}

function assertNoErrors(result, mutationKey, label) {
	const errors = result?.[mutationKey]?.errors;
	if (errors && errors.length > 0) throw new Error(`${label} failed: ${JSON.stringify(errors)}`);
}

function plaintextToEditorJs(text) {
	if (!text) return null;
	return JSON.stringify({ time: Date.now(), blocks: [{ type: "paragraph", data: { text } }], version: "2.22.2" });
}

async function main() {
	console.log("Authenticating to Saleor...");
	const tokenResult = await saleor(
		`mutation TokenCreate($email: String!, $password: String!) {
			tokenCreate(email: $email, password: $password) { token errors { field message } }
		}`,
		{ email: SALEOR_ADMIN_EMAIL, password: SALEOR_ADMIN_PASSWORD },
	);
	assertNoErrors(tokenResult, "tokenCreate", "Saleor auth");
	saleorToken = tokenResult.tokenCreate.token;

	// --- 1. Channel (must already exist — the ROVERCHAT channel) ---
	const channel = (await saleor(`query($slug: String!) { channel(slug: $slug) { id slug } }`, { slug: CHANNEL_SLUG })).channel;
	if (!channel) throw new Error(`Channel "${CHANNEL_SLUG}" not found — expected the existing ROVERCHAT channel`);
	console.log(`Using channel ${channel.slug} (${channel.id})`);

	// --- 2. Product type (non-shippable, no variants) ---
	console.log(`Ensuring product type "Bytes Top-Up" exists...`);
	let productType = (await saleor(`{ productTypes(first: 100) { edges { node { id name } } } }`)).productTypes.edges
		.map((e) => e.node)
		.find((pt) => pt.name === "Bytes Top-Up");
	if (!productType) {
		const created = await saleor(
			`mutation($input: ProductTypeInput!) { productTypeCreate(input: $input) { productType { id name } errors { field message } } }`,
			{ input: { name: "Bytes Top-Up", kind: "NORMAL", hasVariants: false, isShippingRequired: false } },
		);
		assertNoErrors(created, "productTypeCreate", "productTypeCreate");
		productType = created.productTypeCreate.productType;
		console.log(`  created product type ${productType.id}`);
	} else {
		console.log(`  product type already exists: ${productType.id}`);
	}

	// --- 3. Category ---
	console.log(`Ensuring category "Bytes" exists...`);
	let category = (await saleor(`{ categories(first: 100) { edges { node { id name } } } }`)).categories.edges
		.map((e) => e.node)
		.find((c) => c.name === "Bytes");
	if (!category) {
		const created = await saleor(
			`mutation($input: CategoryInput!) { categoryCreate(input: $input) { category { id name } errors { field message } } }`,
			{ input: { name: "Bytes" } },
		);
		assertNoErrors(created, "categoryCreate", "categoryCreate");
		category = created.categoryCreate.category;
		console.log(`  created category ${category.id}`);
	} else {
		console.log(`  category already exists: ${category.id}`);
	}

	// --- 4. Products (idempotent by roverstoreBytes metadata) ---
	console.log("Fetching existing products for idempotency check...");
	const existingProducts = (
		await saleor(`{ products(first: 100, filter: {}) { edges { node { id name metadata { key value } defaultVariant { id } variants { id } } } } }`)
	).products.edges.map((e) => e.node);

	const productIds = [];
	for (const item of PACKAGES) {
		console.log(`Processing "${item.name}" (${item.bytes} Bytes)...`);
		const bytesStr = String(item.bytes);
		const metadata = [
			{ key: PRODUCT_META_PRODUCT, value: "chat-tokens" },
			{ key: PRODUCT_META_BYTES, value: bytesStr },
		];

		let product = existingProducts.find((p) =>
			p.metadata.some((m) => m.key === PRODUCT_META_BYTES && m.value === bytesStr) &&
			p.metadata.some((m) => m.key === PRODUCT_META_PRODUCT && m.value === "chat-tokens"),
		);

		if (!product) {
			const created = await saleor(
				`mutation($input: ProductCreateInput!) {
					productCreate(input: $input) { product { id name defaultVariant { id } variants { id } } errors { field message } }
				}`,
				{
					input: {
						productType: productType.id,
						category: category.id,
						name: item.name,
						slug: `rc-bytes-${item.id}`,
						description: plaintextToEditorJs(item.blurb),
						metadata,
					},
				},
			);
			assertNoErrors(created, "productCreate", `productCreate(${item.name})`);
			product = created.productCreate.product;
			console.log(`  created product ${product.id}`);
		} else {
			// Keep metadata current on a re-run (e.g. bytes/price change).
			await saleor(
				`mutation($id: ID!, $input: [MetadataInput!]!) { updateMetadata(id: $id, input: $input) { errors { field message } } }`,
				{ id: product.id, input: metadata },
			);
			console.log(`  product already exists: ${product.id} (metadata refreshed)`);
		}

		// Variant (single, no inventory tracking).
		let variantId = product.defaultVariant?.id ?? product.variants?.[0]?.id;
		if (!variantId) {
			const createdVariant = await saleor(
				`mutation($input: ProductVariantCreateInput!) { productVariantCreate(input: $input) { productVariant { id } errors { field message } } }`,
				{ input: { product: product.id, sku: `rc-bytes-${item.id}`, trackInventory: false, attributes: [] } },
			);
			assertNoErrors(createdVariant, "productVariantCreate", `productVariantCreate(${item.name})`);
			variantId = createdVariant.productVariantCreate.productVariant.id;
			console.log(`  created variant ${variantId}`);
		} else {
			await saleor(
				`mutation($id: ID!, $input: ProductVariantInput!) { productVariantUpdate(id: $id, input: $input) { productVariant { id } errors { field message } } }`,
				{ id: variantId, input: { trackInventory: false } },
			);
		}

		// Publish on the channel + purchasable.
		const listed = await saleor(
			`mutation($id: ID!, $input: ProductChannelListingUpdateInput!) { productChannelListingUpdate(id: $id, input: $input) { product { id } errors { field message } } }`,
			{ id: product.id, input: { updateChannels: [{ channelId: channel.id, isPublished: true, visibleInListings: true, isAvailableForPurchase: true }] } },
		);
		assertNoErrors(listed, "productChannelListingUpdate", `productChannelListingUpdate(${item.name})`);

		// Price.
		const priced = await saleor(
			`mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) { productVariantChannelListingUpdate(id: $id, input: $input) { variant { id } errors { field message } } }`,
			{ id: variantId, input: [{ channelId: channel.id, price: item.price }] },
		);
		assertNoErrors(priced, "productVariantChannelListingUpdate", `productVariantChannelListingUpdate(${item.name})`);

		console.log(`  listed + priced at $${item.price} on channel ${CHANNEL_SLUG} (grants ${item.bytes} Bytes)`);
		productIds.push(product.id);
	}

	console.log(`\nDone. ${PACKAGES.length} Bytes top-up products live on the "${CHANNEL_SLUG}" channel.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
