/**
 * data-driven-template.ts — read + validate the PINNED state-machine template for a run.
 *
 * MVP STORAGE: the data-driven template is carried inside the pipeline row's
 * `execution_policy` under a `template_json` key — the only free-form slot that round-trips through
 * playbook install with NO control-plane schema migration. A pipeline is DATA-DRIVEN iff that template
 * parses, declares `specVersion` + `nodes`, and validates clean via `pipeline-core.validateTemplate`
 * (the authoritative validator). Native Revisium typing / a dedicated `template_json` column is a
 * strictly-additive later upgrade (the Desktop handoff tracks it).
 *
 * Pure + I/O-free: it inspects already-loaded `executionPolicy` data. The adapter pins the returned
 * template as a DBOS workflow argument (durable on recovery), so selection reads it once at run start.
 */

import { validateTemplate, type Template } from '../pipeline-core/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A loose structural pre-check before handing to the authoritative validator: a `specVersion` string
 * and a `nodes` object. (validateTemplate then does the full validation closure.)
 */
function looksLikeTemplate(value: unknown): value is Template {
  return isRecord(value) && typeof value.specVersion === 'string' && isRecord(value.nodes);
}

/**
 * Extract a data-driven template from a pipeline's executionPolicy, if present + valid.
 *
 * Returns the validated `Template` when the pipeline carries a clean state-machine spec, else `null`
 * (→ the caller fails loud with `PIPELINE_NOT_DATA_DRIVEN`; the data-driven engine is the sole engine, so
 * there is no legacy fallback path). A present-but-INVALID template throws, so a broken data-driven pipeline
 * fails loudly at run start rather than silently degrading (which would mask the authoring bug).
 */
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
