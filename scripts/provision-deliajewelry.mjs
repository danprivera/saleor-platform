#!/usr/bin/env node
/**
 * Provisions:
 *  1. A dedicated Saleor channel + product catalog for Delia Jewelry
 *     (commerce-mode vendor, no Strapi service records — unlike illnails'
 *     booking-mode script, this has no Strapi write-back step).
 *  2. A small generic placeholder catalog on the existing `default-channel`,
 *     fixing the storefront's default/fallback homepage (previously had
 *     zero products/collections).
 *  3. A `featured-products` Collection per channel, published to that
 *     channel — required for the storefront's unauthenticated
 *     ProductListByCollection query to see anything.
 *
 * Idempotent throughout: every create step checks for an existing resource
 * first (by slug for channel/category, by a metadata marker for products,
 * by slug+channel for collections), so reruns update in place rather than
 * duplicating data. Metadata keys are script-scoped (`deliaCatalogSlug` /
 * `defaultCatalogSlug`) so this script's idempotency checks never collide
 * with provision-illnails.mjs's own `legacySourceId` marker if run against
 * the same Saleor instance.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_ADMIN_EMAIL=admin@rovershop.io \
 *   SALEOR_ADMIN_PASSWORD=... \
 *   node scripts/provision-deliajewelry.mjs
 */

const SALEOR_API_URL = process.env.SALEOR_API_URL ?? "https://api.rovershop.io/graphql/";
const SALEOR_ADMIN_EMAIL = requireEnv("SALEOR_ADMIN_EMAIL");
const SALEOR_ADMIN_PASSWORD = requireEnv("SALEOR_ADMIN_PASSWORD");

const DELIA_JEWELRY_PRODUCTS = [
	{
		slug: "classic-chain-necklace",
		name: "Classic Chain Necklace",
		price: "68.00",
		description: "18-inch sterling silver chain with a lobster clasp. Everyday layering piece.",
	},
	{
		slug: "signet-ring",
		name: "Signet Ring",
		price: "84.00",
		description: "Polished sterling silver signet ring with a smooth face, unengraved.",
	},
	{
		slug: "pearl-stud-earrings",
		name: "Pearl Stud Earrings",
		price: "42.00",
		description: "Freshwater pearl studs on sterling silver posts. Hypoallergenic.",
	},
	{
		slug: "cuban-link-bracelet",
		name: "Cuban Link Bracelet",
		price: "76.00",
		description: "7.5-inch sterling silver Cuban link bracelet with a secure clasp.",
	},
	{
		slug: "birthstone-pendant",
		name: "Birthstone Pendant",
		price: "58.00",
		description: "Delicate pendant with a single round-cut birthstone, 16-inch chain included.",
	},
	{
		slug: "huggie-hoop-earrings",
		name: "Huggie Hoop Earrings",
		price: "36.00",
		description: "Small sterling silver huggie hoops, 10mm diameter. Everyday wear.",
	},
];

