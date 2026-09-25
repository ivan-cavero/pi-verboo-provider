/**
 * Resolve the `openai-completions` streaming API factory from the **same
 * `@earendil-works/pi-ai` package instance** the host resolved for this
 * extension's bare-root import — never from a bare subpath specifier.
 *
 * Under the bundled CLI / Node aliases the bare root IS pi's compat entrypoint
 * and already exports `openAICompletionsApi`, so nothing is resolved. Under a
 * sessiond-on-Bun host the bare root resolves to pi-ai's core build (no
 * factory) while a bare subpath resolves to a stale hoisted copy from the
 * extension's own tree; anchoring on the host entrypoint (`process.argv[1]`)
 * pins the derived file URL to the host's module graph.
 *
 * Contract: no bare `@earendil-works/pi-ai/<subpath>` specifier is ever
 * imported from `src/`. When neither the root nor the host-derived candidates
 * provide the factory, resolution fails loudly instead of loading a stale copy.
 */

import * as piAi from "@earendil-works/pi-ai";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** The only pi-ai specifier this package may import. */
export const PI_AI_PACKAGE_SPECIFIER = "@earendil-works/pi-ai";
/** Lazy factory export on compat/lazy entrypoints. */
export const OPENAI_COMPLETIONS_FACTORY_EXPORT = "openAICompletionsApi";
/** Package-relative lazy entrypoint, then the compat entrypoint as fallback. */
export const OPENAI_COMPLETIONS_LAZY_ENTRY = "api/openai-completions.lazy.js";
export const PI_AI_COMPAT_ENTRY = "compat.js";

export type OpenAICompletionsApiFactory = () => ProviderStreams;
export type ModuleNamespace = Record<string, unknown>;

/** Resolution seam; tests inject one to prove the loader binds to the host's instance. */
export interface PiAiLoaderHost {
	readonly namespace: ModuleNamespace;
	resolveSpecifier?(specifier: string): string;
	importModule(url: string): Promise<ModuleNamespace>;
}

/** Thrown when the factory cannot be bound to the host-resolved pi-ai instance. */
export class PiAiStreamingApiResolutionError extends Error {
	readonly resolvedRootUrl?: string;
	readonly attemptedUrls: readonly string[];

	constructor(
		message: string,
		options: { resolvedRootUrl?: string; attemptedUrls?: readonly string[] } = {},
	) {
		super(message);
		this.name = "PiAiStreamingApiResolutionError";
		this.resolvedRootUrl = options.resolvedRootUrl;
		this.attemptedUrls = options.attemptedUrls ?? [];
	}
}

/** Extract the openai-completions factory from a module namespace, if present. */
export function openAICompletionsApiFrom(namespace: unknown): OpenAICompletionsApiFactory | undefined {
	if (namespace === null || typeof namespace !== "object") return undefined;
	const candidate = (namespace as ModuleNamespace)[OPENAI_COMPLETIONS_FACTORY_EXPORT];
	return typeof candidate === "function" ? (candidate as OpenAICompletionsApiFactory) : undefined;
}

// `import.meta.resolve` is absent from bun-types' `ImportMeta`, so read it
// through an explicit shape. Referenced directly so pi's jiti loader can
// rewrite it; Bun/Node expose it at runtime.
function readImportMetaResolve(): ((specifier: string, parent?: string) => string) | undefined {
	if (typeof import.meta.resolve !== "function") return undefined;
	return (specifier, parent) =>
		parent === undefined ? import.meta.resolve(specifier) : import.meta.resolve(specifier, parent);
}

