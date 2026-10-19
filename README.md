# @wrenchpilot/pi-llama-swap

A [pi](https://pi.dev) extension that discovers the models available on your
[llama-swap](https://github.com/mostlygeek/llama-swap) server and registers
them as a pi provider — no manual model catalog to maintain.

## Fork note

This package is a community fork of
[`@sidshaytay/pi-llama-swap`](https://www.npmjs.com/package/@sidshaytay/pi-llama-swap).
It preserves the original model discovery and provider behavior while fixing an
API-key header issue: the original discovery request did not send `apiKey` to
`/v1/models`, so protected llama-swap servers returned `401 Unauthorized` and
Pi showed an empty provider. This fork sends the key as
`Authorization: Bearer <apiKey>` during initial discovery and refreshes, and
explicitly enables Pi's provider authentication header.

## Why this extension

- **Model switching never blocks.** Discovery talks only to `/v1/models`; it
  never probes endpoints that would wake a sleeping llama-swap instance.
- **Authenticated discovery works.** The configured `apiKey` is sent as
  `Authorization: Bearer <apiKey>` while reading `/v1/models`, as well as on
  chat-completion requests through Pi's OpenAI-compatible provider.
- **pi starts even when llama-swap doesn't.** If the server is unreachable at
  startup, pi starts with an empty catalog and retries the next time you open
  `/model`.
- **Sensible reasoning and vision defaults.** Reasoning is on for capable
  families and off for `-no-thinking` / `-uncensored` variants. Vision is
  detected from llama-swap's capability reporting.
- **Your tweaks survive refreshes.** Per-model overrides in `models.json` are
  re-applied every time the catalog refreshes.
- **Config lives in Pi's model files.** Endpoint and discovery defaults are
  read from `models.json`; credentials come from Pi's `auth.json`.

## Quick start

1. Install:

   ```sh
   pi install npm:@wrenchpilot/pi-llama-swap
   ```

   To try a pinned version:

   ```sh
   pi install npm:@wrenchpilot/pi-llama-swap@0.1.3
   ```

2. Configure the endpoint and model defaults in
   `~/.pi/agent/models.json`:

   ```json
   {
     "providers": {
       "llama-swap": {
         "baseUrl": "http://llama-swap.example.com/v1",
         "api": "openai-completions",
         "contextWindow": 128000,
         "maxTokens": 32768
       }
     }
   }
   ```

   For a protected server, store its key in `~/.pi/agent/auth.json`:

   ```json
   {
     "llama-swap": {
       "type": "api_key",
       "key": "sk-your-llama-swap-key"
     }
   }
   ```

   Pi uses `~/.pi/agent` by default, or `$PI_CODING_AGENT_DIR` when that
   variable is set. You can also add or update the credential with Pi's
   `/login` command. For an unauthenticated local server, the extension uses
   the harmless placeholder key `llama-swap-local`.

3. Restart pi, then verify:

   ```sh
   pi --list-models 2>&1 | grep -A30 llama-swap
   ```

   You should see the `llama-swap` provider with your chat models. Pick one
   with `/model` in pi.

## Configuration

Put model and endpoint settings under `providers.llama-swap` in Pi's
`models.json`. The extension reads `baseUrl` and its discovery defaults from
that provider entry. `modelOverrides` remains Pi's native way to customize
individual discovered models. The provider-level `contextWindow`, `maxTokens`,
and `exclude` keys are read by this extension as defaults for discovered models.

| `models.json` provider key | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `baseUrl` | `LLAMA_SWAP_URL` | `http://localhost:8080/v1` | llama-swap endpoint; host roots and URLs ending in `/v1` are accepted |
| provider entry name | `LLAMA_SWAP_PROVIDER` | `llama-swap` | provider ID registered in Pi |
| `contextWindow` | `LLAMA_SWAP_CONTEXT_WINDOW` | `128000` | fallback context window for unloaded models |
| `maxTokens` | `LLAMA_SWAP_MAX_TOKENS` | `32768` | default max output tokens per model |
| `exclude` | `LLAMA_SWAP_EXCLUDE` | built-in regex (see below) | RE2-compatible regex of model IDs to hide |

Store the API key in Pi's `auth.json` under the provider ID, or use Pi's
`/login` command. `LLAMA_SWAP_API_KEY` is available when no stored credential
is present; the default placeholder is used if neither is configured.

For CI or a shell-managed setup:

```sh
export LLAMA_SWAP_URL=http://localhost:8080
export LLAMA_SWAP_API_KEY=sk-your-llama-swap-key
```

Environment variables override the corresponding model defaults when Pi loads
the extension. A credential saved in `auth.json` takes precedence over
`LLAMA_SWAP_API_KEY`, matching Pi's credential resolution order.

### Authentication details

llama-swap accepts bearer authentication for protected endpoints. The
extension reads the provider credential from Pi's `auth.json` and sends:

```http
Authorization: Bearer sk-your-llama-swap-key
```

for model discovery. Pi's `openai-completions` implementation uses the stored
credential for chat requests. The key is never written to logs by this
extension. Keep `auth.json` private and out of version control.

### Per-model overrides

The extension registers every model it discovers. To adjust one — thinking
format, compatibility flags, reasoning, or context window — add a
`providers.llama-swap` block to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "llama-swap": {
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsStrictMode": false,
        "maxTokensField": "max_tokens"
      },
      "modelOverrides": {
        "qwen3.6-35b-a3b": {
          "compat": { "thinkingFormat": "qwen-chat-template" }
        },
        "qwen3.5-9b": { "reasoning": false },
        "gemma-4-e4b": { "contextWindow": 131072 }
      }
    }
  }
}
```

Overrides set here are preserved across catalog refreshes.

## How models are classified

- **Reasoning:** enabled for recognized reasoning families (`qwen3`,
  `gemma4`, `gpt-oss`, and `deepseek...flash`). IDs matching
  `-no-thinking`, `nothinking`, or `-uncensored` get reasoning off.
  llama-swap doesn't report reasoning capability over `/v1/models`, so the
  extension uses this heuristic; override any model in `models.json` with
  `"reasoning": true/false`.
- **Vision:** set to `["text", "image"]` when `/v1/models` reports `image` in
  `architecture.input_modalities`.
- **Context window:** taken from `context_length` when the model reports it;
  otherwise the `contextWindow` default applies. The default output limit is
  capped to the discovered context window.
- **Non-chat models are hidden** by the default exclude regex: image and
  diffusion models, TTS, whisper/asr, and common embedding families
  (`bge`, `nomic`, `mxbai`, `e5`, `clip`). Set your own `exclude` to change it.

To make vision and context window reliable even when a model is unloaded,
declare capabilities in llama-swap's `config.yaml`:

```yaml
mymodel:
  capabilities:
    in: [text, image]
    context: 131072