const DEFAULT_CHANNEL_PRODUCTS = [
	{
		slug: "classic-logo-tee",
		name: "Classic Logo Tee",
		price: "28.00",
		description: "Soft 100% cotton crewneck tee with a minimal chest logo print. Unisex fit, true to size.",
	},
	{
		slug: "canvas-zip-hoodie",
		name: "Canvas Zip Hoodie",
		price: "58.00",
		description: "Midweight cotton-poly fleece zip hoodie with kangaroo pocket. Everyday layering piece.",
	},
	{
		slug: "everyday-cap",
		name: "Everyday Cap",
		price: "24.00",
		description: "Structured six-panel cap with adjustable strap and embroidered logo. One size fits most.",
	},
	{
		slug: "insulated-steel-tumbler",
		name: "Insulated Steel Tumbler",
		price: "22.00",
		description: "20oz double-wall stainless tumbler, keeps drinks cold 24h / hot 8h. Leak-resistant lid.",
	},
	{
		slug: "canvas-tote-bag",
		name: "Canvas Tote Bag",
		price: "18.00",
		description: "Heavyweight 12oz canvas tote with reinforced handles. Fits a laptop and a day's errands.",
	},
	{
		slug: "ceramic-mug",
		name: "Ceramic Mug",
		price: "16.00",
		description: "12oz glossy ceramic mug, dishwasher and microwave safe.",
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

/**
 * Creates (idempotently) a set of products in a given category, channel-lists
 * and prices them, and returns their product ids — for use seeding a
 * `featured-products` collection. Reusable across any channel/category pair.
 */
async function provisionProducts({ products, productType, category, channel, metadataKey }) {
	console.log(`Fetching existing Saleor products for idempotency check (key=${metadataKey})...`);
	const allProductsResult = await saleor(
		`{ products(first: 100, filter: {}) { edges { node { id name metadata { key value } defaultVariant { id } variants { id } } } } }`,
	);
	const existingProducts = allProductsResult.products.edges.map((e) => e.node);

	const productIds = [];

	for (const item of products) {
		console.log(`Processing "${item.name}" (${channel.slug})...`);

		let product = existingProducts.find((p) =>
			p.metadata.some((m) => m.key === metadataKey && m.value === item.slug),
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
						metadata: [{ key: metadataKey, value: item.slug }],
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
				{ input: { product: product.id, sku: `${channel.slug}-${item.slug}`, trackInventory: false, attributes: [] } },
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

		console.log(`  listed + priced at $${item.price} on channel ${channel.slug}`);
		productIds.push(product.id);
	}

	return productIds;
}

/**
 * Creates (idempotently) a `featured-products`-style collection on the given
 * channel, seeded with the given product ids, and publishes it to that
 * channel. Required for the storefront's unauthenticated
 * ProductListByCollection query to see anything — an unpublished collection
 * is invisible to anonymous queries even if it exists.
 *
 * IMPORTANT: Saleor Collections have one global slug and one shared product
 * list across every channel they're listed on — a slug is NOT scoped per
 * channel the way a product's channel listing is (confirmed live: attempting
 * to create a second "featured-products" collection for a different channel
 * fails with "Collection with this Slug already exists"). Each channel that
 * needs its own distinct product set must use its own distinct slug.
 * `default-channel` keeps the plain `featured-products` slug (matches the
 * storefront's existing hardcoded literal, used as the fallback/default
 * tenant experience); every other channel gets `featured-products-<channel>`.
 */
async function provisionFeaturedCollection({ channel, productIds, slug }) {
	console.log(`Ensuring "${slug}" collection exists on channel ${channel.slug}...`);
	let collection = (
		await saleor(`query($slug: String!, $channel: String!) { collection(slug: $slug, channel: $channel) { id } }`, {
			slug,
			channel: channel.slug,
		})
	).collection;

	if (!collection) {
		const created = await saleor(
			`mutation($input: CollectionCreateInput!) {
				collectionCreate(input: $input) { collection { id } errors { field message } }
			}`,
			{
				input: {
					name: "Featured Products",
					slug,
					description: plaintextToEditorJs("A few of our favorites."),
					products: productIds,
				},
			},
		);
		assertNoErrors(created, "collectionCreate", `collectionCreate(${channel.slug})`);
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
	assertNoErrors(published, "collectionChannelListingUpdate", `collectionChannelListingUpdate(${channel.slug})`);
	console.log(`  published collection to channel ${channel.slug}`);
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

	// --- Resolve default-channel (must already exist) ---
	const defaultChannel = (
		await saleor(`query { channel(slug: "default-channel") { id slug } }`)
	).channel;
	if (!defaultChannel) {
		throw new Error("default-channel does not exist — expected it to already be provisioned");
	}
	console.log(`Resolved default-channel: ${defaultChannel.id}`);

	// --- Ensure deliajewelry channel exists ---
	console.log(`Ensuring channel "deliajewelry" exists...`);
	let deliaChannel = (
		await saleor(`query { channel(slug: "deliajewelry") { id slug } }`)
	).channel;

	if (!deliaChannel) {
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
					name: "Delia Jewelry",
					slug: "deliajewelry",
					currencyCode: "USD",
					defaultCountry: "US",
					isActive: true,
					addWarehouses: defaultWarehouse ? [defaultWarehouse.id] : [],
					addShippingZones: defaultShippingZone ? [defaultShippingZone.id] : [],
				},
			},
		);
		assertNoErrors(created, "channelCreate", "channelCreate");
		deliaChannel = created.channelCreate.channel;
		console.log(`  created channel ${deliaChannel.id}`);
	} else {
		console.log(`  channel already exists: ${deliaChannel.id}`);
	}

	// --- Resolve Default Type product type (must already exist) ---
	const productType = (await saleor(`{ productTypes(first: 50) { edges { node { id name } } } }`))
		.productTypes.edges.map((e) => e.node)
		.find((pt) => pt.name === "Default Type");
	if (!productType) {
		throw new Error('"Default Type" product type not found — expected it to already exist');
	}
	console.log(`Resolved product type "Default Type": ${productType.id}`);

	// --- Categories (check-before-create by name) ---
	const existingCategories = (await saleor(`{ categories(first: 100) { edges { node { id name } } } }`))
		.categories.edges.map((e) => e.node);

	async function ensureCategory(name) {
		let category = existingCategories.find((c) => c.name === name);
		if (!category) {
			const created = await saleor(
				`mutation($input: CategoryInput!) {
					categoryCreate(input: $input) { category { id name } errors { field message } }
				}`,
				{ input: { name } },
			);
			assertNoErrors(created, "categoryCreate", `categoryCreate(${name})`);
			category = created.categoryCreate.category;
			console.log(`  created category "${name}" -> ${category.id}`);
		} else {
			console.log(`  category "${name}" already exists: ${category.id}`);
		}
		return category;
	}

	const jewelryCategory = await ensureCategory("Jewelry");
	const merchandiseCategory = await ensureCategory("Merchandise");

	// --- Delia Jewelry catalog ---
	const deliaProductIds = await provisionProducts({
		products: DELIA_JEWELRY_PRODUCTS,
		productType,
		category: jewelryCategory,
		channel: deliaChannel,
		metadataKey: "deliaCatalogSlug",
	});
	await provisionFeaturedCollection({
		channel: deliaChannel,
		productIds: deliaProductIds,
		slug: "featured-products-deliajewelry",
	});

	// --- default-channel catalog (fixes the storefront's fallback homepage) ---
	const defaultProductIds = await provisionProducts({
		products: DEFAULT_CHANNEL_PRODUCTS,
		productType,
		category: merchandiseCategory,
		channel: defaultChannel,
		metadataKey: "defaultCatalogSlug",
	});
	await provisionFeaturedCollection({
		channel: defaultChannel,
		productIds: defaultProductIds,
		slug: "featured-products",
	});

	console.log("Done.");
	console.log(`  deliajewelry channel: ${deliaChannel.id}, ${deliaProductIds.length} products`);
	console.log(`  default-channel: ${defaultChannel.id}, ${defaultProductIds.length} products`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
