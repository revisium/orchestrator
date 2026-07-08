import type { ErrorObject } from 'ajv';

function errorPath(error: ErrorObject): string {
  const base = error.instancePath || '/';
  const params = error.params as { missingProperty?: unknown; additionalProperty?: unknown };
  if (typeof params.missingProperty === 'string') return `${base === '/' ? '' : base}/${params.missingProperty}`;
  if (typeof params.additionalProperty === 'string') return `${base === '/' ? '' : base}/${params.additionalProperty}`;
  return base;
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${errorPath(error)} ${error.message ?? 'is invalid'}`)
    .join('; ');
}
