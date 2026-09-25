/**
 * Shared factory for the Verboo Code provider.
 *
 * One implementation, N provider configs. The resulting provider follows
 * pi-ai's built-in provider shape: `createProvider` + `envApiKeyAuth` + the
 * openai-completions streaming API, with a `fetchModels` overlay that merges
 * Verboo's live `/models` capabilities with the generated fallback catalog and
 * a `filterModels` that keeps only what the key can actually use.
 *
 * pi-ai import rule: extensions must statically import ONLY the bare
 * `@earendil-works/pi-ai` root. Streaming API resolution (which needs the
 * host's package instance on some runtimes) lives in src/pi-ai-loader.ts.
 */

import * as piAi from "@earendil-works/pi-ai";
import type { Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
	baselineModels,
	DEFAULT_MODELS_TIMEOUT_MS,
	resolveCatalog,
	type CatalogSource,
} from "./catalog.ts";
import { resolveOpenAICompletionsApi } from "./pi-ai-loader.ts";
import { withVerbooErrorClassification } from "./verboo-errors.ts";

export interface VerbooProviderConfig {
	/** Provider id as registered in pi, e.g. "verboo". */
	id: string;
	/** Display name shown in /login and the model selector, e.g. "Verboo Code". */
	name: string;
	/** OpenAI-compatible base URL including version path. */
	baseUrl: string;
	/** Env vars consulted (in order) when no credential is stored. */
	envVars: readonly string[];
}

export interface VerbooProviderOptions {
	/** Timeout for the live /models fetch. Default: 3000ms. */
	timeoutMs?: number;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Build a complete pi-ai Provider for Verboo:
 *
 * - auth: `envApiKeyAuth` — the stored credential key wins, then the first set
 *   env var resolves; `/login verboo` prompts for the key.
 * - models: the generated fallback catalog as the static baseline, available
 *   with zero network.
 * - fetchModels: Verboo's live `/models` capabilities × generated data; falls
 *   back to the baseline when the endpoint is unreachable.
 * - filterModels: once a live fetch succeeds, only live ids are offered — the
 *   authoritative per-key list.
 * - api: openai-completions resolved from the host's pi-ai instance
 *   (src/pi-ai-loader.ts), wrapped so documented Verboo errors surface as
 *   overflow or an actionable message (src/verboo-errors.ts).
 */
export async function createVerbooProvider(
	config: VerbooProviderConfig,
	options: VerbooProviderOptions = {},
): Promise<Provider<"openai-completions">> {
	const apiFactory = await resolveOpenAICompletionsApi();
	const source: CatalogSource = { providerId: config.id, baseUrl: config.baseUrl };

	// Last successful live /models result, shared between fetchModels (writes)
	// and filterModels (reads). When set it is authoritative for what the key
	// can use.
	let liveIds: Set<string> | undefined;

	// `envApiKeyAuth` is verified exported from the bare root in pi-ai 0.87.1
	// (typeof piAi.envApiKeyAuth === "function"); no local equivalent is needed.
	return piAi.createProvider({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		auth: { apiKey: piAi.envApiKeyAuth(`${config.name} API key`, config.envVars) },
		models: baselineModels(source),
		fetchModels: async (context: RefreshModelsContext) => {
			const credential = context.credential;
			const resolved = await resolveCatalog(source, {
				apiKey: credential?.type === "api_key" ? credential.key : undefined,
				timeoutMs: options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS,
				fetchImpl: options.fetchImpl,
			});
			liveIds = resolved.liveIds;
			return resolved.models;
		},
		filterModels: (models) => {
			// Snapshot: TS can't prove `liveIds` unchanged across the closure boundary.
			const current = liveIds;
			return current ? models.filter((model) => current.has(model.id)) : models;
		},
		api: withVerbooErrorClassification(apiFactory()),
	});
}
