# ACP + OpenCode: результаты экспериментов 2026-07-08

- **Статус:** локальный PoC вне production-кода Revo.

Harness: `orchestrator/.worktrees/opencode-acp-runner/scripts/research-opencode-acp-sessions.ts`

Артефакты: `/tmp/revo-opencode-acp-research-artifacts/*.jsonl`

Модель: `llamacpp-fast/qwen-coder-7b`

Provider: локальный OpenAI-compatible `llama-server` через конфигурацию provider OpenCode.

Сервер контекста: `n_ctx=16384`, CPU-safe режим.

## Важное исправление harness

Во время первого запуска обнаружен баг выбора experiment через `pnpm run ... -- <experiment>`.

Причина: `pnpm` передает разделитель `--` внутрь `process.argv`, а парсер считал первым аргументом именно `--` и уходил в вариант по умолчанию `one-session`.

Исправление:

- `parseExperimentArg` теперь пропускает ведущий `--`;
- добавлен регрессионный тест `research options allow experiment after pnpm run argument separator`;
- после исправления `options.test.ts` проходит `8/8`.

## E1. Один ACP / одна сессия / один prompt

Команда:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-46-19-930Z-one-session.jsonl
```

Результат:

- `initialize` прошел;
- `session/new` вернул `sessionId`;
- `session/prompt` завершился;
- пришли `session/update`;
- пришел один `usage_update`;
- `session/close` завершился.

Вывод:

`opencode acp` стабильно работает как короткоживущий процесс для одной сессии.

## E2. Один ACP / две сессии последовательно

Команда:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=240000 \
pnpm run research:opencode-acp-sessions -- two-sessions-sequential
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-48-12-501Z-two-sessions-sequential.jsonl
```

Результат:

- один `opencode acp` процесс создал две сессии;
- обе сессии получили разные `sessionId`;
- prompt первой сессии завершился;
- prompt второй сессии завершился;
- у каждой сессии был свой `usage_update`;
- обе сессии закрылись через `session/close`.

Сводка сессий:

```text
first:  updates=22, usageUpdates=1
second: updates=22, usageUpdates=1
```

Вывод:

OpenCode ACP на практике поддерживает несколько сессий последовательно внутри одного процесса.

## E3. Один ACP / две сессии параллельно

Команда:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=300000 \
pnpm run research:opencode-acp-sessions -- two-sessions-parallel
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-48-53-592Z-two-sessions-parallel.jsonl
```

Результат:

- один `opencode acp` процесс создал две сессии;
- два `session/prompt` были отправлены параллельно;
- оба prompt завершились `stopReason=end_turn`;
- updates разделялись по `sessionId`;
- у каждой сессии был свой `usage_update`;
- обе сессии закрылись через `session/close`.

Сводка сессий:

```text
parallel-a: updates=13, usageUpdates=1
parallel-b: updates=17, usageUpdates=1
```

Проверка по JSONL:

```text
17 updates -> session parallel-b
13 updates -> session parallel-a
```

Вывод:

OpenCode ACP на практике поддерживает параллельные prompt в разных сессиях одного процесса. Для Revo это открывает возможность `1 ACP process / N sessions`, но только при наличии routing, лимитов, cancellation и policy отказов в AcpManager.

## E4. Параметры config options сессии / model / mode

Команда:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=300000 \
pnpm run research:opencode-acp-sessions -- different-models
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-52-52-138Z-different-models.jsonl
```

Результат:

`session/new` вернул `configOptions`:

- `model`;
- `mode`.

`model.currentValue`:

```text
llamacpp-fast/qwen-coder-7b
```

`mode.currentValue` изначально:

```text
revo-acp-research-smoke
```

Harness вызвал:

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "...",
    "configId": "model",
    "value": "llamacpp-fast/qwen-coder-7b"
  }
}
```

и:

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "...",
    "configId": "mode",
    "value": "revo-acp-research-alt"
  }
}
```

