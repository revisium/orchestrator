# ACP + OpenCode Research / Исследование ACP + OpenCode

- **Status / Статус:** Pre-ADR research / исследование перед ADR.
- **Date / Дата:** 2026-07-08.

This directory is mirrored by language: `en/` contains English docs, `ru/` contains Russian docs with the same facts, artifact paths, commands, model IDs, counts, and conclusions.

Эта директория зеркалирована по языкам: `en/` содержит английские документы, `ru/` содержит русские документы с теми же фактами, путями артефактов, командами, model IDs, счетчиками и выводами.

## English Read Order

1. [Documentation review](./en/documentation-review.md) - documentation facts, unknowns, and initial Revo implications.
2. [Experiment matrix](./en/experiment-matrix.md) - hypotheses, PoC harness requirements, and experiment matrix.
3. [External provider setup](./en/external-provider-setup.md) - research-only setup for free external OpenCode providers/models.
4. [Experiment results 2026-07-08](./en/experiment-results-2026-07-08.md) - local PoC results and follow-up gaps from July 8, 2026.

## Русский порядок чтения

1. [Обзор документации](./ru/documentation-review.md) - факты документации, неизвестные и предварительные последствия для Revo.
2. [Матрица экспериментов](./ru/experiment-matrix.md) - гипотезы, требования к PoC harness и матрица экспериментов.
3. [Настройка внешнего provider](./ru/external-provider-setup.md) - research-only setup для бесплатных внешних OpenCode providers/models.
4. [Результаты экспериментов 2026-07-08](./ru/experiment-results-2026-07-08.md) - локальные результаты PoC и follow-up gaps от 2026-07-08.

Raw JSONL artifacts from the local PoC runs were written outside the repository / Raw JSONL артефакты локальных PoC-прогонов записаны вне репозитория:

```text
/tmp/revo-opencode-acp-research-artifacts/*.jsonl
```

Those artifacts are local evidence from bounded PoC runs, not a committed contract or reusable fixture set. Treat the results as input to the future ADR/spec, and re-run or refresh the experiments if the OpenCode version, provider setup, model, sandbox, or ACP implementation changes.

Эти артефакты являются локальными evidence из bounded PoC-прогонов, а не закоммиченным contract или reusable fixture set. Используйте результаты как input для будущих ADR/spec и повторяйте или обновляйте эксперименты при изменении OpenCode version, provider setup, model, sandbox или ACP implementation.
