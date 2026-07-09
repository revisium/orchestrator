# ACP + OpenCode: заметки по документации

- **Дата:** 2026-07-08
- **Статус:** исследовательские заметки перед ADR. Это не архитектурное решение и не спецификация реализации.

## Цель

Зафиксировать факты из документации ACP/OpenCode до интеграции в Revo. Код Revo здесь не анализируется, кроме уже известного контекста исследовательского spike: `opencode acp` запускается, `provider/model` передается через OpenCode config, streaming chunks приходят и парсятся.

## Источники

| Источник | Ссылка | Для чего использован |
|---|---|---|
| ACP Transports | https://agentclientprotocol.com/protocol/v1/transports | JSON-RPC transport, stdio, Streamable HTTP, пользовательские transports |
| ACP Session Setup | https://agentclientprotocol.com/protocol/v1/session-setup | `session/new`, `session/load`, `session/resume`, `session/close`, смысл session |
| ACP Schema | https://agentclientprotocol.com/protocol/v1/schema | Методы, capabilities, update/error/usage поверхность |
| OpenCode ACP Support | https://opencode.ai/docs/acp/ | Как запускается `opencode acp`, stdio JSON-RPC subprocess |
| OpenCode CLI | https://opencode.ai/docs/cli/ | CLI-поверхность OpenCode |
| OpenCode Config | https://opencode.ai/docs/config/ | Config/provider/model/context compression |
| OpenCode source: ACP service | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/service.ts | Реализационные детали ACP, если публичная документация молчит |
| OpenCode source: ACP config options | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/config-option.ts | Реализационные детали session config options |

Ссылки на OpenCode source, которые используют изменяемую ветку `dev`, были просмотрены 2026-07-08. Это навигационные ссылки, а не неизменяемое доказательство; перед использованием поведения из source как стабильного контракта их нужно пересмотреть или закрепить на commit SHA.

## Документированные факты ACP

ACP использует JSON-RPC. Официально описаны transport через `stdio` и черновой `Streamable HTTP`. `stdio` не единственный возможный transport, потому что спецификация допускает custom transports, но `stdio` является базовым рекомендуемым вариантом.

В `stdio` режиме client запускает agent как subprocess. Agent читает JSON-RPC из `stdin` и пишет JSON-RPC в `stdout`; logging допускается через `stderr`. Из этого следует важное ограничение: если client-процесс умер, его pipe к дочернему process потерян. Документация ACP не дает общего process-level reconnect поверх `stdio`.

Session в ACP описана как отдельный conversation/thread между client и agent. Каждая session имеет свой context, историю conversation и state. `session/new` создает session и возвращает уникальный `sessionId`.

ACP документирует `session/load` и `session/resume`, если agent объявляет соответствующие capabilities. `session/load` восстанавливает session с replay истории через `session/update`; `session/resume` восстанавливает без replay. Это session-level восстановление, не универсальный reconnect transport-level pipe.

ACP документирует `session/close`: agent должен отменить текущую работу session и освободить ресурсы. Это не process shutdown API.

В просмотренной документации ACP не найден стандартизованный API `start`, `stop`, `shutdown`, `health`, `heartbeat`, `ping` или `status` для процесса agent.

ACP не задает обязательные фиксированные поля `provider`, `model` или `effort` в `session/new` или `session/prompt`. Модель/режим/effort относятся к session config options или специфичному для реализации поведению конкретного agent.

## Документированные факты OpenCode ACP

OpenCode публично документирует запуск через `opencode acp`. Редактор/клиент должен запускать OpenCode как ACP-compatible subprocess, который общается по JSON-RPC через `stdio`.

Документация OpenCode подтверждает, что ACP mode поддерживает возможности OpenCode: built-in tools, custom tools, slash commands, MCP servers из OpenCode config, project-specific rules из `AGENTS.md`, agents и permissions system. Это важно для Revo: project `cwd` может резко менять размер контекста и поведение agent.

OpenCode публичная документация подробно покрывает config/provider/model/baseURL/API key, но почти не документирует:

- долгоживущий ACP daemon как отдельный server;
- reconnect после потери `stdio`;
- несколько ACP sessions в одном процессе;
- параллельные ACP sessions;
- точную форму ACP usage/cost events;
- точное поведение context overflow через ACP.

OpenCode source показывает больше, чем публичные docs: реализация ACP объявляет capabilities вроде load/list/resume/close/fork и session config options для model/effort/mode. Это нужно считать фактом текущей реализации, но не пользовательской публичной гарантией API.

## Что документация не закрывает

Документация не отвечает достаточно строго на следующие вопросы:

- Можно ли безопасно использовать один `opencode acp` process для нескольких Revo steps.
- Гарантирована ли параллельность prompt в разных sessions.
- Что произойдет при смерти Revo/client, если `opencode acp` subprocess продолжает жить.
- Можно ли новый Revo процесс переподключить к уже живому `opencode acp` через `stdio`.
- Как OpenCode ведет себя при разных model/effort/mode между sessions в одном process.
- Какой лимит sessions на один ACP process безопасен.
- Как правильно строить health/reconciliation для OpenCode ACP.

## Предварительные последствия для Revo

Для v1 нельзя считать `opencode acp` полноценным reconnectable daemon/server только на основании документации. Через `stdio` это subprocess, связанный с client pipe.

Документация поддерживает идею `AcpManager`, но не доказывает необходимость pooling. Наоборот, безопасная начальная гипотеза:

```text
1 ACP process / 1 session / 1 step-or-attempt
```

Такой scope проще для ownership, cleanup, cancellation, DBOS state и изоляции отказов.

Использование одного ACP process для нескольких sessions может быть полезным, но только после PoC:

- events должны надежно маршрутизироваться по `sessionId`;
- model/effort/mode должны быть session-scoped;
- cancellation не должна ломать соседние sessions;
- падение process должно иметь понятную blast radius;
- DBOS reconciliation должен знать, какие sessions были потеряны.

## Что нужно проверить до ADR

Документация дает направление, но ADR должен опираться еще и на эксперименты:

1. Один `opencode acp`, одна session, один prompt.
2. Один `opencode acp`, две sessions последовательно.
3. Один `opencode acp`, две sessions параллельно.
4. Разные model/effort/mode между sessions.
5. `session/load` и `session/resume`.
6. `session/cancel`.
7. `session/close`.
8. Поток permission request.
9. Переполнение context.
10. Ошибка provider/API.
11. Смерть client / reconnect.
