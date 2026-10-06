import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import extension, {
  DEFAULT_EXCLUDE,
  discover,
  modelFrom,
  readSettingsFile,
  reasoningFromId,
  resolveConfig,
  rootUrl,
  type ModelDefaults,
} from "../extensions/llama-swap.ts";

const defaults: ModelDefaults = {
  contextWindow: 128000,
  maxTokens: 32768,
  exclude: /image/i,
};

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("discover", () => {
  test("sends the configured API key to /v1/models", async () => {
    let authorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization");
        return Response.json({
          data: [
            {
              id: "qwen3-coder",
              name: "Qwen 3 Coder",
              context_length: 65536,
            },
          ],
        });
      },
    });
    servers.push(server);

    const models = await discover(`${server.url}v1`, defaults, undefined, "sk-test-key");

    expect(authorization ?? "").toBe("Bearer sk-test-key");
    expect(models).toHaveLength(1);
    expect(models[0]?.contextWindow).toBe(65536);
  });

  test("does not send an empty API key", async () => {
    let authorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization");
        return Response.json({ data: [] });
      },
    });
    servers.push(server);

    await discover(`${server.url}v1`, defaults, undefined, "   ");

    expect(authorization).toBeNull();
  });

  test("filters malformed and excluded catalog entries", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          data: [
            null,
            { id: "image-generator" },
            { id: "chat-model", architecture: { input_modalities: ["text", "image"] } },
          ],
        });
      },
    });
    servers.push(server);

    const models = await discover(`${server.url}v1`, defaults);

    expect(models.map((model) => model.id)).toEqual(["chat-model"]);
    expect(models[0]?.input).toEqual(["text", "image"]);
  });
});

describe("configuration", () => {
  test("prefers the environment API key and rejects invalid numeric overrides", () => {
    const config = resolveConfig(
      {
        LLAMA_SWAP_API_KEY: "from-env",
        LLAMA_SWAP_CONTEXT_WINDOW: "-1",
        LLAMA_SWAP_MAX_TOKENS: "not-a-number",
      },
      {
        apiKey: "from-settings",
        contextWindow: 64000,
        maxTokens: 4096,
      },
    );

    expect(config.apiKey).toBe("from-env");
    expect(config.defaults.contextWindow).toBe(64000);
    expect(config.defaults.maxTokens).toBe(4096);
  });

  test("falls back safely for an invalid custom exclude regex", () => {
    const config = resolveConfig({ LLAMA_SWAP_EXCLUDE: "[" });

    expect(config.defaults.exclude).toBe(DEFAULT_EXCLUDE);
  });

  test("reads only validated llama-swap settings", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-llama-swap-"));
    const settingsPath = join(directory, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        "llama-swap": {
          url: "http://router:8080",
          apiKey: "secret",
          contextWindow: 32768,
          exclude: "audio",
          ignored: true,
        },
      }),
    );

    try {
      expect(readSettingsFile(settingsPath)).toEqual({
        url: "http://router:8080",
        provider: undefined,
        apiKey: "secret",
        contextWindow: 32768,
        maxTokens: undefined,
        exclude: "audio",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("registers the authenticated discovered provider", async () => {
  const previous = {
    url: process.env.LLAMA_SWAP_URL,
    apiKey: process.env.LLAMA_SWAP_API_KEY,
  };
  let authorization: string | null = null;
  let discoveryCount = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      authorization = request.headers.get("authorization");
      discoveryCount += 1;
      return Response.json({ data: [{ id: "model", name: `model-${discoveryCount}` }] });
    },
  });
  servers.push(server);

  process.env.LLAMA_SWAP_URL = server.url.href;
  process.env.LLAMA_SWAP_API_KEY = "configured-key";
  let registration: Record<string, unknown> | undefined;

  try {
    await extension({
      registerProvider(_provider: string, config: Record<string, unknown>) {
        registration = config;
      },
    } as never);
  } finally {
    if (previous.url === undefined) delete process.env.LLAMA_SWAP_URL;
    else process.env.LLAMA_SWAP_URL = previous.url;
    if (previous.apiKey === undefined) delete process.env.LLAMA_SWAP_API_KEY;
    else process.env.LLAMA_SWAP_API_KEY = previous.apiKey;
  }

  expect(authorization ?? "").toBe("Bearer configured-key");
  expect(registration?.apiKey).toBe("configured-key");
  expect(registration?.authHeader).toBe(true);
  expect(registration?.models).toEqual([
    expect.objectContaining({ id: "model" }),
  ]);

  const refreshModels = registration?.refreshModels as
    | ((context: { signal?: AbortSignal }) => Promise<unknown>)
    | undefined;
  expect(refreshModels).toBeDefined();
  if (refreshModels) {
    const refreshed = await refreshModels({});
    expect(authorization ?? "").toBe("Bearer configured-key");
    expect(refreshed).toEqual([
      expect.objectContaining({ id: "model", name: "model-2" }),
    ]);
  }
});

test("normalizes root and versioned endpoint URLs", () => {
  expect(rootUrl("http://localhost:8080/")).toBe("http://localhost:8080");
  expect(rootUrl("http://localhost:8080/v1")).toBe("http://localhost:8080");
  expect(rootUrl("http://localhost:8080/api/v1")).toBe("http://localhost:8080/api");
});

test("classifies reasoning families and keeps output within context", () => {
  expect(reasoningFromId("llama-3.1-8b")).toBe(false);
  expect(reasoningFromId("qwen3-coder")).toBe(true);
  expect(reasoningFromId("gemma-4-e4b")).toBe(true);
  expect(reasoningFromId("gpt-oss-20b")).toBe(true);
  expect(reasoningFromId("qwen3-no-thinking")).toBe(false);

  expect(modelFrom({ id: "llama-3.1-8b", context_length: 4096 }, defaults)).toEqual(
    expect.objectContaining({
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 4096,
    }),
  );
});
