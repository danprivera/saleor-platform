#!/usr/bin/env node
/**
 * Provisions a dedicated Saleor channel + catalog for a booking-mode vendor
 * from a flat list of services, and links the resulting variant ids back
 * into the corresponding Strapi `service` records.
 *
 * Idempotent: every create step checks for an existing resource first
 * (by slug for channel/warehouse/category, by `legacySourceId` metadata for
 * products), so reruns update in place rather than duplicating data.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_ADMIN_EMAIL=admin@rovershop.io \
 *   SALEOR_ADMIN_PASSWORD=... \
 *   STRAPI_API_URL=https://api.roverai.io \
 *   STRAPI_API_TOKEN=... \
 *   node scripts/provision-illnails.mjs
 */

const SALEOR_API_URL = process.env.SALEOR_API_URL ?? "https://api.rovershop.io/graphql/";
const SALEOR_ADMIN_EMAIL = requireEnv("SALEOR_ADMIN_EMAIL");
const SALEOR_ADMIN_PASSWORD = requireEnv("SALEOR_ADMIN_PASSWORD");
const STRAPI_API_URL = process.env.STRAPI_API_URL ?? "https://api.roverai.io";
const STRAPI_API_TOKEN = requireEnv("STRAPI_API_TOKEN");

const VENDOR_CODE = "illnails";
const CHANNEL_SLUG = "illnails";
const CHANNEL_NAME = "Illmatic Nails";

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

	// --- 2. Product type (check-before-create by name) ---
	console.log(`Ensuring product type "Nail Service" exists...`);
	let productType = (await saleor(`{ productTypes(first: 50) { edges { node { id name } } } }`))
		.productTypes.edges.map((e) => e.node)
		.find((pt) => pt.name === "Nail Service");

	if (!productType) {
		const created = await saleor(
			`mutation($input: ProductTypeInput!) {
				productTypeCreate(input: $input) { productType { id name } errors { field message } }
			}`,
			{ input: { name: "Nail Service", kind: "NORMAL", hasVariants: false, isShippingRequired: false } },
		);
		assertNoErrors(created, "productTypeCreate", "productTypeCreate");
		productType = created.productTypeCreate.productType;
		console.log(`  created product type ${productType.id}`);
	} else {
		console.log(`  product type already exists: ${productType.id}`);
	}

	// --- 3. Categories (check-before-create by name) ---
	const categoryNames = ["Full Sets", "Fills", "Pedicures"];
	const categoryByName = {};
	const existingCategories = (await saleor(`{ categories(first: 100) { edges { node { id name } } } }`))
		.categories.edges.map((e) => e.node);

	for (const name of categoryNames) {
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
		categoryByName[name] = category;
	}

	// --- 4. Fetch Strapi services for illnails ---
	console.log("Fetching illnails services from Strapi...");
	const servicesResponse = await strapi(
		`/api/services?filters[vendor][vendorCode][$eq]=${VENDOR_CODE}&pagination[pageSize]=100`,
	);
	const services = servicesResponse.data;
	console.log(`  found ${services.length} services`);

	// --- 5. Products + variants + channel listings + inventory (per service) ---
	// Fetch all existing products once up front and match by metadata
	// client-side — `filter: { search }` proved unreliable for freshly
	// created products (search-index lag), causing duplicate creates on
	// rerun. An unfiltered listing query doesn't have that problem.
	console.log("Fetching existing Saleor products for idempotency check...");
	const allProductsResult = await saleor(
		`{ products(first: 100, filter: {}) { edges { node { id name metadata { key value } defaultVariant { id } variants { id } } } } }`,
	);
	const existingProducts = allProductsResult.products.edges.map((e) => e.node);

	const linkBack = [];

	for (const service of services) {
		const category = categoryByName[service.category];
		if (!category) {
			console.warn(`  skipping "${service.name}": unrecognized category "${service.category}"`);
			continue;
		}

		console.log(`Processing "${service.name}" (legacySourceId=${service.legacySourceId})...`);

		let product = existingProducts.find((p) =>
			p.metadata.some((m) => m.key === "legacySourceId" && m.value === String(service.legacySourceId)),
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
						name: service.name,
						description: plaintextToEditorJs(service.description),
						metadata: [{ key: "legacySourceId", value: String(service.legacySourceId) }],
					},
				},
			);
			assertNoErrors(created, "productCreate", `productCreate(${service.name})`);
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
				{
					input: {
						product: product.id,
						sku: `${VENDOR_CODE}-${service.slug}`,
						trackInventory: false,
						attributes: [],
					},
				},
			);
			assertNoErrors(createdVariant, "productVariantCreate", `productVariantCreate(${service.name})`);
			variantId = createdVariant.productVariantCreate.productVariant.id;
			console.log(`  created variant ${variantId}`);
		} else {
			// Ensure trackInventory is set correctly even on the auto-created default variant.
			await saleor(
				`mutation($id: ID!, $input: ProductVariantInput!) {
					productVariantUpdate(id: $id, input: $input) { productVariant { id } errors { field message } }
				}`,
				{ id: variantId, input: { trackInventory: false } },
			);
		}

		// Publish product to the illnails channel.
		const listed = await saleor(
			`mutation($id: ID!, $input: ProductChannelListingUpdateInput!) {
				productChannelListingUpdate(id: $id, input: $input) { product { id } errors { field message } }
			}`,
			{
				id: product.id,
				input: {
					updateChannels: [
						{
							channelId: channel.id,
							isPublished: true,
							visibleInListings: true,
							isAvailableForPurchase: true,
						},
					],
				},
			},
		);
		assertNoErrors(listed, "productChannelListingUpdate", `productChannelListingUpdate(${service.name})`);

		// Set variant price on the illnails channel.
		const priced = await saleor(
			`mutation($id: ID!, $input: [ProductVariantChannelListingAddInput!]!) {
				productVariantChannelListingUpdate(id: $id, input: $input) { variant { id } errors { field message } }
			}`,
			{ id: variantId, input: [{ channelId: channel.id, price: String(service.basePrice) }] },
		);
		assertNoErrors(priced, "productVariantChannelListingUpdate", `productVariantChannelListingUpdate(${service.name})`);

		console.log(`  listed + priced at $${service.basePrice} on channel ${CHANNEL_SLUG}`);
		linkBack.push({ documentId: service.documentId, variantId });
	}

	// --- 6. Link Saleor variant ids back into Strapi ---
	console.log("Writing saleorProductVariantId back to Strapi...");
	for (const { documentId, variantId } of linkBack) {
		await strapi(`/api/services/${documentId}`, {
			method: "PUT",
			body: JSON.stringify({ data: { saleorProductVariantId: variantId } }),
		});
		console.log(`  updated service ${documentId} -> ${variantId}`);
	}

	// --- 7. Update vendor.saleorChannel to point at the dedicated channel ---
	console.log("Updating vendor.saleorChannel...");
	const vendorResponse = await strapi(`/api/vendors?filters[vendorCode][$eq]=${VENDOR_CODE}`);
	const vendor = vendorResponse.data[0];
	if (vendor && vendor.saleorChannel !== CHANNEL_SLUG) {
		await strapi(`/api/vendors/${vendor.documentId}`, {
			method: "PUT",
			body: JSON.stringify({ data: { saleorChannel: CHANNEL_SLUG } }),
		});
		console.log(`  updated vendor.saleorChannel: "${vendor.saleorChannel}" -> "${CHANNEL_SLUG}"`);
	} else {
		console.log(`  vendor.saleorChannel already "${CHANNEL_SLUG}"`);
	}

	console.log("Done.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
