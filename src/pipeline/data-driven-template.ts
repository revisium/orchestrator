











import { validateTemplate, type Template } from '../pipeline-core/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}



function looksLikeTemplate(value: unknown): value is Template {
  return isRecord(value) && typeof value.specVersion === 'string' && isRecord(value.nodes);
}







export function templateFromExecutionPolicy(executionPolicy: unknown): Template | null {
  if (!isRecord(executionPolicy)) return null;
  const raw = executionPolicy.template_json ?? executionPolicy.templateJson;
  if (raw === undefined || raw === null) return null;

  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!looksLikeTemplate(parsed)) {
    throw new Error('DATA_DRIVEN_TEMPLATE_MALFORMED: execution_policy.template_json is not a template');
  }
  const errors = validateTemplate(parsed).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `DATA_DRIVEN_TEMPLATE_INVALID: ${parsed.pipelineId} — ${errors.map((d) => d.code).join(', ')}`,
    );
  }
  return parsed;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('DATA_DRIVEN_TEMPLATE_MALFORMED: execution_policy.template_json is not valid JSON');
  }
}
