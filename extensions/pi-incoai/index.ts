/**
 * Inco AI (inco.ai) provider extension for the Pi coding agent.
 *
 * Inco serves open-weight models (Kimi K3, GLM 5.3, MiniMax M3, DeepSeek V4.1,
 * …) through an OpenAI-compatible API at https://api.inco.ai/v1.
 *
 * This extension:
 * - registers the `incoai` provider using pi-ai's OpenAI Chat Completions implementation;
 * - authenticates with `INCO_API_KEY` or `pi`'s `/login incoai` flow, verifying the
 *   key against `GET /v1/models` before it is stored;
 * - ships a baseline catalog of the public models, refreshed from `GET /v1/models`
 *   (the live catalog also includes private/workspace models when a key is configured).
 */

import {
	createProvider,
	envApiKeyAuth,
	openAICompletionsApi,
	type ApiKeyAuth,
	type Model,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "incoai";
const PROVIDER_NAME = "incoai";
const BASE_URL = "https://api.inco.ai/v1";
const MODELS_URL = `${BASE_URL}/models`;

const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 131_072;

/** One entry of `GET /v1/models` (fields are optional; the API may omit them). */
interface IncoCatalogEntry {
	id: string;
	name?: string;
	context_length?: number;
	pricing?: {
		input?: number;
		cached_input?: number;
		output?: number;
	};
	capabilities?: {
		reasoning_effort?: boolean;
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
}

/**
 * Metadata the Inco catalog does not report, kept per model id.
 *
 * `maxTokens` and text/image support are not part of `GET /v1/models`, so this
 * supplies conservative values and fills gaps when `modalities` is absent.
 */
interface CuratedModel {
	maxTokens: number;
	input: ("text" | "image")[];
}

const CURATED: Record<string, CuratedModel> = {
	"kimi-k3": { maxTokens: 131_072, input: ["text", "image"] },
	"kimi-k3:fast": { maxTokens: 131_072, input: ["text", "image"] },
	"deepseek-v4.1-flash": { maxTokens: 384_000, input: ["text", "image"] },
	"deepseek-v4.1-flash:fast": { maxTokens: 384_000, input: ["text", "image"] },
	"glm-5.3": { maxTokens: 131_072, input: ["text"] },
	"glm-5.3:fast": { maxTokens: 131_072, input: ["text"] },
	"glm-5.3-flash": { maxTokens: 131_072, input: ["text", "image"] },
	"glm-5.3-flash:fast": { maxTokens: 131_072, input: ["text", "image"] },
	"minimax-m3": { maxTokens: 512_000, input: ["text", "image"] },
	"minimax-m3:fast": { maxTokens: 512_000, input: ["text", "image"] },
};

/**
 * Snapshot of the public catalog, used as the baseline model list so models
 * appear immediately. A successful `GET /v1/models` refresh replaces entries
 * with the same id and adds any workspace-private models.
 */
const CATALOG_SNAPSHOT: IncoCatalogEntry[] = [
	{ id: "kimi-k3", name: "Kimi K3", context_length: 1048576, pricing: { input: 3, cached_input: 0.3, output: 15 }, capabilities: { reasoning_effort: true } },
	{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1048576, pricing: { input: 0.3, cached_input: 0.006, output: 1.2 }, capabilities: { reasoning_effort: true } },
	{ id: "glm-5.3-flash", name: "GLM 5.3 Flash", context_length: 1048576, pricing: { input: 0.15, cached_input: 0.03, output: 0.5 }, capabilities: { reasoning_effort: false } },
	{ id: "kimi-k3:fast", name: "Kimi K3 (Fast)", context_length: 1048576, pricing: { input: 6, cached_input: 0.6, output: 30 }, capabilities: { reasoning_effort: false } },
	{ id: "deepseek-v4.1-flash:fast", name: "DeepSeek V4.1 Flash (Fast)", context_length: 1048576, pricing: { input: 0.6, cached_input: 0.012, output: 2.4 }, capabilities: { reasoning_effort: false }, modalities: { input: ["text", "image"] } },
	{ id: "glm-5.3", name: "GLM 5.3", context_length: 1048576, pricing: { input: 1.4, cached_input: 0.26, output: 4.4 }, capabilities: { reasoning_effort: true } },
	{ id: "glm-5.3:fast", name: "GLM 5.3 (Fast)", context_length: 1048576, pricing: { input: 2.8, cached_input: 0.52, output: 8.8 }, capabilities: { reasoning_effort: false } },
	{ id: "glm-5.3-flash:fast", name: "GLM 5.3 Flash (Fast)", context_length: 1048576, pricing: { input: 0.15, cached_input: 0.03, output: 0.5 }, capabilities: { reasoning_effort: false }, modalities: { input: ["text", "image"] } },
	{ id: "minimax-m3", name: "MiniMax M3", context_length: 1048576, pricing: { input: 0.3, cached_input: 0.06, output: 1.2 }, capabilities: { reasoning_effort: true }, modalities: { input: ["text", "image"] } },
	{ id: "minimax-m3:fast", name: "MiniMax M3 (Fast)", context_length: 1048576, pricing: { input: 0.6, cached_input: 0.12, output: 2.4 }, capabilities: { reasoning_effort: false }, modalities: { input: ["text", "image"] } },
];

/** Ids in the bundled snapshot; any other catalog id comes from the live API. */
const BUNDLED_MODEL_IDS = new Set(CATALOG_SNAPSHOT.map((entry) => entry.id));

/** Build an error from a failed catalog response, preferring Inco's error envelope. */
async function catalogError(response: Response): Promise<Error> {
	const status = `HTTP ${response.status} ${response.statusText}`.trim();
	let message = `Inco model catalog request failed: ${status}`;
	try {
		const body = (await response.json()) as { error?: { message?: string; code?: string } };
		const detail = body?.error?.message;
		const code = body?.error?.code;
		if (detail) {
			message = `Inco model catalog request failed: ${status}${code ? ` (${code})` : ""} - ${detail}`;
		}
	} catch {
		// Non-JSON error body; keep the status line.
	}
	return new Error(message);
}

/** Authenticated (or public) catalog request, used by both login and refresh. */
function requestCatalog(apiKey: string | undefined, signal: AbortSignal): Promise<Response> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return fetch(MODELS_URL, { headers, signal });
}

function isInputModality(value: string): value is "text" | "image" {
	return value === "text" || value === "image";
}

/** Resolve the input modalities the catalog reports, falling back to curated metadata. */
function resolveInput(entry: IncoCatalogEntry, curated: CuratedModel | undefined): ("text" | "image")[] {
	const reported = entry.modalities?.input?.filter(isInputModality) ?? [];
	if (reported.length === 0) {
		return curated?.input ?? ["text"];
	}
	return reported.includes("text") ? reported : (["text", ...reported] as ("text" | "image")[]);
}

/** Convert one Inco catalog entry into a Pi chat model. */
function toModel(entry: IncoCatalogEntry): Model<"openai-completions"> {
	const curated = CURATED[entry.id];
	const reasoningEffort = entry.capabilities?.reasoning_effort === true;
	return {
		id: entry.id,
		name: entry.name || entry.id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		reasoning: true,
		input: resolveInput(entry, curated),
		cost: {
			input: entry.pricing?.input ?? 0,
			output: entry.pricing?.output ?? 0,
			cacheRead: entry.pricing?.cached_input ?? 0,
			cacheWrite: 0,
		},
		contextWindow: entry.context_length ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: curated?.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat: {
			// Inco is not OpenAI: send only fields its OpenAI-compatible surface documents.
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: reasoningEffort,
			supportsUsageInStreaming: true,
			maxTokensField: "max_completion_tokens",
			// Inco returns reasoning in `reasoning_content` and expects it replayed.
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "openai",
		},
	};
}

/** Sort models alphabetically by display name, falling back to id to break ties. */
function sortModels<T extends { name: string; id: string }>(models: readonly T[]): T[] {
	return [...models].sort((a, b) => {
		const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
		return byName !== 0 ? byName : a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true });
	});
}

