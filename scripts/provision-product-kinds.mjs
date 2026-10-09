#!/usr/bin/env node
/**
 * Provisions the shared product kinds (rovershop-dashboard-web#479): one Saleor
 * product type per product behaviour, each carrying its behaviour in the TYPE's
 * metadata (`roverType`), defined in product-kinds.json.
 *
 * Why the type has to say what it is: Saleor's product types are shared by
 * every store, and until now none of them carried any behaviour. Behaviour
 * lived only on each product's own `roverType` metadata, and the only thing a
 * type decided was whether checkout asks for an address. So every script that
 * had to pick a type picked blindly ("the first type with variants"), and that
 * is how Melo Threads' 20 clothing products landed on RoverChat's
 * `bytes-top-up`, a type that never ships (rovershop-dashboard-web#407).
 *
 * With these in place, code that needs a type for a behaviour looks it up by
 * the type's `roverType` metadata, and the storefront can read a product's
 * behaviour from its type when the product itself declares none.
 *
 * Invariant this script enforces: exactly ONE product type carries a given
 * `roverType` value. A second type tagged with the same value would make the
 * lookup ambiguous, so the run refuses rather than picking one. Store-specific
 * types (nail-service, odysseyvr-experience, subscription-plan, ...) stay
 * untagged; their products declare `roverType` themselves.
 *
 * DRY RUN by default; `--apply` writes. Idempotent: an existing type (matched
 * by slug) is checked and only the fields that differ are updated; `kind` and
 * `hasVariants` drift is reported, never changed, because changing either
 * under existing products is not a metadata edit.
 *
 * Usage:
 *   SALEOR_API_URL=https://api.rovershop.io/graphql/ \
 *   SALEOR_API_TOKEN=...            # an app token with MANAGE_PRODUCT_TYPES_AND_ATTRIBUTES
 *     (or SALEOR_ADMIN_EMAIL + SALEOR_ADMIN_PASSWORD) \
 *   node scripts/provision-product-kinds.mjs [--apply]
 */

import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const SALEOR_API_URL = requireEnv("SALEOR_API_URL", "the target GraphQL endpoint, e.g. http://localhost:8000/graphql/");
const KINDS = JSON.parse(readFileSync(new URL("./product-kinds.json", import.meta.url), "utf8")).kinds;
const ROVER_TYPE_KEY = "roverType";
/** The fields compared and, under --apply, corrected on an existing type. */
const UPDATABLE = ["name", "isShippingRequired", "isDigital"];
/** Reported only: changing these under existing products is not safe to automate. */
const REPORT_ONLY = ["kind", "hasVariants"];

function requireEnv(name, hint) {
	const value = process.env[name];
	if (!value) {
		console.error(
			hint
				? `Missing required env var ${name}: set it to ${hint}. It has no default, so a run never targets production by accident.`
				: `Missing required env var ${name}`,
		);
		process.exit(1);
	}
	return value;
}

let saleorToken = process.env.SALEOR_API_TOKEN;

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

async function authenticate() {
	if (saleorToken) return;
	const email = requireEnv("SALEOR_ADMIN_EMAIL");
	const password = requireEnv("SALEOR_ADMIN_PASSWORD");
	const result = await saleor(
		`mutation($email: String!, $password: String!) { tokenCreate(email: $email, password: $password) { token errors { field message } } }`,
		{ email, password },
	);
	assertNoErrors(result, "tokenCreate", "Saleor auth");
	saleorToken = result.tokenCreate.token;
}

const TYPE_FIELDS = `id name slug kind hasVariants isShippingRequired isDigital metadata { key value }`;

async function allProductTypes() {
	const types = [];
	let after = null;
	do {
		const data = await saleor(
			`query($after: String) { productTypes(first: 100, after: $after) { pageInfo { hasNextPage endCursor } edges { node { ${TYPE_FIELDS} } } } }`,
			{ after },
		);
		types.push(...data.productTypes.edges.map((e) => e.node));
		after = data.productTypes.pageInfo.hasNextPage ? data.productTypes.pageInfo.endCursor : null;
	} while (after);
	return types;
}

const roverTypeOf = (type) => type.metadata?.find((m) => m.key === ROVER_TYPE_KEY)?.value;

/** Refuse a definition file that could not be provisioned unambiguously. */
function checkDefinitions() {
	const seen = { roverType: new Set(), slug: new Set() };
	for (const kind of KINDS) {
		for (const field of ["roverType", "slug"]) {
			if (seen[field].has(kind[field])) throw new Error(`product-kinds.json: duplicate ${field} "${kind[field]}"`);
			seen[field].add(kind[field]);
		}
	}
}

