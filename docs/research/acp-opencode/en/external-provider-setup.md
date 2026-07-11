# OpenCode ACP external provider setup

- **Date:** 2026-07-08
- **Status:** Operator setup guide for research-only OpenCode ACP runs.

Do not write API keys into this repository. Use OpenCode auth storage or environment variables.

## Tested provider

Use OpenRouter through the OpenCode TUI for the currently confirmed external-provider smoke.

Recommended tested model:

```text
openrouter/cohere/north-mini-code:free
```

Evidence:

- `one-session` completed through OpenCode ACP with `updates=101` and `usageUpdates=1`;
- `different-models` with base and alt both set to `openrouter/cohere/north-mini-code:free` completed both sessions after `session/set_config_option(model)` and `session/set_config_option(mode)`;
- `two-sessions-parallel` completed two concurrent sessions against the same external model.

The `pnpm run research:opencode-acp-sessions` commands below are research commands used during non-production research experiments outside production code. This PR documents the observed outcomes and operator setup; it does not add the research harness/script to `master`.

Non-production research command for one ACP session after connecting OpenRouter in OpenCode:

```bash
REVO_ACP_RESEARCH_MODEL=openrouter/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

Non-production research command for model/mode config-option smoke with the same responsive model:

```bash
REVO_ACP_RESEARCH_MODEL=openrouter/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_ALT_MODEL=openrouter/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- different-models
```

Do not use this model as the first smoke target:

```text
openrouter/qwen/qwen3-coder:free
```

Observed behavior: OpenCode accepted `session/set_config_option(model=openrouter/qwen/qwen3-coder:free)` and updated `model.currentValue`, then `session/prompt` timed out after `180000ms` without stderr, permission requests, or text chunks. Treat this as an unreliable smoke model or provider/model-specific timeout. Do not conclude from that run that model switching is broken.

## OpenCode Zen local credential issue

The `opencode/*` provider path is not currently valid evidence until the local OpenCode Zen credential is fixed.

Observed local auth state:

```text
~/.local/share/opencode/auth.json
provider=opencode
keyLength=6
keyAscii=false
```

Observed provider request failure:

```text
Header ... invalid value: 'Bearer [REDACTED]'
```

Conclusion: this is a local credential issue, not an ACP issue. Re-authenticate in OpenCode without printing the key before using `opencode/*` models as research evidence:

```text
opencode
/connect
OpenCode Zen
paste the API key in the TUI prompt
/models
```

## OpenRouter fallback

If OpenRouter is not already connected through the OpenCode TUI, use an OpenRouter API key through environment-backed OpenCode config. Free models change over time, so refresh the current catalog before choosing a model:

```bash
curl -sS https://openrouter.ai/api/v1/models
```

As of 2026-07-08, the public catalog included these zero-price model IDs:

```text
cohere/north-mini-code:free
poolside/laguna-xs-2.1:free
tencent/hy3:free
```

Set the key only in the environment:

```bash
export OPENROUTER_API_KEY=...
```

Use inline OpenCode config; this stores no secret in the repo:

```bash
export OPENCODE_CONFIG_CONTENT='{
  "provider": {
    "openrouter-free": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter Free",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      },
      "models": {
        "cohere/north-mini-code:free": {
          "name": "Cohere North Mini Code free",
          "limit": { "context": 256000, "output": 64000 }
        },
        "poolside/laguna-xs-2.1:free": {
          "name": "Poolside Laguna XS 2.1 free",
          "limit": { "context": 262144, "output": 32768 }
        }
      }
    }
  }
}'
```

Verify that OpenCode sees the external models:

```bash
opencode models openrouter-free
```

Expected:

```text
openrouter-free/cohere/north-mini-code:free
openrouter-free/poolside/laguna-xs-2.1:free
```

Non-production research command for one ACP session with inline provider config:

```bash
REVO_ACP_RESEARCH_MODEL=openrouter-free/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

Non-production research command for an external provider/model error probe after the valid smoke succeeds:

```bash
export OPENCODE_CONFIG_CONTENT='{
  "provider": {
    "openrouter-free": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter Free",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      },
      "models": {
        "definitely-missing-model": {
          "name": "Missing model for ACP error research",
          "limit": { "context": 8192, "output": 1024 }
        }
      }
    }
  }
}'

REVO_ACP_RESEARCH_MODEL=openrouter-free/definitely-missing-model \
REVO_ACP_RESEARCH_TIMEOUT_MS=60000 \
pnpm run research:opencode-acp-sessions -- model-error
```

## Current guardrails

- Prefer `openrouter/cohere/north-mini-code:free` for external-provider smoke because it has completed the bounded ACP runs.
- Do not use `openrouter/qwen/qwen3-coder:free` as the reliability signal for ACP smoke; it timed out after config-option acceptance.
- Do not treat the local `opencode/*` invalid authorization header as ACP evidence until the OpenCode Zen credential is re-authenticated.
- Do not commit API keys, auth files, or raw local secret material to this repository.