/** File URL of the host process entrypoint (the pi CLI, sessiond, a test runner). */
export function hostAnchorUrl(entry: string | undefined): string | undefined {
	if (typeof entry !== "string" || entry.length === 0) return undefined;
	try {
		return pathToFileURL(entry).href;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a pi-ai specifier the way the host runtime does. `anchorUrl` is the
 * point: an extension-relative resolve returns whatever the extension's own
 * tree holds — exactly the stale copy a host-anchored resolve avoids.
 */
export function resolvePiAiSpecifier(
	specifier: string,
	options: {
		anchorUrl?: string;
		resolve?: (specifier: string, parent?: string) => string;
		fallback?: (specifier: string) => string;
	} = {},
): string {
	const resolve = options.resolve ?? readImportMetaResolve();
	const fallback = options.fallback ?? ((value: string) => createRequire(import.meta.url).resolve(value));
	if (resolve !== undefined) {
		if (options.anchorUrl !== undefined) {
			try {
				const anchored = resolve(specifier, options.anchorUrl);
				if (typeof anchored === "string" && anchored.length > 0) return anchored;
			} catch {
				// Runtimes without parent support fall through to the bare call.
			}
		}
		try {
			const resolved = resolve(specifier);
			if (typeof resolved === "string" && resolved.length > 0) return resolved;
		} catch {
			// Fall through to createRequire — same bare root, same instance.
		}
	}
	return fallback(specifier);
}

const defaultPiAiLoaderHost: PiAiLoaderHost = {
	namespace: piAi as unknown as ModuleNamespace,
	resolveSpecifier: (specifier) => resolvePiAiSpecifier(specifier, { anchorUrl: hostAnchorUrl(process.argv[1]) }),
	importModule: (url) => import(url) as Promise<ModuleNamespace>,
};

/** Cached result of the default-host resolution; injected hosts bypass it. */
let defaultHostCache: OpenAICompletionsApiFactory | undefined;

function loudError(
	rootUrl: string | undefined,
	attemptedUrls: readonly string[],
	lastError: Error | undefined,
): PiAiStreamingApiResolutionError {
	const attempted =
		attemptedUrls.length > 0
			? `Attempted URLs:\n${attemptedUrls.map((url) => `  - ${url}`).join("\n")}`
			: "Attempted URLs: none (package root resolution failed)";
	const message = [
		`Could not resolve "${OPENAI_COMPLETIONS_FACTORY_EXPORT}" from the host-resolved "${PI_AI_PACKAGE_SPECIFIER}" instance.`,
		`Resolved root: ${rootUrl ?? "<unresolved>"}`,
		attempted,
		lastError ? `Last error: ${lastError.message}` : undefined,
		"Refusing to load a stale @earendil-works/pi-ai from the extension's own tree.",
	]
		.filter((line) => line !== undefined)
		.join("\n");
	return new PiAiStreamingApiResolutionError(message, { resolvedRootUrl: rootUrl, attemptedUrls });
}

/**
 * @param host Resolution seam; omit in production.
 * @returns The openai-completions lazy API factory from the host's pi-ai instance.
 * @throws PiAiStreamingApiResolutionError when no candidate can be bound.
 */
export async function resolveOpenAICompletionsApi(host?: PiAiLoaderHost): Promise<OpenAICompletionsApiFactory> {
	const usesDefaultHost = host === undefined;
	if (usesDefaultHost && defaultHostCache) return defaultHostCache;
	const activeHost = host ?? defaultPiAiLoaderHost;

	// 1. Compat root (bundled CLI / Node aliases / compiled binary).
	const fromRoot = openAICompletionsApiFrom(activeHost.namespace);
	if (fromRoot) {
		if (usesDefaultHost) defaultHostCache = fromRoot;
		return fromRoot;
	}

	// 2. Core root: derive file URLs from the host-resolved package root.
	if (typeof activeHost.resolveSpecifier !== "function") throw loudError(undefined, [], undefined);
	let rootUrl: string | undefined;
	try {
		rootUrl = activeHost.resolveSpecifier(PI_AI_PACKAGE_SPECIFIER);
	} catch (error) {
		throw loudError(undefined, [], error instanceof Error ? error : new Error(String(error)));
	}
	if (!rootUrl) throw loudError(undefined, [], undefined);

	// The directory-prefix guard is the same-package-instance assertion: a
	// candidate must stay inside the package the host resolved.
	const rootDir = new URL("./", new URL(rootUrl));
	const candidates = [OPENAI_COMPLETIONS_LAZY_ENTRY, PI_AI_COMPAT_ENTRY].map(
		(entry) => new URL(entry, rootDir).href,
	);
	const attemptedUrls: string[] = [];
	let lastError: Error | undefined;
	for (const candidate of candidates) {
		if (!candidate.startsWith(rootDir.href)) {
			throw loudError(
				rootUrl,
				attemptedUrls,
				new Error(`candidate "${candidate}" escapes the resolved package root "${rootDir.href}"`),
			);
		}
		attemptedUrls.push(candidate);
		try {
			const factory = openAICompletionsApiFrom(await activeHost.importModule(candidate));
			if (factory) {
				if (usesDefaultHost) defaultHostCache = factory;
				return factory;
			}
			lastError = new Error(`"${OPENAI_COMPLETIONS_FACTORY_EXPORT}" is not exported by ${candidate}`);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw loudError(rootUrl, attemptedUrls, lastError);
}