OpenCode ответил полным списком `configOptions`. После установки mode:

```text
mode.currentValue = revo-acp-research-alt
```

Обе сессии затем выполнили prompt и завершились.

Вывод:

OpenCode ACP поддерживает config options на уровне сессии и принимает `session/set_config_option` для `model` и `mode`.

Ограничение эксперимента:

В этом прогоне `REVO_ACP_RESEARCH_ALT_MODEL` был равен основной модели, поэтому проверено принятие config option, но не реальное переключение на другой provider/model. Следующий эксперимент должен использовать внешний provider или второй реально доступный локальный provider.

## Подтверждения внешнего provider OpenRouter

- **Статус:** дополнительные ограниченные исследовательские прогоны через OpenCode ACP и внешний provider, подключенный в OpenCode TUI.

### Факт: локальная OpenCode Zen auth проблема не является ACP проблемой

Ранний smoke через provider `opencode/*` падал на provider request до содержательной ACP проверки.

Локальное состояние credential:

```text
~/.local/share/opencode/auth.json
provider=opencode
keyLength=6
keyAscii=false
```

Наблюдаемая ошибка:

```text
Header ... invalid value: 'Bearer [REDACTED]'
```

Вывод:

Это локально битый credential OpenCode Zen. Этот сбой не доказывает проблему ACP transport, `session/new`, `session/prompt` или `session/set_config_option`.

### Факт: OpenRouter подключен через OpenCode TUI

Рабочий внешний model id для smoke/research:

```text
openrouter/cohere/north-mini-code:free
```

Этот provider/model использован как внешний контрольный прогон через OpenCode ACP.

### E5. OpenRouter / one-session

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T11-48-53-118Z-one-session.jsonl
```

Результат:

- `session/new` создал сессию;
- `session/prompt` завершился;
- `updates=101`;
- `usageUpdates=1`.

Вывод:

Внешний provider через OpenCode ACP подтвержден на модели `openrouter/cohere/north-mini-code:free`.

### E6. OpenRouter / different-models / отзывчивая базовая модель, ненадежная альтернативная

Модели:

```text
base = openrouter/cohere/north-mini-code:free
alt  = openrouter/qwen/qwen3-coder:free
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T11-49-26-963Z-different-models.jsonl
```

Основная сессия:

```text
updates=149
usageUpdates=1
```

Альтернативная сессия:

- OpenCode вернул `configOptions`;
- `session/set_config_option(model=openrouter/qwen/qwen3-coder:free)` завершился успешно;
- `model.currentValue` обновился;
- `session/set_config_option(mode=revo-acp-research-alt)` завершился успешно;
- `session/prompt` завершился timeout после `180000ms`;
- не было `stderr`, permission requests или text chunks.

Вывод:

Поверхность конфигурации для `model` и `mode` работает: OpenCode принял значения и обновил currentValue. Timeout модели `openrouter/qwen/qwen3-coder:free` нужно считать ненадежностью конкретного provider/model для smoke или отдельным model timeout, а не доказательством поломки переключения model.

### E7. OpenRouter / different-models / та же отзывчивая модель

Модели:

```text
base = openrouter/cohere/north-mini-code:free
alt  = openrouter/cohere/north-mini-code:free
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T12-05-28-967Z-different-models.jsonl
```

Основная сессия:

```text
updates=140
usageUpdates=1
```

Альтернативная сессия после `session/set_config_option(model)` и `session/set_config_option(mode)`:

```text
updates=132
usageUpdates=1
```

Вывод:

`session/set_config_option(model)` и `session/set_config_option(mode)` работают для отзывчивой модели OpenRouter. Этот прогон закрывает ограничение E4 в части принятия ACP config option на внешнем provider.

### E8. OpenRouter / two-sessions-parallel

Модель:

```text
openrouter/cohere/north-mini-code:free
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T12-06-40-090Z-two-sessions-parallel.jsonl
```

Сводка сессий:

```text
parallel-a: updates=204, usageUpdates=1
parallel-b: updates=299, usageUpdates=1
```

Вывод:

Один OpenCode ACP daemon может выполнять несколько сессий одновременно даже на внешней модели OpenRouter.

## Архитектурные последствия после OpenRouter прогонов

Факты:

- `1 ACP daemon / N sessions` технически работает в локальных и OpenRouter исследовательских прогонах;
- OpenCode ACP предоставляет `configOptions` на уровне сессии для `model` и `mode`;
- Revo может передавать model/mode/effort для каждой сессии через `session/set_config_option`, когда OpenCode предоставляет соответствующие `configId`;
- сбои provider/model нужно отделять от факта принятия config option.

Рекомендация для Revo v1:

Использовать форму по умолчанию:

```text
1 ACP daemon / 1 step attempt / 1 ACP session
```

Причины:

- изоляция;
- простая cleanup модель;
- простые retries;
- DBOS reconciliation без неоднозначности shared-daemon;
- меньший радиус влияния при смерти процесса или зависании provider/model.

Pooling или multi-session daemon стоит считать оптимизацией v2. Он должен жить за лимитами policy и health/reconciliation в `AcpManager`.

Граница ответственности:

- `AcpManager` владеет lifecycle daemon, stdio pipes, routing сессий, cancellation и cleanup;
- DBOS сохраняет desired/observed state и данные reconciliation;
- DBOS не заменяет process manager и не владеет stdio pipes напрямую.

## Возможности OpenCode при initialize

Фактический `initialize.result`:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": {
      "http": true,
      "sse": true
    },
    "promptCapabilities": {
      "embeddedContext": true,
      "image": true
    },
    "sessionCapabilities": {
      "close": {},
      "fork": {},
      "list": {},
      "resume": {}
    }
  },
  "agentInfo": {
    "name": "OpenCode",
    "version": "1.17.14"
  }
}
```

