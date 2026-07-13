import type { JsonRpcValue } from './types.js';

const MAX_JSON_DEPTH = 256;

type JsonContainer = JsonRpcValue[] | { [key: string]: JsonRpcValue };

type JsonContainerEntries = {
  kind: 'array' | 'object';
  entries: Array<{ key: number | string; value: unknown }>;
};

type EnterFrame = {
  kind: 'enter';
  value: unknown;
  depth: number;
  parent?: JsonContainer;
  key?: number | string;
};

type Frame = EnterFrame | { kind: 'leave'; value: object };

type JsonValueKind =
  | { kind: 'container'; value: object }
  | { kind: 'invalid' }
  | { kind: 'primitive'; value: JsonRpcValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isolateInheritedRuntimeHooks<T extends object>(value: T): T {
  Object.defineProperty(value, 'toJSON', {
    configurable: true,
    enumerable: false,
    value: undefined,
    writable: true,
  });
  Object.defineProperty(value, 'then', { // NOSONAR: prevents inherited thenables from affecting Promise resolution.
    configurable: true,
    enumerable: false,
    value: undefined,
    writable: true,
  });
  return value;
}

function isRuntimeHookSentinel(key: PropertyKey, descriptor: PropertyDescriptor | undefined): boolean {
  return (key === 'toJSON' || key === 'then') && descriptor !== undefined && !descriptor.enumerable &&
    descriptor.configurable === true && descriptor.writable === true && descriptor.value === undefined;
}

function enumerableDataProperty(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && 'value' in descriptor ? descriptor : undefined;
}

export function snapshotJsonRpcRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const snapshot = isolateInheritedRuntimeHooks<Record<string, unknown>>({});
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (isRuntimeHookSentinel(key, descriptor)) continue;
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function jsonContainerEntries(value: object): JsonContainerEntries | undefined {
  if (Array.isArray(value)) return arrayEntries(value);
  return isRecord(value) ? objectEntries(value) : undefined;
}

function arrayEntries(value: unknown[]): JsonContainerEntries | undefined {
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = arrayLength(value);
  if (length === undefined || !hasCompleteArrayIndexes(value, length)) return undefined;

  const entries: JsonContainerEntries['entries'] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = enumerableDataProperty(value, String(index));
    if (!descriptor) return undefined;
    entries.push({ key: index, value: descriptor.value });
  }
  return { kind: 'array', entries };
}

function arrayLength(value: unknown[]): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!descriptor || !('value' in descriptor)) return undefined;
  return Number.isSafeInteger(descriptor.value) && descriptor.value >= 0 ? descriptor.value : undefined;
}

function hasCompleteArrayIndexes(value: unknown[], length: number): boolean {
  let ownIndexKeyCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    const index = arrayIndexForKey(value, key, length);
    if (index === undefined) return false;
    if (index !== null) ownIndexKeyCount += 1;
  }
  return ownIndexKeyCount === length;
}

function arrayIndexForKey(value: unknown[], key: PropertyKey, length: number): number | null | undefined {
  if (key === 'length') return null;
  if (typeof key !== 'string') return undefined;
  if ((key === 'toJSON' || key === 'then') &&
      isRuntimeHookSentinel(key, Object.getOwnPropertyDescriptor(value, key))) {
    return null;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
    ? index
    : undefined;
}

function objectEntries(value: Record<string, unknown>): JsonContainerEntries | undefined {
  const entries: JsonContainerEntries['entries'] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (isRuntimeHookSentinel(key, descriptor)) continue;
    const dataProperty = enumerableDataProperty(value, key);
    if (!dataProperty) return undefined;
    entries.push({ key, value: dataProperty.value });
  }
  return { kind: 'object', entries };
}

function classifyJsonValue(value: unknown): JsonValueKind {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { kind: 'primitive', value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { kind: 'primitive', value } : { kind: 'invalid' };
  }
  return typeof value === 'object' ? { kind: 'container', value } : { kind: 'invalid' };
}

function assignCanonicalValue(
  frame: EnterFrame,
  value: JsonRpcValue,
  state: { result: JsonRpcValue | undefined },
): void {
  if (!frame.parent) {
    state.result = value;
    return;
  }
  if (Array.isArray(frame.parent)) {
    frame.parent[frame.key as number] = value;
    return;
  }
  Object.defineProperty(frame.parent, frame.key as string, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function createCanonicalContainer(entries: JsonContainerEntries): JsonContainer {
  return entries.kind === 'array'
    ? isolateInheritedRuntimeHooks<JsonRpcValue[]>([])
    : isolateInheritedRuntimeHooks<{ [key: string]: JsonRpcValue }>({});
}

function queueEntries(
  stack: Frame[],
  entries: JsonContainerEntries['entries'],
  depth: number,
  parent: JsonContainer,
): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    stack.push({ kind: 'enter', value: entry.value, depth: depth + 1, parent, key: entry.key });
  }
}

export function canonicalizeJsonRpcValue(value: unknown): JsonRpcValue | undefined {
  const ancestors = new WeakSet<object>();
  const stack: Frame[] = [{ kind: 'enter', value, depth: 1 }];
  const state: { result: JsonRpcValue | undefined } = { result: undefined };

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === 'leave') {
        ancestors.delete(frame.value);
        continue;
      }
      if (frame.depth > MAX_JSON_DEPTH) return undefined;
      const classified = classifyJsonValue(frame.value);
      if (classified.kind === 'invalid') return undefined;
      if (classified.kind === 'primitive') {
        assignCanonicalValue(frame, classified.value, state);
        continue;
      }
      const entries = jsonContainerEntries(classified.value);
      if (!entries || ancestors.has(classified.value)) return undefined;
      const canonical = createCanonicalContainer(entries);
      assignCanonicalValue(frame, canonical, state);
      ancestors.add(classified.value);
      stack.push({ kind: 'leave', value: classified.value });
      queueEntries(stack, entries.entries, frame.depth, canonical);
    }
  } catch {
    return undefined;
  }
  return state.result;
}
