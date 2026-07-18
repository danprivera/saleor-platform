#!/usr/bin/env node
/**
 * Provisions RoverShop's own subscription-tier catalog (Starter/Pro/
 * Enterprise) on a dedicated `rovershop` Saleor channel — the products that,
 * once purchased via checkout, trigger automatic new-vendor provisioning
 * (see roverai-strapi-platform's ORDER_CREATED webhook receiver +
 * `provision-vendor-from-order` task, added alongside this script).
 *
 * The `rovershop` channel corresponds to the existing `rovershop`
 * platform-admin vendor in Strapi (store.rovershop.ai) — its
 * `vendor.saleorChannel` field already says "rovershop", but the Saleor
 * channel itself was never actually created; this script creates it.
 *
 * Each product carries a `roverstoreSubscriptionTier` metadata marker
 * (idempotency key AND the field the order-webhook handler reads to
 * determine which tier a completed order purchased). Idempotent throughout:
 * every create step checks for an existing resource first (by slug for
 * channel/product-type/category, by this metadata marker for products —
 * NOT by search filter, which has documented index lag in this Saleor
 * instance per provision-illnails.mjs/provision-deliajewelry.mjs).
 *
 * Also adds a $0 shipping-method-channel-listing for the new channel even
 * though the product type is non-shippable — defensive insurance against
 * the documented "Almost done…" checkout hang incident (see PROGRESS.md)
 * that hit two prior channel launches; whether it's actually required for a
 * non-shippable product type is unverified, so this errs toward safety.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_ADMIN_EMAIL=admin@rovershop.io \
 *   SALEOR_ADMIN_PASSWORD=... \
 *   STRAPI_API_URL=https://api.roverai.io \
 *   STRAPI_API_TOKEN=... \
 *   node scripts/provision-rovershop-subscriptions.mjs
 */

const SALEOR_API_URL = process.env.SALEOR_API_URL ?? "https://api.rovershop.io/graphql/";
const SALEOR_ADMIN_EMAIL = requireEnv("SALEOR_ADMIN_EMAIL");
const SALEOR_ADMIN_PASSWORD = requireEnv("SALEOR_ADMIN_PASSWORD");
const STRAPI_API_URL = process.env.STRAPI_API_URL ?? "https://api.roverai.io";
const STRAPI_API_TOKEN = requireEnv("STRAPI_API_TOKEN");

const CHANNEL_SLUG = "rovershop";
const CHANNEL_NAME = "RoverShop";
const METADATA_KEY = "roverstoreSubscriptionTier";

// Pricing benchmarked against Shopify/BigCommerce's converged 3-tier market
// anchor (Basic ~$29-39, Grow ~$79-105, Advanced ~$299-399/mo); Squarespace
// is priced well below this and isn't the benchmark. See roverai-strapi
// vendor-from-order-provisioning.ts for the matching FeatureFlags mapping.
const TIERS = [
	{
		tier: "starter",
		slug: "rovershop-starter",
		name: "RoverStore Starter",
		price: "29.00",
		description:
			"Everything you need to launch a real online store — products, checkout, and a beautiful storefront in minutes.",
	},
	{
		tier: "pro",
		slug: "rovershop-pro",
		name: "RoverStore Pro",
		price: "79.00",
		description:
			"For growing stores: your own domain, gift cards, a team of staff accounts, and SEO tools to bring in more customers.",
	},
	{
		tier: "enterprise",
		slug: "rovershop-enterprise",
		name: "RoverStore Enterprise",
		price: "299.00",
		description:
			"The full platform: premium storefront templates, SMS customer reminders, recurring subscription billing, and every feature unlocked.",
	},
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
	if (json.errors) {
		throw new Error(`Saleor GraphQL error: ${JSON.stringify(json.errors)}`);
	}
	return json.data;
}

