import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type MatrixDiagnostic = Readonly<{
  code: 'MATRIX_SHAPE' | 'MATRIX_EVIDENCE_PATH' | 'MATRIX_FUTURE_CLAIM';
  message: string;
}>;

type CanonicalFamilyContract = Readonly<{
  owningLayer: string;
  owners: readonly string[];
  requiredEvidence: readonly string[];
}>;

const CANONICAL_FAMILY_CONTRACTS = {
  'pipeline-core': {
    owningLayer: 'unit',
    owners: ['src/pipeline-core'],
    requiredEvidence: ['src/pipeline-core/interpret.test.ts'],
  },
  'profiles-materialization': {
    owningLayer: 'unit',
    owners: ['src/pipeline-core', 'src/control-plane'],
    requiredEvidence: ['src/pipeline-core/materialize.test.ts', 'src/control-plane/run-profiles.test.ts'],
  },
  'static-default-policy': {
    owningLayer: 'static-policy',
    owners: ['src/testing/policy'],
    requiredEvidence: ['src/control-plane/default-playbook-policy.test.ts'],
  },
  'pipeline-declared-coverage': {
    owningLayer: 'static-policy',
    owners: ['src/testing/policy'],
    requiredEvidence: ['src/testing/policy/pipeline-coverage.ts', 'src/testing/policy/pipeline-coverage.test.ts'],
  },
  'observed-runtime-coverage': {
    owningLayer: 'pipeline-dsl',
    owners: ['future runtime evidence producer', 'future pipeline DSL evidence reader'],
    requiredEvidence: ['src/testing/policy/pipeline-coverage.ts', 'src/e2e/support/pipeline-context.ts'],
  },
  'representative-full-integration': {
    owningLayer: 'full-integration',
    owners: ['src/e2e/integration', 'src/e2e/support/integration-context.ts'],
    requiredEvidence: ['src/e2e/integration/run-lifecycle.e2e.test.ts'],
  },
  'mcp-surface': {
    owningLayer: 'surface-e2e',
    owners: ['src/mcp', 'src/e2e/surfaces/mcp', 'src/e2e/support/mcp-context.ts'],
    requiredEvidence: ['src/e2e/surfaces/mcp/stdio.e2e.test.ts'],
  },
  'graphql-surface': {
    owningLayer: 'surface-e2e',
    owners: ['src/api/graphql-api', 'src/e2e/surfaces/graphql', 'src/e2e/support/graphql-context.ts'],
    requiredEvidence: ['src/e2e/surfaces/graphql/graphql.e2e.test.ts'],
  },
  'cli-lifecycle': {
    owningLayer: 'surface-e2e',
    owners: ['src/cli', 'src/smoke', 'src/e2e/surfaces/cli'],
    requiredEvidence: ['src/e2e/surfaces/cli/lifecycle.e2e.test.ts'],
  },
  'runtime-host-lifecycle': {
    owningLayer: 'runtime-e2e',
    owners: ['src/e2e/runtime/lifecycle', 'src/e2e/support/runtime-lifecycle-context.ts'],
    requiredEvidence: ['src/e2e/runtime/lifecycle/host-lifecycle.e2e.test.ts'],
  },
  'runtime-recovery': {
    owningLayer: 'runtime-e2e',
    owners: ['src/e2e/runtime/recovery'],
    requiredEvidence: ['src/e2e/runtime/recovery/recovery.e2e.test.ts'],
  },
  'runtime-concurrency': {
    owningLayer: 'runtime-e2e',
    owners: ['src/e2e/runtime/concurrency', 'src/host'],
    requiredEvidence: ['src/e2e/runtime/concurrency/concurrency.e2e.test.ts'],
  },
  'runtime-teardown': {
    owningLayer: 'runtime-e2e',
    owners: ['src/e2e/runtime/concurrency', 'src/e2e/support', 'package.json', 'AGENTS.md'],
    requiredEvidence: ['src/e2e/runtime/concurrency/teardown-drain.e2e.test.ts'],
  },
  'provider-smoke': {
    owningLayer: 'manual-provider-smoke',
    owners: ['scripts'],
    requiredEvidence: ['scripts/smoke-claude-runner.ts', 'scripts/smoke-pr-poller.ts'],
  },
  'semantic-snapshots': {
    owningLayer: 'pipeline-dsl',
    owners: ['future pipeline DSL and runtime evidence contexts'],
    requiredEvidence: ['src/e2e/support/pipeline-context.ts', 'src/e2e/support/persisted-facts.ts'],
  },
  'structural-lint-meta-enforcement': {
    owningLayer: 'structural-enforcement',
    owners: ['eslint.config.mjs', 'eslint-local-rules', 'src/testing/policy', 'src/e2e/support', 'src/api/graphql-api'],
    requiredEvidence: [
      'eslint-local-rules/test-architecture-boundaries.js',
      'src/testing/policy/test-coverage-matrix.test.ts',
    ],
  },
  'ci-performance-governance': {
    owningLayer: 'structural-enforcement',
    owners: ['.github/workflows/ci.yml', 'package.json', 'AGENTS.md'],
    requiredEvidence: ['.github/workflows/ci.yml', 'package.json'],
  },
} as const satisfies Readonly<Record<string, CanonicalFamilyContract>>;

