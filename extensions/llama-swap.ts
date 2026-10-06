import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LlamaSwapModel {
  id: string;
  name?: string;
  architecture?: { input_modalities?: string[] };
  context_length?: number;
}

interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ["text"] | ["text", "image"];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const REASONING_FAMILY = /qwen3|gemma[-_]?4|gpt[-_]?oss|deepseek.*flash/i;
const DISCOVERY_TIMEOUT_MS = 10_000;

export const DEFAULT_EXCLUDE = /image|diffusion|sdxl|flux|krea|lowvram|tts|embedding|embed|whisper|asr|bge|nomic|mxbai|e5|clip/i;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_API_KEY = "llama-swap-local";
// pi-lens-ignore: hardcoded-url -- this is the documented local-server default.
const DEFAULT_URL = "http://localhost:8080";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

function isLlamaSwapModel(value: JsonValue): value is LlamaSwapModel & JsonObject {
  return isJsonObject(value) && typeof value.id === "string" && value.id.length > 0;
}

export function rootUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  // Accept either a host root or a URL already ending in /v1, including
  // deployments mounted below a path such as /api/v1.
  return trimmed.replace(/\/v1$/i, "");
}

// Reasoning is enabled for known reasoning-capable families. Opt out for
// explicit signals:
//   - "-no-thinking" / "nothinking" in the id
//   - "-uncensored" derivatives (an uncensored variant of an otherwise
//     reasoning-capable model never has reasoning on)
// Override per-model in models.json via `providers.<id>.modelOverrides`.
export function reasoningFromId(id: string): boolean {
  if (/(?:^|[-_])no[-_]?thinking(?:[-_]|$)/i.test(id)) return false;
  if (/[-_]uncensored$/i.test(id)) return false;
  return REASONING_FAMILY.test(id);
}

export interface ModelDefaults {
  contextWindow: number;
  maxTokens: number;
  exclude: RegExp;
}

function parseContextWindow(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function modelFrom(m: LlamaSwapModel, defaults: ModelDefaults): ModelEntry {
  const modalities = Array.isArray(m.architecture?.input_modalities)
    ? m.architecture.input_modalities
    : ["text"];
  const input: ["text"] | ["text", "image"] = modalities.includes("image")
    ? ["text", "image"]
    : ["text"];
  const contextWindow = parseContextWindow(m.context_length, defaults.contextWindow);
  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: reasoningFromId(m.id),
    input,
    contextWindow,
    maxTokens: Math.min(defaults.maxTokens, contextWindow),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * Discover models from llama-swap's OpenAI-compatible catalog.
 *
 * llama-swap protects `/v1/models` when `apiKeys` is configured. The provider
 * registration already uses this key for chat requests, but discovery is a
 * separate fetch and must attach the same bearer credential explicitly.
 */
export async function discover(
  url: string,
  defaults: ModelDefaults,
  signal?: AbortSignal,
  apiKey?: string,
): Promise<ModelEntry[]> {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const request: RequestInit = {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
  if (apiKey?.trim()) request.headers = { Authorization: `Bearer ${apiKey}` };
  const response = await fetch(`${url}/models`, request);
  if (!response.ok) {
    throw new Error(`llama-swap: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as JsonValue;
  const data = isJsonObject(payload) && isJsonArray(payload.data) ? payload.data : [];
  return data.flatMap((entry) => {
    if (!isLlamaSwapModel(entry) || defaults.exclude.test(entry.id)) return [];
    return [modelFrom(entry, defaults)];
  });
}

export interface LlamaSwapSettings {
  url?: string;
  provider?: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  exclude?: string;
}

function parseOptionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseOptionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseSettingsSection(section: JsonObject): LlamaSwapSettings {
  return {
    url: parseOptionalString(section.url),
    provider: parseOptionalString(section.provider),
    apiKey: parseOptionalString(section.apiKey),
    contextWindow: parseOptionalNumber(section.contextWindow),
    maxTokens: parseOptionalNumber(section.maxTokens),
    exclude: parseOptionalString(section.exclude),
  };
}

/**
 * Per-machine settings come from the optional top-level "llama-swap" key in
 * the pi agent directory's settings.json (e.g. ~/.pi/agent/settings.json;
 * this file is intentionally not synced between machines). The agent dir is
 * resolved with pi's own getAgentDir(), so PI_CODING_AGENT_DIR is honored —
 * sandboxes like pi-less-yolo mount the agent dir at /pi-agent with HOME
 * pointing elsewhere.
 */
export function readSettingsFile(
  path: string = join(getAgentDir(), "settings.json"),
): LlamaSwapSettings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as JsonValue;
    if (!isJsonObject(raw)) return {};

    const section = raw["llama-swap"];
    return isJsonObject(section) ? parseSettingsSection(section) : {};
  } catch {
    return {};
  }
}

function parsePositiveNumber(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (value?.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function parseConfiguredString(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

function parseExcludePattern(value: string): RegExp {
  try {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    return new RegExp(value, "i");
  } catch {
    return DEFAULT_EXCLUDE;
  }
}

export function resolveConfig(
  env: NodeJS.ProcessEnv,
  settings: LlamaSwapSettings = {},
) {
  const url = rootUrl(parseConfiguredString(env.LLAMA_SWAP_URL ?? settings.url, DEFAULT_URL));
  const providerId = parseConfiguredString(env.LLAMA_SWAP_PROVIDER ?? settings.provider, "llama-swap");
  const apiKey = env.LLAMA_SWAP_API_KEY ?? settings.apiKey ?? DEFAULT_API_KEY;
  const contextWindow =
    parsePositiveNumber(env.LLAMA_SWAP_CONTEXT_WINDOW) ??
    parsePositiveNumber(settings.contextWindow) ??
    DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    parsePositiveNumber(env.LLAMA_SWAP_MAX_TOKENS) ??
    parsePositiveNumber(settings.maxTokens) ??
    DEFAULT_MAX_TOKENS;
  let exclude = DEFAULT_EXCLUDE;
  if (env.LLAMA_SWAP_EXCLUDE) exclude = parseExcludePattern(env.LLAMA_SWAP_EXCLUDE);
  else if (settings.exclude) exclude = parseExcludePattern(settings.exclude);
  return { url, providerId, apiKey, defaults: { contextWindow, maxTokens, exclude } };
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  settings: LlamaSwapSettings = readSettingsFile(),
) {
  return resolveConfig(env, settings);
}

export default async function (pi: ExtensionAPI) {
  const { url, providerId, apiKey, defaults } = readConfig();
  const baseUrl = `${url}/v1`;

  let models: ModelEntry[] = [];
  try {
    models = await discover(baseUrl, defaults, undefined, apiKey);
  } catch (err) {
    // Don't block startup if llama-swap is down; pi will show empty provider.
    console.error(
      "llama-swap extension: discovery failed at",
      baseUrl,
      err instanceof Error ? err.message : String(err),
    );
  }

  const register = () =>
    pi.registerProvider(providerId, {
      name: "llama-swap",
      baseUrl,
      apiKey,
      // Keep authentication explicit for Pi versions/providers that do not
      // infer Authorization from the OpenAI client API key alone.
      authHeader: true,
      api: "openai-completions",
      models,
      async refreshModels({ signal }: { signal?: AbortSignal }) {
        // Pi reapplies models.json modelOverrides above this provider after a
        // refresh, so return fresh server metadata instead of retaining stale
        // names or reasoning flags from the previous catalog.
        models = await discover(baseUrl, defaults, signal, apiKey);
        return models;
      },
    });

  register();
}
