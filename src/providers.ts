/**
 * Provider registry for this package. Each entry is registered through the
 * shared factory in src/provider-factory.ts — adding a provider is one entry
 * here (plus catalog data), never a second implementation file.
 */

import type { VerbooProviderConfig } from "./provider-factory.ts";

/** The environment variable this package reads when no credential is stored. */
export const VERBOO_API_KEY_ENV = "VERBOO_API_KEY";

/**
 * Verboo Code — https://code.verboo.ai.
 *
 * Base URL from Verboo's OpenAI-compatible router docs; the `verboo` provider
 * id and `VERBOO_API_KEY` env var match the official Pi integration. The
 * catalog is generated from the same `/models` endpoint (see
 * `scripts/generate-catalog.ts`), so provider and catalog share one source.
 */
export const VERBOO_PROVIDER: VerbooProviderConfig = {
	id: "verboo",
	name: "Verboo Code",
	baseUrl: "https://code.verboo.ai/router/v1",
	envVars: [VERBOO_API_KEY_ENV] as const,
};

export const PROVIDERS: readonly VerbooProviderConfig[] = [VERBOO_PROVIDER];