Вывод:

OpenCode ACP объявляет:

- `loadSession`;
- `sessionCapabilities.close`;
- `sessionCapabilities.fork`;
- `sessionCapabilities.list`;
- `sessionCapabilities.resume`;
- MCP `http` и `sse`;
- embedded context и image для prompt.

Это нужно исследовать отдельно, особенно `list`, `load`, `resume`, `fork`.

## Обновленный промежуточный вывод

До экспериментов самая консервативная гипотеза была:

```text
1 ACP process / 1 session / 1 step-or-attempt
```

После экспериментов можно уточнить:

```text
OpenCode ACP технически умеет:
- несколько sessions в одном process;
- параллельные prompt в разных sessions;
- session-level config options model/mode.
```

Но для Revo v1 это не автоматически означает, что нужно сразу делать pooling. Причины:

- если один процесс упал, падают все сессии внутри него;
- нужен routing `sessionId -> pipeline/run/step/attempt`;
- нужен timeout/cancel на сессию;
- нужен лимит параллельных сессий на процесс;
- нужен cleanup зависших сессий;
- `stdio` по-прежнему не дает pipe для reconnect на уровне процесса после перезапуска Revo;
- `load/resume` требуют отдельного исследования.

## Что осталось проверить

Следующие эксперименты обязательны перед ADR:

1. Реальное переключение на другую модель/provider через `session/set_config_option`.
2. `session/list`.
3. `session/load`.
4. `session/resume`.
5. `session/fork`, если нужно для семантики pipeline.
6. `session/cancel` для долго выполняющегося prompt.
7. Поток permission request.
8. Ошибка provider/API.
9. Переполнение context.
10. Смерть клиента / reconnect.
11. Убийство ACP process с одной активной сессией.
12. Убийство ACP process с несколькими активными сессиями.

## Предварительная рекомендация для ADR

Для v1 можно рассмотреть два режима:

### Безопасный вариант по умолчанию

```text
1 ACP process / 1 session / 1 step-or-attempt
```

Использовать как базовую надежную модель.

