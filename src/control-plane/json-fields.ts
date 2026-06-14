import { ControlPlaneError } from './errors.js';
import type { RuntimeTable } from './tables.js';

export type PatchOperation = {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
};

const jsonFields: Partial<Record<RuntimeTable, readonly string[]>> = {
  task_runs: ['params', 'route_decision', 'execution_profile'],
  steps: ['input', 'output'],
  events: ['payload'],
  inbox: ['context', 'answer'],
};

function fieldsFor(table: RuntimeTable): readonly string[] {
  return jsonFields[table] ?? [];
}

function pathRoot(path: string): string {
  return path.replace(/^\/+/, '').split(/[/.]/, 1)[0] ?? '';
}

function pathIsNestedJsonField(table: RuntimeTable, path: string): boolean {
  const normalized = path.replace(/^\/+/, '');
  return fieldsFor(table).some((field) => normalized.startsWith(`${field}.`) || normalized.startsWith(`${field}/`));
}

export function serializeData(table: RuntimeTable, rowId: string, data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.id === 'string' && data.id !== rowId) {
    throw new ControlPlaneError('VALIDATION_FAILURE', `data.id must match rowId for ${table}/${rowId}`, {
      details: { table, rowId, field: 'id', value: data.id },
    });
  }

  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...data, id: data.id ?? rowId })) {
    if (value === undefined) continue;
    serialized[key] = fieldsFor(table).includes(key) ? JSON.stringify(value) : value;
  }
  return serialized;
}

export function deserializeData(
  table: RuntimeTable,
  rowId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const deserialized: Record<string, unknown> = { ...data };
  for (const field of fieldsFor(table)) {
    const value = deserialized[field];
    if (value === undefined || value === '') {
      deserialized[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw new ControlPlaneError('VALIDATION_FAILURE', `Expected serialized JSON string at ${table}/${rowId}.${field}`, {
        details: { table, rowId, field, value },
      });
    }
    try {
      deserialized[field] = JSON.parse(value);
    } catch (error) {
      throw new ControlPlaneError('VALIDATION_FAILURE', `Invalid stored JSON at ${table}/${rowId}.${field}`, {
        details: { table, rowId, field, value, error },
      });
    }
  }
  return deserialized;
}

export function serializePatches(table: RuntimeTable, patches: PatchOperation[]): PatchOperation[] {
  return patches.map((patch) => {
    const root = pathRoot(patch.path);
    if (pathIsNestedJsonField(table, patch.path)) {
      throw new ControlPlaneError('VALIDATION_FAILURE', `Nested JSON field patches are not supported: ${patch.path}`, {
        details: { table, path: patch.path },
      });
    }
    if (!fieldsFor(table).includes(root) || !('value' in patch) || patch.value === undefined) return { ...patch };
    return { ...patch, value: JSON.stringify(patch.value) };
  });
}
