# pi-incoai

[Inco AI](https://inco.ai) (`inco.ai`) model provider extension for the
[Pi coding agent](https://pi.dev).

Inco serves open-weight models (Kimi K3, GLM 5.3, MiniMax M3, DeepSeek V4.1, …)
over an OpenAI-compatible API at `https://api.inco.ai/v1`. This package registers
the `incoai` provider, adds the public model catalog, and refreshes it from
`GET /v1/models` so workspace/private models show up too.

## Install

```bash
pi install npm:pi-incoai          # from npm
pi install git:github.com/<you>/pi-incoai   # from git
pi install /path/to/pi-incoai     # from a local checkout
```

or try it for one run without installing:

```bash
pi -e /path/to/pi-incoai
```

## Authenticate

1. Create an API key at <https://platform.inco.ai/keys> (it looks like `sk-inco-…`).
2. Either set the environment variable in the shell that starts Pi:

   ```bash
   export INCO_API_KEY=sk-inco-...
   ```

   or sign in interactively:

   ```
   /login
   ```

   Pick **incoai** → *Sign in with an API key* → paste the key. Pi verifies the
   key against `GET /v1/models` before saving it, then refreshes the model
   catalog. Credentials are stored in `~/.pi/agent/auth.json`.

## Use

```
/model            # search for "incoai"
```

```bash
pi --model incoai/kimi-k3 "…"
pi --model incoai/glm-5.3:fast "…"
```

Model IDs keep their `:fast` suffix; Pi resolves the full id before treating a
trailing `:level` as a thinking level.

## Models

The bundled baseline catalog is replaced by the live catalog on refresh. Pricing,
context length, and reasoning support come from `GET /v1/models`.

| Model | Context | Max output | Image input |
|---|---|---|---|
| `kimi-k3` | 1.0M | 131K | yes |
| `kimi-k3:fast` | 1.0M | 131K | yes |
| `deepseek-v4.1-flash` | 1.0M | 384K | yes |
| `deepseek-v4.1-flash:fast` | 1.0M | 384K | yes |
| `glm-5.3` | 1.0M | 131K | no |
| `glm-5.3:fast` | 1.0M | 131K | no |
| `glm-5.3-flash` | 1.0M | 131K | yes |
| `glm-5.3-flash:fast` | 1.0M | 131K | yes |
| `minimax-m3` | 1.0M | 512K | yes |
| `minimax-m3:fast` | 1.0M | 512K | yes |

## Notes

- Inco is prepaid: requests return `402` when the balance is empty.
- Inco exposes both OpenAI Chat Completions and Anthropic Messages. This
  extension uses Chat Completions, the surface its catalog metadata
  (`reasoning_effort`, `reasoning_content`) is documented for.
- Models that advertise `capabilities.reasoning_effort` receive `reasoning_effort`.
  On the others Pi still surfaces streamed `reasoning_content` but sends no effort.
- `--list-models` and `pi auth check` do not load extensions, so they show the
  bundled baseline catalog only. Opening `/model` triggers the live refresh.

## Development

```text
extensions/pi-incoai/index.ts   # the provider extension
```

Pi loads extensions from the `extensions/` directory of a package. Edit the file
and run `/reload` in an active session, or restart Pi. To exercise the catalog
mapping without a key, `GET https://api.inco.ai/v1/models` is public.

## License

MIT
