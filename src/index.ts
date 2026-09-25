/**
 * @ivan-cavero/pi-verboo-provider — Verboo Code provider for pi.
 *
 * Registers every entry in PROVIDERS via the shared OpenAI-compatible factory.
 * The generated fallback catalog is available at startup; pi's Models runtime
 * calls fetchModels (live /models capabilities × generated catalog) on network
 * refreshes, and filterModels prunes models the key cannot use.
 *
 * Registration is native (`pi.registerProvider(provider)`) where supported;
 * on failure it falls back to the legacy `(name, config)` form with env-only
 * auth and warns loudly. Never silent.
 */

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { baselineModels } from "./catalog.ts";
import { createVerbooProvider, type VerbooProviderConfig } from "./provider-factory.ts";
import { PROVIDERS, VERBOO_API_KEY_ENV, VERBOO_PROVIDER } from "./providers.ts";

/**
 * Register a provider on any pi version: the native full-Provider overload
 * where supported, else the documented legacy (name, config) form with
 * env-var auth. The fallback loses stored-credential auth (env only) — a
 * documented limitation of the legacy path, never a silent auth invention.
 */
async function registerVerbooProviderCompat(pi: ExtensionAPI, config: VerbooProviderConfig): Promise<void> {
	let native: Provider<"openai-completions"> | undefined;
	try {
		native = await createVerbooProvider(config);
		pi.registerProvider(native);
		return;
	} catch (error) {
		console.warn(
			`[pi-verboo-provider] native provider registration failed ` +
				`(${error instanceof Error ? error.message : String(error)}); ` +
				"falling back to the legacy config form (env-var auth only).",
		);
	}

	// Legacy config syntax: one env-var reference; first configured var wins.
	const envVar = config.envVars[0];
	const legacy: ProviderConfig = {
		name: config.name,
		baseUrl: config.baseUrl,
		...(envVar ? { apiKey: `$${envVar}` } : {}),
		api: "openai-completions",
		models: baselineModels({ providerId: config.id, baseUrl: config.baseUrl }).map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: [...model.input],
			cost: { ...model.cost },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
			...(model.compat ? { compat: { ...model.compat } } : {}),
		})),
	};
	pi.registerProvider(config.id, legacy);
}

export default async function verbooProviderExtension(pi: ExtensionAPI): Promise<void> {
	for (const config of PROVIDERS) {
		await registerVerbooProviderCompat(pi, config);
	}
}

/** Exposed for tests and advanced consumers. */
export { createVerbooProvider, PROVIDERS, VERBOO_API_KEY_ENV, VERBOO_PROVIDER };
export type { VerbooProviderConfig };
