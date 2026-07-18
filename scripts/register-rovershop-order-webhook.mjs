#!/usr/bin/env node
/**
 * Registers the ORDER_CREATED webhook that drives automatic vendor
 * provisioning: when a customer completes checkout for a RoverStore
 * subscription product (rovershop channel), Strapi's
 * POST /api/webhooks/saleor-order-created receiver picks it up and enqueues
 * a `provision-vendor-from-order` task.
 *
 * Attached to the existing "rovershop-vendor-dashboard" LOCAL app (id
 * verified live against the real Saleor instance) — confirmed empirically
 * that Saleor's staff tokenCreate auth (the same auth every other
 * provisioning script in this repo already uses) can create/delete
 * webhooks on an existing app; no App-scoped auth token is needed.
 *
 * Idempotent: check-before-create by `name` (webhooks have no slug).
 * Rerunning this script is safe.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_ADMIN_EMAIL=admin@rovershop.io \
 *   SALEOR_ADMIN_PASSWORD=... \
 *   STRAPI_API_URL=https://api.roverai.io \
 *   SALEOR_ORDER_WEBHOOK_SECRET=... \
 *   node scripts/register-rovershop-order-webhook.mjs
 */

const SALEOR_API_URL = process.env.SALEOR_API_URL ?? "https://api.rovershop.io/graphql/";
const SALEOR_ADMIN_EMAIL = requireEnv("SALEOR_ADMIN_EMAIL");
const SALEOR_ADMIN_PASSWORD = requireEnv("SALEOR_ADMIN_PASSWORD");
const STRAPI_API_URL = process.env.STRAPI_API_URL ?? "https://api.roverai.io";
const SALEOR_ORDER_WEBHOOK_SECRET = requireEnv("SALEOR_ORDER_WEBHOOK_SECRET");

const WEBHOOK_NAME = "rovershop-order-created";
// The "rovershop-vendor-dashboard" LOCAL app — reused rather than creating a
// dedicated app, since it's already the first-party app this ecosystem uses
// for server-to-server Saleor access (as opposed to Rover Pay, a THIRDPARTY
// payment-gateway app). Verified live: this id is stable across environments
// only if re-provisioned identically; re-resolved by name below rather than
// hardcoded, so this script stays correct if the id ever differs.
const APP_NAME = "rovershop-vendor-dashboard";

// Saleor subscription-query DSL for the ORDER_CREATED event payload. Verified
// live via webhookDryRun against a real order — the payload the receiver
// gets is exactly `{ order: { ... } }`, no extra `event` wrapper despite the
// `subscription { event { ... on OrderCreated { ... } } }` query shape.
const SUBSCRIPTION_QUERY = `subscription {
	event {
		... on OrderCreated {
			order {
				id
				number
				channel { slug }
				userEmail
				total { gross { amount currency } }
				metadata { key value }
				lines {
					productName
					quantity
					variant {
						id
						sku
						product { metadata { key value } }
					}
				}
			}
		}
	}
}`;

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

	console.log(`Resolving app "${APP_NAME}"...`);
	const apps = (await saleor(`{ apps(first: 20) { edges { node { id name } } } }`)).apps.edges.map((e) => e.node);
	const app = apps.find((a) => a.name === APP_NAME);
	if (!app) {
		throw new Error(`App "${APP_NAME}" not found — expected it to already exist`);
	}
	console.log(`  resolved app: ${app.id}`);

	console.log(`Ensuring webhook "${WEBHOOK_NAME}" exists...`);
	const existingWebhooks = (await saleor(`query($id: ID!) { app(id: $id) { webhooks { id name targetUrl isActive } } }`, {
		id: app.id,
	})).app.webhooks;
	let webhook = existingWebhooks.find((w) => w.name === WEBHOOK_NAME);

	const targetUrl = `${STRAPI_API_URL}/api/webhooks/saleor-order-created`;

	if (!webhook) {
		const created = await saleor(
			`mutation($input: WebhookCreateInput!) {
				webhookCreate(input: $input) { webhook { id name targetUrl isActive } errors { field message code } }
			}`,
			{
				input: {
					name: WEBHOOK_NAME,
					targetUrl,
					app: app.id,
					asyncEvents: ["ORDER_CREATED"],
					isActive: true,
					secretKey: SALEOR_ORDER_WEBHOOK_SECRET,
					query: SUBSCRIPTION_QUERY,
				},
			},
		);
		assertNoErrors(created, "webhookCreate", "webhookCreate");
		webhook = created.webhookCreate.webhook;
		console.log(`  created webhook ${webhook.id} -> ${webhook.targetUrl}`);
	} else {
		console.log(`  webhook already exists: ${webhook.id} -> ${webhook.targetUrl}`);
		if (webhook.targetUrl !== targetUrl) {
			console.warn(`  WARNING: existing targetUrl "${webhook.targetUrl}" differs from expected "${targetUrl}" — not auto-updating; review manually.`);
		}
	}

	console.log("Done.");
	console.log(`  webhook: ${webhook.id}, target: ${targetUrl}, event: ORDER_CREATED`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
