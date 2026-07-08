# ACP + OpenCode: план экспериментов перед интеграцией

- **Дата:** 2026-07-08
- **Статус:** План PoC вне production-кода. Эксперименты нужны перед ADR по `AcpManager`.

## Принцип работы

Для таких задач используем отдельный протокол исследования:

1. Тестировать вне проекта и вне production-модулей Revo.
2. До интеграции сформулировать гипотезы и граничные случаи.
3. Проверять гипотезы маленькими PoC-скриптами.
4. Сохранять сырые логи и итоговый вывод.
5. Только после этого писать ADR/spec и переносить решение в проект.

## Базовые гипотезы

H1. `opencode acp` через `stdio` безопасно использовать как короткоживущий дочерний процесс для одной session.

H2. Один `opencode acp` может создать несколько sessions, но нужно доказать, что это безопасно для Revo.

H3. Несколько sessions в одном process могут давать выгоду по startup/cache, но ухудшают изоляцию отказов.

H4. Если model/effort/mode являются process-scoped, один ACP process нельзя шарить между steps с разными профилями model.

H5. Если model/effort/mode являются session-scoped в OpenCode ACP, повторное использование одного process технически возможно, но требует AcpManager с routing, лимитами и cleanup.

H6. `stdio` transport не дает надежного reconnect после перезапуска Revo без отдельного supervisor/socket слоя.

## Общий PoC-стенд

PoC должен жить в `scripts/` или отдельной локальной директории и не использовать абстракции Revo runner. Он должен говорить с `opencode acp` напрямую по JSON-RPC.

Требования:

- запускать дочерний процесс `opencode acp`;
- отправлять `initialize`;
- отправлять `session/new`;
- отправлять `session/prompt`;
- читать `session/update`;
- логировать сырой JSON-RPC в JSONL;
- поддерживать изолированный cwd по умолчанию, например `/tmp/revo-opencode-acp-research`;
- не зашивать port/provider;
- принимать model через env;
- оставлять комментарии в коде с объяснением фаз протокола.

## Эксперименты

### E1. Один ACP / одна session / один prompt

Цель: получить базовый результат.

Проверить:

- ответ `initialize`;
- capabilities агента;
- результат `session/new`;
- фрагменты по `sessionId`;
- финальный результат `session/prompt`;
- `usage_update`;
- `session/close`.

Критерий успеха:

- prompt завершается;
- события относятся к правильному `sessionId`;
- процесс корректно закрывается.

### E2. Один ACP / две sessions последовательно

Цель: понять, можно ли использовать один process больше одного раза.

Сценарий:

1. запустить `opencode acp`;
2. `session/new` A;
3. отправить prompt A;
4. `session/new` B;
5. отправить prompt B;
6. закрыть A/B.

Критерий успеха:

- оба prompt завершаются;
- фрагменты не смешиваются;
- usage читается отдельно;
- закрытие каждой session не ломает соседнюю.

### E3. Один ACP / две sessions параллельно

Цель: проверить параллельность и routing.

Сценарий:

1. запустить один daemon;
2. создать session A и B;
3. отправить prompt A и prompt B параллельно;
4. собрать updates по `sessionId`.

Критерий успеха:

- оба prompt завершаются;
- updates можно надежно разделить по `sessionId`;
- нет deadlock;
- cancellation/close одной session не влияет на вторую.

### E4. Две ACP / по одной session

Цель: сравнить с моделью `1 process / 1 session`.

Проверить:

- два независимых процесса `opencode acp`;
- один prompt в каждом;
- параллельное выполнение;
- использование ресурсов;
- область последствий при kill одного process.

Критерий успеха:

- падение одного process не ломает второй;
- владение простое: process -> session -> step/attempt.

### E5. Разные model/effort/mode

Цель: понять область действия model routing.

Проверить:

- что возвращает `initialize` по config options;
- можно ли задать model на уровне session;
- можно ли сменить model между session;
- можно ли сменить effort/mode между session;
- как это выглядит в сырых ACP-сообщениях.

Критерий успеха:

- ясно, model/effort/mode process-scoped или session-scoped;
- понятно, может ли один ACP process обслуживать steps с разными model profiles.

### E6. `session/load` и `session/resume`

Цель: понять семантику persistence/reconnect.

Проверить:

- capabilities `loadSession`, `sessionCapabilities.resume`;
- создать session, закрыть client/process сценарии;
- попробовать `session/load`;
- попробовать `session/resume`;
- посмотреть, replay идет или нет.

Критерий успеха:

- понятно, что реально восстанавливается;
- понятно, связано ли это с reconnect после смерти Revo или только с session persistence.

### E7. Отмена

Цель: понять поведение stop.

Проверить:

- длинный prompt;
- `session/cancel`;
- итоговый stop reason;
- продолжает ли process жить;
- можно ли использовать ту же session/process после cancel.

Критерий успеха:

- понятен контракт для Revo timeout/cancel.

### E8. Запрос permission

Цель: понять интеграцию policy.

Проверить:

- OpenCode config/agent с permission `ask`;
- prompt, который требует tool;
- получить `session/request_permission`;
- ответить allow/deny;
- посмотреть итоговые updates/errors.

Критерий успеха:

- понятно, как AcpManager/runner должен отвечать на permission requests.

### E9. Переполнение context

Цель: понять поведение error/summarization.

Проверить:

- маленький context model/server;
- большой prompt/project cwd;
- увидеть `session/update`, финальный result/error;
- понять, будет ли OpenCode пытаться сжимать context.

Критерий успеха:

- понятно, является ли overflow retryable;
- понятно, какую диагностику сохранять в artifacts.

### E10. Ошибка Provider/API

Цель: понять маппинг ошибок.

Проверить:

- provider недоступен;
- некорректный API key или некорректный baseURL;
- model не найдена;
- форма финальной ошибки.

Критерий успеха:

- понятно, какие ошибки retryable;
- понятно, что показывать пользователю.

### E11. Падение client / reconnect

Цель: проверить самую важную lifecycle гипотезу.

Сценарии:

- убить PoC client, оставить child process если возможно;
- проверить, жив ли `opencode acp`;
- попробовать новым client подключиться к старому process;
- отдельно проверить `session/load`/`session/resume` в новом process.

Критерий успеха:

- ясно, можно ли считать `opencode acp` daemon с reconnect;
- если нет, зафиксировать ограничение для ADR.

## Матрица решений

После экспериментов заполняем:

| Вопрос | Ответ | Доказательство | Последствие для Revo |
|---|---|---|---|
| Один process держит несколько sessions? | TBD | сырой лог | scope daemon |
| Параллельные sessions работают? | TBD | сырой лог | pooling/concurrency |
| Model session-scoped? | TBD | сырой лог | routing профилей model |
| Stdio reconnect возможен? | TBD | сырой лог | стратегия перезапуска |
| Cancel надежен? | TBD | сырой лог | реализация timeout/cancel |
| Permission flow понятен? | TBD | сырой лог | policy роли |

## Предварительный вывод до экспериментов

До доказательства обратного v1 должен проектироваться консервативно:

```text
1 ACP process / 1 session / 1 step-or-attempt
```

`AcpManager` в этом варианте нужен не для pooling, а для lifecycle и наблюдаемости:

- запустить процесс;
- создать сессию;
- привязать владение к pipeline/run/step/attempt;
- стримить обновления;
- выполнить cancel/close/stop;
- сохранить desired/observed состояние;
- очистить осиротевшее состояние после перезапуска Revo.

Расширение до `1 ACP process / N sessions` допустимо только после успешных E2/E3/E5/E7/E11.
