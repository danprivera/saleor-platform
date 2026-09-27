#!/usr/bin/env node
/**
 * Registers the customer-account webhook (rovershop-storefront#161).
 *
 * Saleor's own customer-email plugins are off on every channel, yet account
 * confirmation is required - so Saleor raises the account events and Strapi
 * (POST /api/webhooks/saleor-account, rover-strapi#183) sends the email,
 * branded as the store that owns the event's channel.
 *
 * AUTH: a custom header, `x-roverstore-webhook-secret`, the way the live
 * rovershop-order-created webhook authenticates (verified: that webhook's
 * customHeaders carry exactly this key). Its OWN secret -
 * SALEOR_ACCOUNT_WEBHOOK_SECRET, Key Vault `saleor-account-webhook-secret` -
 * not the order webhook's: these payloads carry password-reset and deletion
 * tokens.
 *
 * Attached to the "rovershop-vendor-dashboard" local app, like the order
 * webhook. Idempotent: create by name, or update the query, events and header
 * in place. Rerunning is safe.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_ADMIN_EMAIL=... SALEOR_ADMIN_PASSWORD=... \
 *   STRAPI_API_URL=https://api.roverai.io \
 *   SALEOR_ACCOUNT_WEBHOOK_SECRET=... \
 *   node scripts/register-rovershop-account-webhook.mjs
 */

const SALEOR_API_URL = process.env.SALEOR_API_URL ?? "https://api.rovershop.io/graphql/";
const SALEOR_ADMIN_EMAIL = requireEnv("SALEOR_ADMIN_EMAIL");
const SALEOR_ADMIN_PASSWORD = requireEnv("SALEOR_ADMIN_PASSWORD");
const STRAPI_API_URL = process.env.STRAPI_API_URL ?? "https://api.roverai.io";
const SALEOR_ACCOUNT_WEBHOOK_SECRET = requireEnv("SALEOR_ACCOUNT_WEBHOOK_SECRET");

const WEBHOOK_NAME = "rovershop-account-events";
const APP_NAME = "rovershop-vendor-dashboard";
const EVENTS = ["ACCOUNT_CONFIRMATION_REQUESTED", "ACCOUNT_SET_PASSWORD_REQUESTED", "ACCOUNT_DELETE_REQUESTED"];

// The payload arrives as the event's own fields (no `event` wrapper - the same
// shape the order webhook's comment records); __typename says which event.
const SUBSCRIPTION_QUERY = `subscription {
	event {
		__typename
		... on AccountConfirmationRequested {
			redirectUrl
			token
			user { email firstName }
			channel { slug }
		}
		... on AccountSetPasswordRequested {
			redirectUrl
			token
			user { email firstName }
			channel { slug }
		}
		... on AccountDeleteRequested {
			redirectUrl
			token
			user { email firstName }
			channel { slug }
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
	if (json.errors) throw new Error(`Saleor GraphQL error: ${JSON.stringify(json.errors)}`);
	return json.data;
}

function assertNoErrors(result, key, label) {
	const errors = result?.[key]?.errors;
	if (errors && errors.length > 0) throw new Error(`${label} failed: ${JSON.stringify(errors)}`);
}

async function main() {
	const auth = await saleor(
		`mutation($email: String!, $password: String!) { tokenCreate(email: $email, password: $password) { token errors { field message } } }`,
		{ email: SALEOR_ADMIN_EMAIL, password: SALEOR_ADMIN_PASSWORD },
	);
	assertNoErrors(auth, "tokenCreate", "Saleor auth");
	saleorToken = auth.tokenCreate.token;

	const apps = (await saleor(`{ apps(first: 20) { edges { node { id name } } } }`)).apps.edges.map((e) => e.node);
	const app = apps.find((a) => a.name === APP_NAME);
	if (!app) throw new Error(`App "${APP_NAME}" not found`);

	const hooks = (await saleor(`query($id: ID!) { app(id: $id) { webhooks { id name targetUrl } } }`, { id: app.id })).app.webhooks;
	const existing = hooks.find((w) => w.name === WEBHOOK_NAME);
	const targetUrl = `${STRAPI_API_URL}/api/webhooks/saleor-account`;
	const fields = {
		targetUrl,
		asyncEvents: EVENTS,
		isActive: true,
		query: SUBSCRIPTION_QUERY,
		customHeaders: JSON.stringify({ "x-roverstore-webhook-secret": SALEOR_ACCOUNT_WEBHOOK_SECRET }),
	};

	if (!existing) {
		const created = await saleor(
			`mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { webhook { id } errors { field message code } } }`,
			{ input: { name: WEBHOOK_NAME, app: app.id, ...fields } },
		);
		assertNoErrors(created, "webhookCreate", "webhookCreate");
		console.log(`created webhook ${created.webhookCreate.webhook.id} -> ${targetUrl} (${EVENTS.join(", ")})`);
	} else {
		const updated = await saleor(
			`mutation($id: ID!, $input: WebhookUpdateInput!) { webhookUpdate(id: $id, input: $input) { webhook { id } errors { field message code } } }`,
			{ id: existing.id, input: fields },
		);
		assertNoErrors(updated, "webhookUpdate", "webhookUpdate");
		console.log(`updated webhook ${existing.id} -> ${targetUrl} (${EVENTS.join(", ")})`);
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