```

## Troubleshooting

**The llama-swap provider is empty or missing.**

- Check that the configured URL is reachable from the machine running pi.
- If llama-swap has `apiKeys` configured, verify `apiKey` or
  `LLAMA_SWAP_API_KEY` is the exact key value, not the literal text
  `Bearer <key>`.
- Check the endpoint directly:

  ```sh
  curl -H "Authorization: Bearer $LLAMA_SWAP_API_KEY" \
    http://your-host:8080/v1/models
  ```

- Open `/model` in pi to refresh. Discovery requests time out after ten
  seconds so a stalled server does not block Pi startup indefinitely.

**A model shows the wrong context window or thinking behavior.**

The model was probably unloaded at discovery time, or its family isn't covered
by the reasoning heuristic. Declare `capabilities.context` in llama-swap's YAML
and/or set `modelOverrides` in `models.json`.

**A model I want isn't listed.**

It matched the exclude regex. Set a custom `exclude` in the `llama-swap`
provider entry in `models.json` or
`LLAMA_SWAP_EXCLUDE`. Patterns use the safe, linear-time RE2 syntax; if a
custom pattern is invalid or uses unsupported syntax, the extension safely
falls back to its built-in exclude list.

## Development

```sh
npm install
npm test
npm run typecheck
```

The package declares `@earendil-works/pi-coding-agent` as a peer dependency;
Pi supplies it when the extension is installed.

## License

[MIT](LICENSE)