### Опциональный оптимизированный режим после дополнительных исследований

```text
1 ACP process / N sessions
```

Допускать только если `AcpManager` реализует:

- registry сессий;
- routing updates по `sessionId`;
- timeout/cancel на сессию;
- fan-out сбоев на уровне процесса;
- максимум сессий на процесс;
- аккуратный `session/close`;
- desired/observed state в DBOS;
- policy для reconciliation после restart.

## Продолжение: безопасные расширения harness и заблокированные sandbox прогоны

Дата/время: 2026-07-08 09:20-09:30 Europe/Moscow.

Изменения harness:

- добавлены selectors экспериментов `permission-request`, `model-error`, `crash-one-session`, `crash-two-sessions`;
- добавлен `REVO_ACP_RESEARCH_PERMISSION_MODE=ask|deny`;
- `permission-request` автоматически использует `ask`, а клиент отвечает deny на `session/request_permission`;
- диагностика summary/timeout теперь включает pending RPC methods, child exit/signal, stderr tail и счетчики permission requests/denials;
- эксперименты crash убивают только дочерний `opencode acp` process через `SIGKILL` после старта ограниченного long prompt.

TDD-доказательство:

```bash
node --import tsx -e "import('./scripts/research-opencode-acp/options.test.ts').catch((error)=>{ console.error(error); process.exit(1); })"
```

Сначала новые тесты падали на отсутствующих `permissionMode`, `permission-request` и ask-permission config.
После реализации: `13/13` прошли.

Health provider был проверен отдельно:

```bash
curl -sS http://127.0.0.1:8082/v1/models
```

Результат: provider доступен, возвращает `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`.

### Попытка permission request: неубедительно, заблокировано до ACP initialize

Команда без health URL, потому что Node `fetch` внутри sandbox получил `TypeError: fetch failed`, хотя `curl` health check прошел:

```bash
env REVO_ACP_RESEARCH_CWD=/tmp/revo-opencode-acp-research \
  REVO_ACP_RESEARCH_ARTIFACT_DIR=/tmp/revo-opencode-acp-research-artifacts \
  REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
  REVO_ACP_RESEARCH_TIMEOUT_MS=120000 \
  node --import tsx scripts/research-opencode-acp-sessions.ts permission-request
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T06-26-42-414Z-permission-request.jsonl
```

Результат:

- `initialize` был отправлен;
- `opencode acp` завершился `code=1` до ответа;
- stderr: `Unknown: FileSystem.open (/home/egor/.local/share/opencode/log/opencode.log)`.

После redirect OpenCode data/state/cache в `/tmp`:

```bash
env XDG_DATA_HOME=/tmp/revo-opencode-acp-xdg-data \
  XDG_STATE_HOME=/tmp/revo-opencode-acp-xdg-state \
  XDG_CACHE_HOME=/tmp/revo-opencode-acp-xdg-cache \
  REVO_ACP_RESEARCH_CWD=/tmp/revo-opencode-acp-research \
  REVO_ACP_RESEARCH_ARTIFACT_DIR=/tmp/revo-opencode-acp-research-artifacts \
  REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
  REVO_ACP_RESEARCH_TIMEOUT_MS=120000 \
  node --import tsx scripts/research-opencode-acp-sessions.ts permission-request
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T06-27-20-842Z-permission-request.jsonl
```

