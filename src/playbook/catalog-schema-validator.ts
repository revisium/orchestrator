import { Ajv, type ValidateFunction } from 'ajv';
import { FAILURE_POLICIES, TERMINAL_STATUSES } from '../pipeline-core/types.js';
import { RunProfileContractError, validateRunProfile } from '../control-plane/run-profile-contract.js';
import { PlaybookError } from './errors.js';
import { formatAjvErrors } from '../schema/ajv-errors.js';

type JsonSchema = Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: false });

const NON_EMPTY_STRING = { type: 'string', minLength: 1 } as const;
const STRING_ARRAY = { type: 'array', items: NON_EMPTY_STRING } as const;

const producesSchema: JsonSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: NON_EMPTY_STRING },
  additionalProperties: false,
};

const consumesSchema: JsonSchema = {
  type: 'object',
  required: ['node', 'as'],
  properties: {
    node: NON_EMPTY_STRING,
    as: NON_EMPTY_STRING,
    iteration: { anyOf: [{ enum: ['latest', 'all'] }, { type: 'integer' }] },
    optional: { type: 'boolean' },
    staleOk: { type: 'boolean' },
  },
  additionalProperties: false,
};

const gateArtifactSchema: JsonSchema = {
  type: 'object',
  required: ['node'],
  properties: {
    node: NON_EMPTY_STRING,
    as: NON_EMPTY_STRING,
    iteration: { anyOf: [{ enum: ['latest', 'all'] }, { type: 'integer' }] },
  },
  additionalProperties: false,
};

const catchSchema: JsonSchema = {
  type: 'object',
  required: ['onError', 'goto'],
  properties: {
    onError: { type: 'string', pattern: String.raw`^revo\.[A-Za-z][A-Za-z0-9]*$` },
    goto: NON_EMPTY_STRING,
  },
  additionalProperties: false,
};

const branchSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['when', 'goto'],
      properties: {
        when: { $ref: '#/$defs/condition' },
        goto: NON_EMPTY_STRING,
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['default'],
      properties: { default: NON_EMPTY_STRING },
      additionalProperties: false,
    },
  ],
};

const effectProperties: Record<string, unknown> = {
  next: NON_EMPTY_STRING,
  catch: { type: 'array', items: catchSchema },
  resultSchema: NON_EMPTY_STRING,
  onFailure: { enum: FAILURE_POLICIES },
  escalateTo: NON_EMPTY_STRING,
  incrementCounters: STRING_ARRAY,
  produces: producesSchema,
  consumes: { type: 'array', items: consumesSchema },
};

const agentNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'roleRef', 'next'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'agent' },
    roleRef: NON_EMPTY_STRING,
    ...effectProperties,
  },
  additionalProperties: false,
};

const scriptNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'scriptRef', 'next'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'script' },
    scriptRef: NON_EMPTY_STRING,
    ...effectProperties,
  },
  additionalProperties: false,
};

const humanGateNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'reason', 'outcomes', 'branches'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'humanGate' },
    reason: NON_EMPTY_STRING,
    outcomes: STRING_ARRAY,
    branches: { type: 'array', minItems: 1, items: branchSchema },
    timeout: {
      type: 'object',
      required: ['after', 'goto'],
      properties: { after: NON_EMPTY_STRING, goto: NON_EMPTY_STRING },
      additionalProperties: false,
    },
    incrementCounters: STRING_ARRAY,
    produces: producesSchema,
    gatedArtifact: gateArtifactSchema,
    verdictFrom: gateArtifactSchema,
  },
  additionalProperties: false,
};

const choiceNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'branches'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'choice' },
    branches: { type: 'array', minItems: 1, items: branchSchema },
    incrementCounters: STRING_ARRAY,
  },
  additionalProperties: false,
};

const parallelNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'branches', 'join'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'parallel' },
    branches: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['id', 'entry'],
        properties: { id: NON_EMPTY_STRING, entry: NON_EMPTY_STRING },
        additionalProperties: false,
      },
    },
    join: NON_EMPTY_STRING,
  },
  additionalProperties: false,
};

const joinNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'joinMode', 'next'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'join' },
    joinMode: {
      oneOf: [
        {
          type: 'object',
          required: ['kind'],
          properties: { kind: { enum: ['all', 'any'] } },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['kind', 'count'],
          properties: { kind: { const: 'quorum' }, count: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        },
      ],
    },
    merge: { type: 'object', additionalProperties: { enum: ['overwrite', 'appendByBranchOrder'] } },
    verdictReducer: {
      type: 'object',
      required: ['kind', 'pass', 'passVerdict', 'failVerdict'],
      properties: {
        kind: { const: 'allIn' },
        pass: STRING_ARRAY,
        passVerdict: NON_EMPTY_STRING,
        failVerdict: NON_EMPTY_STRING,
      },
      additionalProperties: false,
    },
    next: NON_EMPTY_STRING,
  },
  additionalProperties: false,
};

const waitNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'duration', 'next'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'wait' },
    duration: NON_EMPTY_STRING,
    next: NON_EMPTY_STRING,
  },
  additionalProperties: false,
};

const terminalNodeSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'kind', 'status'],
  properties: {
    id: NON_EMPTY_STRING,
    displayName: NON_EMPTY_STRING,
    kind: { const: 'terminal' },
    status: { enum: TERMINAL_STATUSES },
  },
  additionalProperties: false,
};