const CANONICAL_FAMILY_IDS = new Set(Object.keys(CANONICAL_FAMILY_CONTRACTS));

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateStringFields(
  diagnostics: MatrixDiagnostic[],
  value: Record<string, unknown>,
  path: string,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (!nonEmptyString(value[field])) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: `${path}.${field} must be a non-empty string` });
    }
  }
}

function validateStringArray(
  diagnostics: MatrixDiagnostic[],
  value: unknown,
  path: string,
  allowEmpty = false,
): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every(nonEmptyString)) {
    diagnostics.push({ code: 'MATRIX_SHAPE', message: `${path} must be ${allowEmpty ? 'a' : 'a non-empty'} string array` });
  }
}

function requireFields(
  diagnostics: MatrixDiagnostic[],
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  const object = record(value);
  if (!object) {
    diagnostics.push({ code: 'MATRIX_SHAPE', message: `${path} must be an object` });
    return undefined;
  }
  for (const field of fields) {
    if (!(field in object)) diagnostics.push({ code: 'MATRIX_SHAPE', message: `${path}.${field} is required` });
  }
  return object;
}

function validateEvidencePaths(
  diagnostics: MatrixDiagnostic[],
  repositoryRoot: string,
  value: unknown,
  path: string,
): void {
  if (!Array.isArray(value) || !value.every(nonEmptyString)) {
    diagnostics.push({ code: 'MATRIX_SHAPE', message: `${path} must be an array of repository-relative paths` });
    return;
  }
  for (const evidencePath of value) {
    const absolute = isAbsolute(evidencePath) || /^[A-Za-z]:[\\/]/.test(evidencePath);
    const escapesRoot = evidencePath.split(/[\\/]/).includes('..');
    if (absolute || escapesRoot) {
      diagnostics.push({ code: 'MATRIX_EVIDENCE_PATH', message: `${path} contains non-relative path ${evidencePath}` });
      continue;
    }
    if (!existsSync(resolve(repositoryRoot, evidencePath))) {
      diagnostics.push({ code: 'MATRIX_EVIDENCE_PATH', message: `${path} references missing path ${evidencePath}` });
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === sortedRight[index]);
}

function validateCanonicalFamily(
  diagnostics: MatrixDiagnostic[],
  repositoryRoot: string,
  family: Record<string, unknown>,
  familyPath: string,
): void {
  const id = nonEmptyString(family['id']) ? family['id'] : '';
  const contract = CANONICAL_FAMILY_CONTRACTS[id as keyof typeof CANONICAL_FAMILY_CONTRACTS];
  if (!contract) return;
  if (family['owningLayer'] !== contract.owningLayer) {
    diagnostics.push({
      code: 'MATRIX_SHAPE',
      message: `${familyPath} (${id}) must use canonical owning layer ${contract.owningLayer}`,
    });
  }
  const owners = Array.isArray(family['owner']) ? family['owner'].filter(nonEmptyString) : [];
  if (!sameStringSet(owners, contract.owners)) {
    diagnostics.push({
      code: 'MATRIX_SHAPE',
      message: `${familyPath} (${id}) has stale canonical owner set; ` +
        `expected canonical ${contract.owningLayer} owners ${JSON.stringify(contract.owners)}`,
    });
  }
  if (family['currentStatus'] !== 'not-implemented') {
    for (const owner of owners) {
      const absolute = isAbsolute(owner) || /^[A-Za-z]:[\\/]/.test(owner);
      const escapesRoot = owner.split(/[\\/]/).includes('..');
      if (absolute || escapesRoot || !existsSync(resolve(repositoryRoot, owner))) {
        diagnostics.push({ code: 'MATRIX_EVIDENCE_PATH', message: `${familyPath}.owner references invalid path ${owner}` });
      }
    }
  }
  const evidence = Array.isArray(family['evidencePaths']) ? family['evidencePaths'].filter(nonEmptyString) : [];
  for (const required of contract.requiredEvidence) {
    if (!evidence.includes(required)) {
      diagnostics.push({
        code: 'MATRIX_SHAPE',
        message: `${familyPath} (${id}) is missing canonical evidence ${required}`,
      });
    }
  }
}

function validateStageThreeBoundary(
  diagnostics: MatrixDiagnostic[],
  family: Record<string, unknown>,
  familyPath: string,
): void {
  if (family['targetStage'] !== 'stage-3' || family['currentStatus'] === 'not-implemented') return;
  const gaps = Array.isArray(family['gaps']) ? family['gaps'].filter(nonEmptyString) : [];
  const futureGap = gaps.join(' ').match(/observed|semantic trace|same-run|calibrated|runtime evidence/i);
  if (gaps.length === 0 || !futureGap) {
    diagnostics.push({
      code: 'MATRIX_FUTURE_CLAIM',
      message: `${familyPath} (${String(family['id'])}) targets Stage 3 but does not preserve its unimplemented Stage 3 gap`,
    });
  }
}

export function validateTestCoverageMatrix(matrix: unknown, repositoryRoot: string): MatrixDiagnostic[] {
  const diagnostics: MatrixDiagnostic[] = [];
  const root = requireFields(diagnostics, matrix, 'matrix', [
    'artifactKind',
    'schemaVersion',
    'snapshotStatus',
    'snapshotNotice',
    'source',
    'ownership',
    'statusLegend',
    'targetStageLegend',
    'performanceBaseline',
    'layers',
    'contractFamilies',
  ]);
  if (!root) return diagnostics;
  validateStringFields(diagnostics, root, 'matrix', [
    'artifactKind', 'schemaVersion', 'snapshotStatus', 'snapshotNotice',
  ]);

  const source = requireFields(diagnostics, root['source'], 'matrix.source', ['revision', 'branch', 'observedDate']);
  if (source) validateStringFields(diagnostics, source, 'matrix.source', ['revision', 'branch', 'observedDate']);
  const ownership = requireFields(diagnostics, root['ownership'], 'matrix.ownership', [
    'owner', 'normativeSpec', 'pipelinePolicySpec', 'architectureDecision',
  ]);
  if (ownership) {
    validateStringFields(diagnostics, ownership, 'matrix.ownership', [
      'owner', 'normativeSpec', 'pipelinePolicySpec', 'architectureDecision',
    ]);
  }
  const statusLegend = record(root['statusLegend']);
  const targetStageLegend = record(root['targetStageLegend']);
  for (const [legendName, legend] of [
    ['statusLegend', statusLegend],
    ['targetStageLegend', targetStageLegend],
  ] as const) {
    if (!legend || Object.keys(legend).length === 0 || !Object.values(legend).every(nonEmptyString)) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: `matrix.${legendName} must be a non-empty string map` });
    }
  }
  const performance = requireFields(diagnostics, root['performanceBaseline'], 'matrix.performanceBaseline', [
    'captureMethod',
    'sampleCount',
    'samples',
    'e2eJobSeconds',
    'combinedSetupPlusTestActionStepSeconds',
    'ciFileConcurrency',
    'localDefaultFileConcurrency',
    'localWallClockTargetSeconds',
    'evidencePaths',
  ]);
  if (performance) {
    if (!record(performance['captureMethod'])) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.captureMethod must be an object' });
    }
    if (!Number.isInteger(performance['sampleCount']) || Number(performance['sampleCount']) <= 0) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.sampleCount must be a positive integer' });
    }
    if (!Array.isArray(performance['samples']) || performance['samples'].length !== performance['sampleCount']) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.samples must match sampleCount' });
    }
    for (const field of ['e2eJobSeconds', 'combinedSetupPlusTestActionStepSeconds', 'localWallClockTargetSeconds']) {
      if (!record(performance[field])) {
        diagnostics.push({ code: 'MATRIX_SHAPE', message: `matrix.performanceBaseline.${field} must be an object` });
      }
    }
    for (const field of ['ciFileConcurrency', 'localDefaultFileConcurrency']) {
      if (!Number.isInteger(performance[field]) || Number(performance[field]) <= 0) {
        diagnostics.push({ code: 'MATRIX_SHAPE', message: `matrix.performanceBaseline.${field} must be a positive integer` });
      }
    }
    validateEvidencePaths(
      diagnostics,
      repositoryRoot,
      performance['evidencePaths'],
      'matrix.performanceBaseline.evidencePaths',
    );
  }

  const layers = root['layers'];
  const layerIds = new Set<string>();
  if (!Array.isArray(layers) || layers.length === 0) {
    diagnostics.push({ code: 'MATRIX_SHAPE', message: 'matrix.layers must be a non-empty array' });
  } else {
    layers.forEach((layer, index) => {
      const item = requireFields(diagnostics, layer, `matrix.layers[${index}]`, ['id', 'intent', 'policy', 'relativeCiCost']);
      if (item) {
        validateStringFields(diagnostics, item, `matrix.layers[${index}]`, ['id', 'intent', 'policy', 'relativeCiCost']);
        if (nonEmptyString(item['id'])) layerIds.add(item['id']);
      }
    });
  }

  const families = root['contractFamilies'];
  if (!Array.isArray(families) || families.length === 0) {
    diagnostics.push({ code: 'MATRIX_SHAPE', message: 'matrix.contractFamilies must be a non-empty array' });
    return diagnostics;
  }

  const familyIds = new Set<string>();
  for (const [index, value] of families.entries()) {
    const familyPath = `matrix.contractFamilies[${index}]`;
    const family = requireFields(diagnostics, value, familyPath, [
      'id',
      'family',
      'scope',
      'owningLayer',
      'owner',
      'policy',
      'currentStatus',
      'evidencePaths',
      'gaps',
      'relativeCiCost',
      'ciLane',
      'targetStage',
    ]);
    if (!family) continue;
    validateStringFields(diagnostics, family, familyPath, [
      'id', 'family', 'scope', 'owningLayer', 'policy', 'currentStatus', 'relativeCiCost', 'ciLane', 'targetStage',
    ]);
    if (nonEmptyString(family['id'])) {
      if (familyIds.has(family['id'])) {
        diagnostics.push({ code: 'MATRIX_SHAPE', message: `${familyPath}.id must be unique: ${family['id']}` });
      }
      familyIds.add(family['id']);
      if (!CANONICAL_FAMILY_IDS.has(family['id'])) {
        diagnostics.push({ code: 'MATRIX_SHAPE', message: `${familyPath} has unknown contract family ${family['id']}` });
      }
    }
    if (nonEmptyString(family['owningLayer']) && !layerIds.has(family['owningLayer'])) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: `${familyPath}.owningLayer is not declared in matrix.layers` });
    }
    if (nonEmptyString(family['currentStatus']) && !Object.hasOwn(statusLegend ?? {}, family['currentStatus'])) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: `${familyPath}.currentStatus is not declared in statusLegend` });
    }
    if (nonEmptyString(family['targetStage']) && !Object.hasOwn(targetStageLegend ?? {}, family['targetStage'])) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: `${familyPath}.targetStage is not declared in targetStageLegend` });
    }
    if (family['policy'] !== 'exhaustive' && family['policy'] !== 'representative') {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: `${familyPath}.policy must be exhaustive or representative` });
    }
    validateEvidencePaths(diagnostics, repositoryRoot, family['evidencePaths'], `${familyPath}.evidencePaths`);
    validateStringArray(diagnostics, family['owner'], `${familyPath}.owner`);
    validateStringArray(diagnostics, family['gaps'], `${familyPath}.gaps`, true);
    validateCanonicalFamily(diagnostics, repositoryRoot, family, familyPath);
    validateStageThreeBoundary(diagnostics, family, familyPath);

    const id = family['id'];
    if ((id === 'observed-runtime-coverage' || id === 'semantic-snapshots') &&
      family['currentStatus'] !== 'not-implemented') {
      diagnostics.push({
        code: 'MATRIX_FUTURE_CLAIM',
        message: `${familyPath} cannot claim Stage 3 runtime evidence during Stage 2`,
      });
    }
  }

  for (const id of CANONICAL_FAMILY_IDS) {
    if (!familyIds.has(id)) {
      diagnostics.push({ code: 'MATRIX_SHAPE', message: `matrix.contractFamilies is missing canonical family ${id}` });
    }
  }

  const notice = root['snapshotNotice'];
  if (!nonEmptyString(notice) || !/Stage 3/i.test(notice) || !/does not claim/i.test(notice)) {
    diagnostics.push({
      code: 'MATRIX_FUTURE_CLAIM',
      message: 'matrix.snapshotNotice must explicitly disclaim Stage 3 observed-runtime coverage',
    });
  }
  return diagnostics;
}