/**
 * Order the catalog with models that are not part of the bundled snapshot (new
 * public releases, workspace/private models) first, then the bundled catalog,
 * each group sorted alphabetically.
 *
 * `createProvider` merges the live overlay after the bundled baseline and
 * appends ids that are absent from it, so without this new models would sit at
 * the bottom of `/model`.
 */
function orderModels<T extends { name: string; id: string }>(models: readonly T[]): T[] {
	const live: T[] = [];
	const bundled: T[] = [];
	for (const model of models) {
		(BUNDLED_MODEL_IDS.has(model.id) ? bundled : live).push(model);
	}
	return [...sortModels(live), ...sortModels(bundled)];
}

/** Fetch the live catalog, authenticating when a key is available. */
async function fetchIncoModels(context: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
	const response = await requestCatalog(apiKey, context.signal);
	if (!response.ok) {
		throw await catalogError(response);
	}

	const payload = (await response.json()) as { data?: IncoCatalogEntry[] };
	const entries = Array.isArray(payload?.data) ? payload.data : [];
	if (entries.length === 0) {
		throw new Error("Inco model catalog returned no models");
	}

	return orderModels(entries.filter((entry) => entry && typeof entry.id === "string").map(toModel));
}

/**
 * Standard api-key auth plus a login that verifies the key against the catalog
 * before Pi persists it, so a typo fails in the login dialog instead of on the
 * first message.
 */
function incoApiKeyAuth(): ApiKeyAuth {
	const standard = envApiKeyAuth("Inco AI API key", ["INCO_API_KEY"]);
	return {
		...standard,
		async login(interaction) {
			if (!standard.login) {
				throw new Error("Inco AI API key login is unavailable");
			}
			const credential = await standard.login(interaction);
			const key = credential.key?.trim();
			if (!key) {
				throw new Error("No API key provided");
			}
			interaction.notify({ type: "progress", message: "Verifying API key…" });
			const response = await requestCatalog(key, interaction.signal);
			if (!response.ok) {
				throw await catalogError(response);
			}
			await response.arrayBuffer();
			return { ...credential, key };
		},
	};
}

export default function incoProviderExtension(pi: ExtensionAPI): void {
	const provider = createProvider({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		auth: { apiKey: incoApiKeyAuth() },
		models: sortModels(CATALOG_SNAPSHOT.map(toModel)),
		api: openAICompletionsApi(),
		fetchModels: fetchIncoModels,
	});

	// Pi merges the live catalog after the bundled baseline, which would place new
	// and workspace/private models last. Expose the ordered catalogs instead.
	pi.registerProvider({
		...provider,
		getModels: () => orderModels(provider.getModels()),
		getAllModels: () => orderModels(provider.getModels()),
	});
}
