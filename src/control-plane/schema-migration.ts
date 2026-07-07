type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function schemaProperties(schema: unknown): JsonRecord {
  if (!isRecord(schema)) return {};
  return isRecord(schema.properties) ? schema.properties : {};
}

function stableJson(value: unknown): string {
  if (!isRecord(value) && !Array.isArray(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function computeAdditiveSchemaPatches(currentSchema: unknown, desiredSchema: unknown): JsonRecord[] {
  const currentProps = schemaProperties(currentSchema);
  const desiredProps = schemaProperties(desiredSchema);
  const patches: JsonRecord[] = [];

  for (const [name, desired] of Object.entries(desiredProps)) {
    const path = `/properties/${escapePointer(name)}`;
    if (!(name in currentProps)) {
      patches.push({ op: 'add', path, value: desired });
      continue;
    }
    if (stableJson(currentProps[name]) !== stableJson(desired)) {
      patches.push({ op: 'replace', path, value: desired });
    }
  }

  return patches;
}