const pipelineExecutionPolicySchema: JsonSchema = {
  type: 'object',
  properties: {
    raw: { type: 'array', items: { type: 'string' } },
    template_json: { $ref: '#/$defs/template' },
  },
  additionalProperties: true,
  $defs: {
    condition: {
      oneOf: [
        {
          type: 'object',
          required: ['op', 'value'],
          properties: { op: { const: 'verdict.eq' }, value: NON_EMPTY_STRING },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['op', 'value'],
          properties: { op: { const: 'verdict.in' }, value: STRING_ARRAY },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['op', 'scope', 'value'],
          properties: {
            op: { enum: ['counter.lt', 'counter.gte'] },
            scope: NON_EMPTY_STRING,
            value: { type: 'number' },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['op', 'of'],
          properties: {
            op: { const: 'all' },
            of: { type: 'array', minItems: 1, items: { $ref: '#/$defs/condition' } },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['op', 'of'],
          properties: {
            op: { const: 'any' },
            of: { type: 'array', minItems: 1, items: { $ref: '#/$defs/condition' } },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['op', 'cond'],
          properties: {
            op: { const: 'not' },
            cond: { $ref: '#/$defs/condition' },
          },
          additionalProperties: false,
        },
      ],
    },
    node: {
      oneOf: [
        agentNodeSchema,
        scriptNodeSchema,
        humanGateNodeSchema,
        choiceNodeSchema,
        parallelNodeSchema,
        joinNodeSchema,
        waitNodeSchema,
        terminalNodeSchema,
      ],
    },
    template: {
      type: 'object',
      required: ['specVersion', 'pipelineId', 'entry', 'verdicts', 'nodes'],
      properties: {
        specVersion: NON_EMPTY_STRING,
        pipelineId: NON_EMPTY_STRING,
        title: NON_EMPTY_STRING,
        entry: NON_EMPTY_STRING,
        verdicts: {
          type: 'object',
          required: ['domain'],
          properties: { domain: STRING_ARRAY },
          additionalProperties: true,
        },
        policy: {
          type: 'object',
          required: ['conflicts', 'enforcement'],
          properties: {
            conflicts: {
              type: 'array',
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: NON_EMPTY_STRING,
              },
            },
            enforcement: { enum: ['strict', 'warn'] },
          },
          additionalProperties: false,
        },
        scopes: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['cap', 'parent'],
            properties: {
              cap: { type: 'integer', minimum: 1 },
              parent: { anyOf: [NON_EMPTY_STRING, { type: 'null' }] },
            },
            additionalProperties: false,
          },
        },
        nodes: {
          type: 'object',
          minProperties: 1,
          additionalProperties: { $ref: '#/$defs/node' },
        },
      },
      additionalProperties: false,
    },
  },
};

const validatePipelineExecutionPolicy = ajv.compile(pipelineExecutionPolicySchema);

function assertValid(validate: ValidateFunction, value: unknown, context: string, schemaName: string): void {
  if (validate(value)) return;
  throw new PlaybookError(
    'PLAYBOOK_INVALID_CATALOG',
    `${context} violates ${schemaName} schema: ${formatAjvErrors(validate.errors)}`,
  );
}

export function assertValidPipelineExecutionPolicy(value: unknown, context: string): void {
  assertValid(validatePipelineExecutionPolicy, value, context, 'pipeline execution_policy');
}

export function assertValidRunProfileCatalogRecord(value: unknown, context: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context} violates run-profile/v1: profile must be an object`, {
      code: 'profile_schema_invalid',
      path: context,
    });
  }
  const record = value as Record<string, unknown>;
  const required = ['id', 'pipelineId', 'schemaVersion', 'version', 'displayName', 'summary', 'topology', 'bindings', 'status'];
  for (const key of required) {
    if (!(key in record)) {
      throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context} violates run-profile/v1: missing ${key}`, {
        code: 'profile_schema_invalid',
        path: `${context}.${key}`,
      });
    }
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key)) {
      throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context} violates run-profile/v1: unknown field ${key}`, {
        code: 'profile_schema_invalid',
        path: `${context}.${key}`,
      });
    }
  }
  for (const key of ['id', 'pipelineId', 'schemaVersion', 'version', 'displayName', 'summary']) {
    if (typeof record[key] !== 'string' || (record[key] as string).trim() === '') {
      throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.${key} must be a non-empty string`, {
        code: 'profile_schema_invalid',
        path: `${context}.${key}`,
      });
    }
  }
  if (record.status !== 'active' && record.status !== 'deprecated') {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.status must be active or deprecated`, {
      code: 'profile_schema_invalid',
      path: `${context}.status`,
    });
  }
  try {
    const normalized = validateRunProfile({
      schemaVersion: record.schemaVersion,
      topology: record.topology,
      bindings: record.bindings,
    });
    if (Object.keys(normalized.topology.stages).length === 0 || Object.keys(normalized.bindings.slots).length === 0) {
      throw new RunProfileContractError('profile_schema_invalid', 'catalog profiles require at least one stage and binding', context);
    }
  } catch (error) {
    const contractError = error instanceof RunProfileContractError ? error : undefined;
    throw new PlaybookError(
      'PLAYBOOK_INVALID_CATALOG',
      `${context} violates run-profile/v1: ${error instanceof Error ? error.message : String(error)}`,
      { code: contractError?.code ?? 'profile_schema_invalid', path: contractError?.path ?? context },
    );
  }
}

export function assertValidInlineRunProfile(value: unknown, context: string): void {
  try {
    validateRunProfile(value);
  } catch (error) {
    const contractError = error instanceof RunProfileContractError ? error : undefined;
    throw new PlaybookError(
      'PLAYBOOK_INVALID_CATALOG',
      `${context} violates run-profile/v1: ${error instanceof Error ? error.message : String(error)}`,
      { code: contractError?.code ?? 'profile_schema_invalid', path: contractError?.path ?? context },
    );
  }
}
