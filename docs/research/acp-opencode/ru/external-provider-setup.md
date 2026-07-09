# Настройка внешнего провайдера для OpenCode ACP

- **Дата:** 2026-07-08
- **Статус:** операторская инструкция для исследовательских прогонов OpenCode ACP.

Не записывайте API key в этот репозиторий. Используйте хранилище auth OpenCode или переменные environment.

## Проверенный провайдер

Для текущего подтвержденного smoke внешнего провайдера используйте OpenRouter через OpenCode TUI.

Рекомендованная проверенная модель:

```text
openrouter/cohere/north-mini-code:free
```

Доказательства:

- `one-session` завершился через OpenCode ACP с `updates=101` и `usageUpdates=1`;
- `different-models` с базовой и альтернативной моделями, обе установленными в `openrouter/cohere/north-mini-code:free`, завершил обе сессии после `session/set_config_option(model)` и `session/set_config_option(mode)`;
- `two-sessions-parallel` завершил две параллельные сессии на той же внешней модели.

Команды `pnpm run research:opencode-acp-sessions` ниже - команды из исследовательских экспериментов вне production-кода. Этот PR фиксирует результаты и операторские настройки, но не добавляет harness/script в `master`.

Исследовательская команда вне production-кода для запуска одной ACP-сессии после подключения OpenRouter в OpenCode:

```bash
REVO_ACP_RESEARCH_MODEL=openrouter/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session # исследовательская команда вне production-кода; harness/script не добавляется в master
```

Исследовательская команда вне production-кода для smoke config-option model/mode с той же отзывчивой моделью:

```bash
REVO_ACP_RESEARCH_MODEL=openrouter/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_ALT_MODEL=openrouter/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- different-models # исследовательская команда вне production-кода; harness/script не добавляется в master
```

Не используйте эту модель как первую цель smoke:

```text
openrouter/qwen/qwen3-coder:free
```

Наблюдаемое поведение: OpenCode принял `session/set_config_option(model=openrouter/qwen/qwen3-coder:free)` и обновил `model.currentValue`, затем `session/prompt` завершился timeout после `180000ms` без `stderr`, `permission requests` или `text chunks`. Считайте это ненадежной моделью для smoke или timeout, специфичным для `provider/model`. Не делайте из этого прогона вывод, что переключение model сломано.

## Локальная проблема credential OpenCode Zen

Путь провайдера `opencode/*` сейчас не является валидным доказательством, пока локальный credential OpenCode Zen не исправлен.

Наблюдаемое состояние локального auth:

```text
~/.local/share/opencode/auth.json
provider=opencode
keyLength=6
keyAscii=false
```

Наблюдаемый сбой запроса провайдера:

```text
Header ... invalid value: 'Bearer [REDACTED]'
```

Вывод: это локальная проблема credential, а не проблема ACP. Перед использованием моделей `opencode/*` как исследовательского доказательства выполните re-authentication в OpenCode без вывода API key:

```text
opencode
/connect
OpenCode Zen
вставьте API key в запрос TUI
/models
```

## Резервный путь OpenRouter

Если OpenRouter еще не подключен через OpenCode TUI, используйте OpenRouter API key через конфигурацию OpenCode с environment. Бесплатные модели меняются со временем, поэтому перед выбором модели обновите текущий каталог:

```bash
curl -sS https://openrouter.ai/api/v1/models
```

На 2026-07-08 публичный каталог включал эти model IDs с нулевой ценой:

```text
cohere/north-mini-code:free
poolside/laguna-xs-2.1:free
tencent/hy3:free
```

Устанавливайте API key только в environment:

```bash
export OPENROUTER_API_KEY=...
```

Используйте inline-конфигурацию OpenCode; она не сохраняет секрет в репозитории:

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

Проверьте, что OpenCode видит внешние модели:

```bash
opencode models openrouter-free
```

Ожидаемый результат:

```text
openrouter-free/cohere/north-mini-code:free
openrouter-free/poolside/laguna-xs-2.1:free
```

Исследовательская команда вне production-кода для одной ACP-сессии с inline-конфигурацией провайдера:

```bash
REVO_ACP_RESEARCH_MODEL=openrouter-free/cohere/north-mini-code:free \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session # исследовательская команда вне production-кода; harness/script не добавляется в master
```

Исследовательская команда вне production-кода для проверки ошибки внешнего `provider/model` после успешного валидного smoke:

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
pnpm run research:opencode-acp-sessions -- model-error # исследовательская команда вне production-кода; harness/script не добавляется в master
```

## Текущие ограничения

- Предпочитайте `openrouter/cohere/north-mini-code:free` для smoke внешнего провайдера, потому что эта модель завершила ограниченные ACP-прогоны.
- Не используйте `openrouter/qwen/qwen3-coder:free` как сигнал надежности для ACP smoke; она завершилась timeout после приемки config-option.
- Не считайте `invalid authorization header` для локального `opencode/*` доказательством ACP, пока OpenCode Zen credential не пройдет re-authentication.
- Не коммитьте API key, auth-файлы или сырой локальный секретный материал в этот репозиторий.
