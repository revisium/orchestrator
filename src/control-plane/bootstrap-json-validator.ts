import { Ajv, type ValidateFunction } from 'ajv';
import { ControlPlaneError } from './errors.js';
import { formatAjvErrors } from '../schema/ajv-errors.js';

type BootstrapRow = { tableId: string; rowId: string; data: Record<string, unknown> };
type JsonSchema = Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: false });

const jsonObjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
};

const modelProfileParamsSchema: JsonSchema = {
  type: 'object',
  properties: {
    maxTurns: { type: 'integer', minimum: 1 },
    max_turns: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const routingPolicyRuleSchema: JsonSchema = {
  type: 'object',
  properties: {
    max_review_iterations: { type: 'integer', minimum: 1 },
    max_attempts: { type: 'integer', minimum: 1 },
    budget_usd: { type: 'number', minimum: 0 },
    budget_tokens: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const validateJsonObject = ajv.compile(jsonObjectSchema);
const validateModelProfileParams = ajv.compile(modelProfileParamsSchema);
const validateRoutingPolicyRule = ajv.compile(routingPolicyRuleSchema);

function parseSerializedJson(value: unknown, context: string): unknown {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') {
    throw new ControlPlaneError('VALIDATION_FAILURE', `${context} must be a serialized JSON string`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ControlPlaneError('VALIDATION_FAILURE', `${context} must be valid serialized JSON`, { details: error });
  }
}

function assertValidSerializedJsonField(
  row: BootstrapRow,
  field: string,
  validate: ValidateFunction,
  schemaName: string,
): void {
  if (!(field in row.data)) return;
  const context = `bootstrap row ${row.tableId}/${row.rowId}.${field}`;
  const parsed = parseSerializedJson(row.data[field], context);
  if (validate(parsed)) return;
  throw new ControlPlaneError(
    'VALIDATION_FAILURE',
    `${context} violates ${schemaName} schema: ${formatAjvErrors(validate.errors)}`,
  );
}

export function validateBootstrapJsonFields(rows: BootstrapRow[]): void {
  for (const row of rows) {
    if (row.tableId === 'roles') {
      assertValidSerializedJsonField(row, 'scope_rules', validateJsonObject, 'role scope_rules');
    }
    if (row.tableId === 'model_profiles') {
      assertValidSerializedJsonField(row, 'params', validateModelProfileParams, 'model profile params');
    }
    if (row.tableId === 'routing_policy') {
      assertValidSerializedJsonField(row, 'rule', validateRoutingPolicyRule, 'routing policy rule');
    }
  }
}