async function main() {
	checkDefinitions();
	console.log(`${APPLY ? "APPLY" : "DRY RUN"} against ${SALEOR_API_URL}\n`);
	await authenticate();
	const types = await allProductTypes();
	const counts = { created: 0, updated: 0, ok: 0, drift: 0 };

	// The invariant first, over the whole catalogue: one type per behaviour.
	for (const kind of KINDS) {
		const others = types.filter((t) => roverTypeOf(t) === kind.roverType && t.slug !== kind.slug);
		if (others.length) {
			throw new Error(
				`"${others.map((t) => t.slug).join('", "')}" already carries ${ROVER_TYPE_KEY}=${kind.roverType}; ` +
					`only "${kind.slug}" may. Remove that metadata first - two tagged types make the lookup ambiguous.`,
			);
		}
	}

	for (const kind of KINDS) {
		const existing = types.find((t) => t.slug === kind.slug);
		if (!existing) {
			console.log(`+ ${kind.slug}: create "${kind.name}" (${kind.kind}, ships=${kind.isShippingRequired}, digital=${kind.isDigital}) ${ROVER_TYPE_KEY}=${kind.roverType}`);
			counts.created++;
			if (!APPLY) continue;
			const created = await saleor(
				`mutation($input: ProductTypeInput!) { productTypeCreate(input: $input) { productType { ${TYPE_FIELDS} } errors { field message } } }`,
				{
					input: {
						name: kind.name,
						slug: kind.slug,
						kind: kind.kind,
						hasVariants: kind.hasVariants,
						isShippingRequired: kind.isShippingRequired,
						isDigital: kind.isDigital,
					},
				},
			);
			assertNoErrors(created, "productTypeCreate", `productTypeCreate ${kind.slug}`);
			await tag(created.productTypeCreate.productType.id, kind);
			continue;
		}

		const patch = Object.fromEntries(UPDATABLE.filter((f) => existing[f] !== kind[f]).map((f) => [f, kind[f]]));
		const drift = REPORT_ONLY.filter((f) => existing[f] !== kind[f]);
		const untagged = roverTypeOf(existing) !== kind.roverType;
		for (const f of drift) {
			console.log(`! ${kind.slug}: ${f} is ${existing[f]}, definition says ${kind[f]} - NOT changed (recreate the type by hand if it matters)`);
			counts.drift++;
		}
		if (!Object.keys(patch).length && !untagged) {
			console.log(`= ${kind.slug}: matches`);
			counts.ok++;
			continue;
		}
		console.log(`~ ${kind.slug}: ${[...Object.entries(patch).map(([k, v]) => `${k} -> ${v}`), ...(untagged ? [`${ROVER_TYPE_KEY} -> ${kind.roverType}`] : [])].join(", ")}`);
		counts.updated++;
		if (!APPLY) continue;
		if (Object.keys(patch).length) {
			const updated = await saleor(
				`mutation($id: ID!, $input: ProductTypeInput!) { productTypeUpdate(id: $id, input: $input) { errors { field message } } }`,
				{ id: existing.id, input: patch },
			);
			assertNoErrors(updated, "productTypeUpdate", `productTypeUpdate ${kind.slug}`);
		}
		if (untagged) await tag(existing.id, kind);
	}

	console.log(`\ncreated ${counts.created}, updated ${counts.updated}, unchanged ${counts.ok}, drift reported ${counts.drift}`);
	if (!APPLY) {
		console.log("Dry run: nothing written. Re-run with --apply.");
		return;
	}

	// Read back: every kind present, with its flags and its tag.
	const after = await allProductTypes();
	const wrong = KINDS.filter((kind) => {
		const t = after.find((x) => x.slug === kind.slug);
		return !t || roverTypeOf(t) !== kind.roverType || UPDATABLE.some((f) => t[f] !== kind[f]);
	});
	if (wrong.length) throw new Error(`read-back mismatch: ${wrong.map((k) => k.slug).join(", ")}`);
	console.log(`Read back: all ${KINDS.length} kinds present, tagged and matching.`);
}

async function tag(id, kind) {
	const result = await saleor(
		`mutation($id: ID!, $input: [MetadataInput!]!) { updateMetadata(id: $id, input: $input) { errors { field message } } }`,
		{ id, input: [{ key: ROVER_TYPE_KEY, value: kind.roverType }] },
	);
	assertNoErrors(result, "updateMetadata", `updateMetadata ${kind.slug}`);
}

main().catch((error) => {
	console.error(error.message ?? error);
	process.exit(1);
});