Промежуточный вариант, который также redirect-ил `XDG_CONFIG_HOME`, дал тот же pre-initialize
`ServeError`:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T06-26-55-001Z-permission-request.jsonl
```

Результат:

- `initialize` был отправлен;
- `opencode acp` завершился `code=1` до ответа;
- stderr: `ServeError`;
- `permission requests observed=0`.

Вывод: поток permission request пока не проверен. Harness готов логировать и deny-ить `session/request_permission`, но текущий sandbox не дает `opencode acp` дойти до ACP initialize. Это не доказывает поведение OpenCode permissions.

### Эксперименты ошибки provider/model и crash

Не запускались после попытки permission request, потому что все они требуют успешного старта `opencode acp`, а ограниченный permission run показал pre-initialize `ServeError` в текущем sandbox. Эскалация для ограниченного прогона без sandbox была отклонена.

Статус:

- `model-error`: TODO в окружении, где `opencode acp` может стартовать;
- `crash-one-session`: TODO в окружении, где `opencode acp` может стартовать;
- `crash-two-sessions`: TODO в окружении, где `opencode acp` может стартовать;
- context overflow: TODO, запускать только без restart local model server и с ограниченным timeout.

Что доказано этим продолжением:

- harness теперь не теряет context timeout/process: failure summary содержит pending RPC, child exit/signal и stderr tail;
- sandbox failure теперь отличим от provider/model/ACP failure;
- live-выводы по permission/model/crash остаются неубедительными.

## Продолжение: host-local ограниченные прогоны после разблокировки sandbox

Дата/время: 2026-07-08 12:20-12:35 Europe/Moscow.

Область:

- запускались только local commands в research worktree;
- Revo MCP/preflight не запускались;
- production `src/**` не менялся;
- OpenCode provider/auth values не печатались, фиксировались только provider/model ids и наличие credentials.

Дополнения harness:

- добавлены selectors экспериментов `context-overflow` и `client-death-reconnect`;
- `context-overflow` генерирует ограниченный oversized prompt внутри harness;
- `client-death-reconnect` закрывает stdio pipes на стороне client без SIGKILL, затем проверяет `session/load`/`session/resume` в новом процессе `opencode acp`;
- `scripts/research-opencode-acp/README.md` и options tests обновлены под новые selectors.

### Инвентаризация provider/model

Команды:

```bash
opencode models
opencode auth list
curl -sS --max-time 3 http://127.0.0.1:8082/v1/models
```

Результат:

- `opencode models` показал только настроенные local providers:
  - `llamacpp/qwen3-coder`;
  - `llamacpp-fast/qwen-coder-7b`;
  - `llamacpp-north/north-mini`;
  - `ollama/qwen2.5-chat-offload`;
  - `ollama/qwen2.5-coder-offload`;
  - `ollama/qwen3-offload`.
- `opencode auth list` показал credentials для `OpenCode Zen` и `ollama`, без secret values.
- `opencode models opencode` вернул `Provider not found: opencode`.
- host-local `127.0.0.1:8082/v1/models` доступен и возвращает `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`.
- `127.0.0.1:11434` и `127.0.0.1:8080` не отвечали.

Вывод:

На этом этапе исследования в безопасной существующей config не было выбираемого внешнего provider/model. Реальное внешнее поведение provider/model еще не было проверено; более поздние OpenRouter TUI прогоны выше закрыли этот пробел для `openrouter/cohere/north-mini-code:free`. Безопасная команда после явной настройки внешнего provider:

```bash
REVO_ACP_RESEARCH_MODEL=<external-provider>/<model> \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

### Поток permission request

Команда:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- permission-request
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-24-32-139Z-permission-request.jsonl
```

Результат:

- `initialize` и `session/new` прошли;
- `permissionMode=ask` был применен в сгенерированном config OpenCode;
- prompt просил использовать shell command только в isolated cwd;
- OpenCode не отправил `session/request_permission`;
- `permission requests observed=0`;
- `permission denial responses sent=0`;
- модель сгенерировала текстовый JSON-like bash request и завершила `session/prompt` с `stopReason=end_turn`;
- исполнения tool не было.

Вывод:

Реальный путь callback/deny для permission request пока не доказан. Доказано только отрицательное поведение: с local `llamacpp-fast/qwen-coder-7b` и этим output prompt/model OpenCode не вошел в путь исполняемого tool call, поэтому deny callback не был вызван. Нужен provider/model, который реально генерирует tool calls через OpenCode, или более точная OpenCode tool-call fixture.

### Ошибка provider/model после initialize

Команда с некорректно настроенным model id:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/definitely-missing-model \
REVO_ACP_RESEARCH_TIMEOUT_MS=60000 \
pnpm run research:opencode-acp-sessions -- model-error
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-25-35-124Z-model-error.jsonl
```

Результат:

- `initialize` прошел;
- `session/new` прошел;
- `session/new.configOptions.model.currentValue` стал `ollama/qwen3-offload`, то есть OpenCode выбрал fallback из существующего config;
- `session/prompt` не вернул JSON-RPC error до timeout;
- после harness timeout `session/close` вернул `{}`, а затем `session/prompt` вернул `stopReason=end_turn`.

Команда с синтетическим недоступным localhost provider:

```bash
OPENCODE_CONFIG_CONTENT='{"provider":{"broken-local":{"name":"Broken local OpenAI-compatible","npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:65534/v1"},"models":{"missing":{"name":"Missing synthetic model"}}}}}' \
REVO_ACP_RESEARCH_MODEL=broken-local/missing \
REVO_ACP_RESEARCH_TIMEOUT_MS=45000 \
pnpm run research:opencode-acp-sessions -- model-error
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-27-11-507Z-model-error.jsonl
```

Результат:

- `initialize` прошел;
- `session/new` прошел и показал `currentValue=broken-local/missing`;
- `session/prompt` не вернул ACP-visible JSON-RPC error за 45s;
- stderr был пустым;
- после harness timeout `session/close` вернул `{}`, а затем `session/prompt` вернул `stopReason=end_turn`.

Вывод:

Форма provider/model error не доказана как структурированная ACP error для недоступного provider: в этих двух ограниченных прогонах OpenCode зависал на `session/prompt` до timeout на стороне client. Для Revo это означает, что runner timeout остается обязательным, даже если provider/model config уже прошел `initialize` и `session/new`.

### Переполнение context

Команда:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=90000 \
pnpm run research:opencode-acp-sessions -- context-overflow
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-28-17-217Z-context-overflow.jsonl
```

Результат:

- размер сгенерированного prompt: `493017` chars;
- `initialize` и `session/new` прошли;
- OpenCode отправил `usage_update` с `used=0`, `size=32768`;
- `session/prompt` вернул JSON-RPC error:

```json
{
  "code": -32603,
  "message": "Internal error: Session too large to compact - context exceeds model limit even after stripping media",
  "data": {
    "service": "session",
    "errorName": "ContextOverflowError"
  }
}
```

Вывод:

Переполнение context доказано как ACP-visible JSON-RPC error на `session/prompt`. Ошибка выглядит пригодной для retry только после уменьшения context/prompt; слепой retry с тем же prompt/model бесполезен. Revo должен сохранять `errorName=ContextOverflowError`, message, model и usage window.

### Смерть клиента / reconnect

Команда:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- client-death-reconnect
```

Артефакт:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-28-36-407Z-client-death-reconnect.jsonl
```

Результат:

- первый процесс `opencode acp` запустил prompt;
- harness закрыл client stdio pipes, не убивая сначала дочерний процесс;
- старый stdio process завершился после закрытия pipe: `true`;
- API reconnect в том же process для stdio отсутствует;
- новый процесс `opencode acp` успешно инициализировался;
- новый процесс `session/load` для исходного `sessionId` вернул `object(configOptions)` и воспроизвел предыдущий текст prompt;
- новый процесс `session/resume` для исходного `sessionId` вернул `object(configOptions)`;
- prompt после resume в новом процессе завершился с `usage_update=1` и `stopReason=end_turn`.

Вывод:

Повторное подключение на уровне transport к тому же stdio process недоступно и не наблюдалось. Сохранение сессии между новыми процессами OpenCode ACP работает через `session/load`/`session/resume` для сохраненного session id. Это поддерживает дизайн Revo, где потерянный stdio child process считается dead transport, а согласование выполняется только через persisted session ids и только когда такая семантика приемлема.

## Оставшееся после продолжения с local model

Этот раздел фиксировал состояние до более поздних подтверждений OpenRouter TUI в этом же документе.

На тот момент еще не было доказано:

- реальный callback `session/request_permission` и deny path, потому что локальная модель не сгенерировала исполняемые tool calls;
- структурированная форма provider/API error для недоступного provider, потому что ограниченные прогоны зависали до client timeout вместо возврата ACP error;
- `session/fork`.

На тот момент было заново доказано:

- настроенный local provider/model inventory и работоспособность host-local model;
- форма ACP error при context overflow;
- закрытие client stdio pipe в этой setup приводит к завершению старого ACP stdio process;
- новый OpenCode ACP process может выполнить `session/load`/`session/resume` для persisted session id после client death;
- сбои provider могут требовать Revo-side timeout даже после успешных `initialize` и `session/new`.

## Продолжение: попытка настройки внешнего free provider

Дата/время: 2026-07-08 13:05-13:15 Europe/Moscow.

- **Статус:** историческая попытка настройки до подключения OpenRouter через OpenCode TUI. Более поздние подтверждения OpenRouter ACP выше заменяют состояние "blocked" для smoke внешнего provider, но находка по OpenCode Zen credential остается актуальной.

Область:

- production `src/**` не менялся;
- живые config/auth файлы OpenCode не редактировались;
- секреты не печатались и не записывались в repo;
- для интроспекции OpenCode CLI использовалась эскалация, потому что sandbox блокировал доступ к `~/.local/share/opencode/log/opencode.log`.

Проверенные факты из официальных docs:

- источники OpenCode config сливаются, а `OPENCODE_CONFIG_CONTENT` является inline runtime override с высоким приоритетом.
- пользовательские OpenAI-compatible providers используют `provider.<id>.npm="@ai-sdk/openai-compatible"`, `options.baseURL`, опциональный `options.apiKey` и `models`.
- config поддерживает substitution `{env:VARIABLE}` для API keys.
- OpenCode Zen является официальным provider для `opencode/<model-id>`; в его документации перечислены free models, включая `opencode/north-mini-code-free`.

### Текущая инвентаризация provider/auth

Команды:

```bash
opencode models
opencode providers list
opencode models opencode
```

Результат:

- `opencode models` все еще показывает только настроенные local providers:
  - `llamacpp/qwen3-coder`;
  - `llamacpp-fast/qwen-coder-7b`;
  - `llamacpp-north/north-mini`;
  - `ollama/qwen2.5-chat-offload`;
  - `ollama/qwen2.5-coder-offload`;
  - `ollama/qwen3-offload`.
- `opencode providers list` показывает credentials для `OpenCode Zen` и `ollama`, без secret values.
- `opencode models opencode` все еще возвращает `Provider not found: opencode`.
- sanitized-проверка global config показывает, что `disabled_providers` включает `opencode`, `anthropic`, `openai`, `google` и `groq`.
- проверенные внешние env keys не заданы: `OPENROUTER_API_KEY`, GitHub Models token candidates, Google/Gemini, Groq, HuggingFace, OpenAI, Anthropic.

Корневая причина для `Provider not found: opencode`:

```text
Provider отключен глобальным OpenCode config, а не отсутствует в installation.
```

Только с inline disabled-provider override модели `opencode` становятся видимыми:

```bash
OPENCODE_CONFIG_CONTENT='{"disabled_providers":["anthropic","openai","google","groq"]}' \
opencode models opencode
```

Наблюдаемые кандидаты free/test:

- `opencode/north-mini-code-free`;
- `opencode/deepseek-v4-flash-free`;
- `opencode/mimo-v2.5-free`;
- `opencode/nemotron-3-ultra-free`;
- `opencode/big-pickle`.

Выбранная модель для первой внешней smoke-проверки:

```text
opencode/north-mini-code-free
```

Причина: это официальная free coding model OpenCode Zen; новый user account/key не нужен, если существующий Zen credential валиден.

### Валидация шаблона OpenRouter config

На этом этапе timeline исследования в этом shell не было `OPENROUTER_API_KEY`, поэтому OpenRouter provider request через этот inline-config path не выполнялся.

Форма inline config без secret values была проверена через `opencode models openrouter-free` с использованием `/tmp` XDG directories:

```bash
env XDG_DATA_HOME=/tmp/revo-opencode-acp-xdg-data \
  XDG_STATE_HOME=/tmp/revo-opencode-acp-xdg-state \
  XDG_CACHE_HOME=/tmp/revo-opencode-acp-xdg-cache \
  OPENCODE_CONFIG_CONTENT='{"provider":{"openrouter-free":{"npm":"@ai-sdk/openai-compatible","name":"OpenRouter Free","options":{"baseURL":"https://openrouter.ai/api/v1","apiKey":"{env:OPENROUTER_API_KEY}"},"models":{"cohere/north-mini-code:free":{"name":"Cohere North Mini Code free","limit":{"context":256000,"output":64000}},"poolside/laguna-xs-2.1:free":{"name":"Poolside Laguna XS 2.1 free","limit":{"context":262144,"output":32768}}}}}}' \
  opencode models openrouter-free
```

Результат:

```text
openrouter-free/cohere/north-mini-code:free
openrouter-free/poolside/laguna-xs-2.1:free
```

Вывод на тот момент: формат custom provider/model config был корректным, но этот inline-config path не мог выполнить реальный OpenRouter request без `OPENROUTER_API_KEY`. Позднейшая настройка OpenRouter TUI сняла этот блокер для подтвержденных smoke runs.

### Попытка OpenCode Zen free smoke

Команда:

```bash
OPENCODE_CONFIG_CONTENT='{"disabled_providers":["anthropic","openai","google","groq"]}' \
REVO_ACP_RESEARCH_MODEL=opencode/north-mini-code-free \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

Артефакты после hardening редактирования секретов в harness:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T10-10-58-093Z-one-session.jsonl
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T10-13-37-666Z-one-session.jsonl
```

Результат:

- `initialize` прошел;
- `session/new` прошел;
- `session/prompt` дошел до пути provider request;
- provider request завершился ошибкой из-за invalid authorization header;
- harness теперь маскирует bearer values в JSONL artifacts и console diagnostics.

Вывод:

Существующий Zen credential для OpenCode Zen присутствует, но непригоден для реального external completion. Это проблема настройки Zen credential, а не проблема формата OpenCode config или ACP startup. Позднейшие прогоны OpenRouter TUI подтвердили поведение внешнего provider через другой provider.

### Исправление безопасности в harness

Во время записи неудачной внешней попытки research harness показал пробел redaction для generic strings вида `Bearer [REDACTED]` внутри provider stderr/error messages.

Исправление:

- вынесен `scripts/research-opencode-acp/redaction.ts`;
- добавлен `scripts/research-opencode-acp/redaction.test.ts`;
- маскирует bearer authorization values в JSONL entries, ACP error messages и formatted diagnostics до console summary output.

Фокусная проверка:

```bash
node --import tsx --test scripts/research-opencode-acp/redaction.test.ts
node --import tsx --test scripts/research-opencode-acp/options.test.ts
```

Оба фокусных tests прошли.

### Дальнейшие действия

Полезные следующие проверки:

1. Повторно выполнить authenticate OpenCode Zen, затем заново запустить smoke-команду `opencode/north-mini-code-free` выше, если Zen-specific поведение важно.
2. Оставить `openrouter/cohere/north-mini-code:free` как model для smoke внешнего provider, пока для другой модели не появятся сопоставимые доказательства.
3. Запустить ограниченную проверку ошибки provider/model отдельно от приемки config-option.

Не коммитить API keys и не вставлять их в docs/config files.