async function strapi(path, options = {}) {
	const response = await fetch(`${STRAPI_API_URL}${path}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${STRAPI_API_TOKEN}`,
			...(options.headers ?? {}),
		},
	});
	const json = await response.json();
	if (!response.ok) {
		throw new Error(`Strapi ${options.method ?? "GET"} ${path} failed: ${JSON.stringify(json)}`);
	}
	return json;
}

function assertNoErrors(result, mutationKey, label) {
	const errors = result?.[mutationKey]?.errors;
	if (errors && errors.length > 0) {
		throw new Error(`${label} failed: ${JSON.stringify(errors)}`);
	}
}

function plaintextToEditorJs(text) {
	if (!text) return null;
	return JSON.stringify({
		time: Date.now(),
		blocks: [{ type: "paragraph", data: { text } }],
		version: "2.22.2",
	});
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

	// --- 1. Channel (check-before-create) ---
	console.log(`Ensuring channel "${CHANNEL_SLUG}" exists...`);
	let channel = (
		await saleor(`query($slug: String!) { channel(slug: $slug) { id slug } }`, { slug: CHANNEL_SLUG })
	).channel;

	if (!channel) {
		const existing = await saleor(
			`{ warehouses(first: 20) { edges { node { id slug } } } shippingZones(first: 20) { edges { node { id name } } } }`,
		);
		const defaultWarehouse = existing.warehouses.edges.find((e) => e.node.slug === "default-warehouse")?.node;
		const defaultShippingZone = existing.shippingZones.edges.find((e) => e.node.name === "Default")?.node;

		const created = await saleor(
			`mutation($input: ChannelCreateInput!) {
				channelCreate(input: $input) { channel { id slug } errors { field message } }
			}`,
			{
				input: {
					name: CHANNEL_NAME,
					slug: CHANNEL_SLUG,
					currencyCode: "USD",
					defaultCountry: "US",
					isActive: true,
					addWarehouses: defaultWarehouse ? [defaultWarehouse.id] : [],
					addShippingZones: defaultShippingZone ? [defaultShippingZone.id] : [],
				},
			},
		);
		assertNoErrors(created, "channelCreate", "channelCreate");
		channel = created.channelCreate.channel;
		console.log(`  created channel ${channel.id}`);
	} else {
		console.log(`  channel already exists: ${channel.id}`);
	}

	// --- 1b. Defensive $0 shipping-method-channel-listing (see file header) ---
	console.log("Ensuring a shipping method is listed on this channel...");
	const shippingZones = (
		await saleor(`{ shippingZones(first: 20) { edges { node { id name shippingMethods { id name } } } } }`)
	).shippingZones.edges.map((e) => e.node);
	const defaultZone = shippingZones.find((z) => z.name === "Default");
	const defaultMethod = defaultZone?.shippingMethods?.[0];
	if (defaultMethod) {
		const listed = await saleor(
			`mutation($id: ID!, $input: ShippingMethodChannelListingInput!) {
				shippingMethodChannelListingUpdate(id: $id, input: $input) {
					shippingMethod { id }
					errors { field message }
				}
			}`,
			{ id: defaultMethod.id, input: { addChannels: [{ channelId: channel.id, price: "0" }] } },
		);
		assertNoErrors(listed, "shippingMethodChannelListingUpdate", "shippingMethodChannelListingUpdate");
		console.log(`  listed shipping method ${defaultMethod.id} on channel at $0`);
	} else {
		console.warn("  no default shipping method found — skipping (checkout may fail if one is actually required)");
	}

	// --- 2. Product type (check-before-create by name) ---
	console.log(`Ensuring product type "Subscription Plan" exists...`);
	let productType = (await saleor(`{ productTypes(first: 50) { edges { node { id name } } } }`))
		.productTypes.edges.map((e) => e.node)
		.find((pt) => pt.name === "Subscription Plan");

	if (!productType) {
		const created = await saleor(
			`mutation($input: ProductTypeInput!) {
				productTypeCreate(input: $input) { productType { id name } errors { field message } }
			}`,
			{ input: { name: "Subscription Plan", kind: "NORMAL", hasVariants: false, isShippingRequired: false } },
		);
		assertNoErrors(created, "productTypeCreate", "productTypeCreate");
		productType = created.productTypeCreate.productType;
		console.log(`  created product type ${productType.id}`);
	} else {
		console.log(`  product type already exists: ${productType.id}`);
	}

	// --- 3. Category (check-before-create by name) ---
	console.log(`Ensuring category "Plans" exists...`);
	let category = (await saleor(`{ categories(first: 100) { edges { node { id name } } } }`))
		.categories.edges.map((e) => e.node)
		.find((c) => c.name === "Plans");

	if (!category) {
		const created = await saleor(
			`mutation($input: CategoryInput!) {
				categoryCreate(input: $input) { category { id name } errors { field message } }
			}`,
			{ input: { name: "Plans" } },
		);
		assertNoErrors(created, "categoryCreate", "categoryCreate");
		category = created.categoryCreate.category;
		console.log(`  created category ${category.id}`);
	} else {
		console.log(`  category already exists: ${category.id}`);
	}

	// --- 4. Products + variants + channel listings + pricing (per tier) ---
	// Fetch all existing products once up front and match by metadata
	// client-side — search-filter idempotency checks have documented index
	// lag in this Saleor instance (see provision-illnails.mjs).
	console.log("Fetching existing Saleor products for idempotency check...");
	const allProductsResult = await saleor(
		`{ products(first: 100, filter: {}) { edges { node { id name metadata { key value } defaultVariant { id } variants { id } } } } }`,
	);
	const existingProducts = allProductsResult.products.edges.map((e) => e.node);

	const productIds = [];

	for (const item of TIERS) {
		console.log(`Processing "${item.name}" (${item.tier})...`);

		let product = existingProducts.find((p) =>
			p.metadata.some((m) => m.key === METADATA_KEY && m.value === item.tier),
		);

		if (!product) {
			const created = await saleor(
				`mutation($input: ProductCreateInput!) {
					productCreate(input: $input) {
						product { id name defaultVariant { id } variants { id } }
						errors { field message }
					}
				}`,
				{
					input: {
						productType: productType.id,
						category: category.id,
						name: item.name,
						slug: item.slug,
						description: plaintextToEditorJs(item.description),
						metadata: [{ key: METADATA_KEY, value: item.tier }],
					},
				},
			);
			assertNoErrors(created, "productCreate", `productCreate(${item.name})`);
			product = created.productCreate.product;
			console.log(`  created product ${product.id}`);
		} else {
			console.log(`  product already exists: ${product.id}`);
		}

		let variantId = product.defaultVariant?.id ?? product.variants?.[0]?.id;
		if (!variantId) {
			const createdVariant = await saleor(
				`mutation($input: ProductVariantCreateInput!) {
					productVariantCreate(input: $input) { productVariant { id } errors { field message } }
				}`,
				{ input: { product: product.id, sku: `rovershop-${item.tier}`, trackInventory: false, attributes: [] } },
			);
			assertNoErrors(createdVariant, "productVariantCreate", `productVariantCreate(${item.name})`);
			variantId = createdVariant.productVariantCreate.productVariant.id;
			console.log(`  created variant ${variantId}`);
		} else {
			await saleor(
				`mutation($id: ID!, $input: ProductVariantInput!) {
					productVariantUpdate(id: $id, input: $input) { productVariant { id } errors { field message } }
				}`,
				{ id: variantId, input: { trackInventory: false } },
			);
		}

		const listed = await saleor(
			`mutation($id: ID!, $input: ProductChannelListingUpdateInput!) {
				productChannelListingUpdate(id: $id, input: $input) { product { id } errors { field message } }
			}`,
			{
				id: product.id,
				input: {
					updateChannels: [
						{ channelId: channel.id, isPublished: true, visibleInListings: true, isAvailableForPurchase: true },
					],
				},
			},
		);
		assertNoErrors(listed, "productChannelListingUpdate", `productChannelListingUpdate(${item.name})`);

		const priced = await saleor(
			`mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) {
				productVariantChannelListingUpdate(id: $id, input: $input) { variant { id } errors { field message } }
			}`,
			{ id: variantId, input: [{ channelId: channel.id, price: item.price }] },
		);
		assertNoErrors(priced, "productVariantChannelListingUpdate", `productVariantChannelListingUpdate(${item.name})`);

		console.log(`  listed + priced at $${item.price}/mo on channel ${CHANNEL_SLUG}`);
		productIds.push(product.id);
	}

	// --- 5. Featured collection (channel-specific slug — Saleor collection
	// slugs are global across channels, confirmed in provision-deliajewelry.mjs) ---
	const collectionSlug = `featured-products-${CHANNEL_SLUG}`;
	console.log(`Ensuring "${collectionSlug}" collection exists on channel ${CHANNEL_SLUG}...`);
	let collection = (
		await saleor(`query($slug: String!, $channel: String!) { collection(slug: $slug, channel: $channel) { id } }`, {
			slug: collectionSlug,
			channel: CHANNEL_SLUG,
		})
	).collection;

	if (!collection) {
		const created = await saleor(
			`mutation($input: CollectionCreateInput!) {
				collectionCreate(input: $input) { collection { id } errors { field message } }
			}`,
			{
				input: {
					name: "Plans",
					slug: collectionSlug,
					description: plaintextToEditorJs("Pick the plan that fits your store."),
					products: productIds,
				},
			},
		);
		assertNoErrors(created, "collectionCreate", "collectionCreate");
		collection = created.collectionCreate.collection;
		console.log(`  created collection ${collection.id}`);
	} else {
		console.log(`  collection already exists: ${collection.id}`);
	}

	const published = await saleor(
		`mutation($id: ID!, $input: CollectionChannelListingUpdateInput!) {
			collectionChannelListingUpdate(id: $id, input: $input) { collection { id } errors { field message } }
		}`,
		{ id: collection.id, input: { addChannels: [{ channelId: channel.id, isPublished: true }] } },
	);
	assertNoErrors(published, "collectionChannelListingUpdate", "collectionChannelListingUpdate");
	console.log(`  published collection to channel ${CHANNEL_SLUG}`);

	// --- 6. Confirm vendor.saleorChannel in Strapi (should already be set) ---
	console.log("Confirming vendor.saleorChannel in Strapi...");
	const vendorResponse = await strapi(`/api/vendors?filters[vendorCode][$eq]=rovershop`);
	const matches = (vendorResponse.data ?? []).filter((v) => v.vendorCode === "rovershop");
	// Never trust "first item in the response" alone — assert the filter
	// actually did its job client-side too, and refuse to guess if it
	// didn't. A prior run of this exact step silently wrote to the wrong
	// vendor (the /api/vendors list endpoint was, at the time, ignoring the
	// filters query param entirely and returning everything) — this is the
	// direct fix for that incident, not a hypothetical concern.
	if (matches.length > 1) {
		throw new Error(`Expected exactly one vendor with vendorCode "rovershop", found ${matches.length}`);
	}
	const vendor = matches[0];
	if (vendor && vendor.saleorChannel !== CHANNEL_SLUG) {
		await strapi(`/api/vendors/${vendor.documentId}`, {
			method: "PUT",
			body: JSON.stringify({ data: { saleorChannel: CHANNEL_SLUG } }),
		});
		console.log(`  updated vendor.saleorChannel: "${vendor.saleorChannel}" -> "${CHANNEL_SLUG}"`);
	} else if (vendor) {
		console.log(`  vendor.saleorChannel already "${CHANNEL_SLUG}"`);
	} else {
		console.warn('  no vendor found with vendorCode "rovershop" — skipping Strapi update');
	}

	console.log("Done.");
	console.log(`  rovershop channel: ${channel.id}, ${productIds.length} products`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
