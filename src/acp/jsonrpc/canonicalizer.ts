import type { JsonRpcValue } from './types.js';

const MAX_JSON_DEPTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isolateInheritedJsonHook<T extends object>(value: T): T {
  Object.defineProperty(value, 'toJSON', {
    configurable: true,
    enumerable: false,
    value: undefined,
    writable: true,
  });
  return value;
}

function isJsonHookSentinel(key: PropertyKey, descriptor: PropertyDescriptor | undefined): boolean {
  return key === 'toJSON' && descriptor !== undefined && !descriptor.enumerable &&
    descriptor.configurable === true && descriptor.writable === true && descriptor.value === undefined;
}

export function snapshotJsonRpcRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const snapshot = isolateInheritedJsonHook<Record<string, unknown>>({});
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (isJsonHookSentinel(key, descriptor)) continue;
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

type JsonContainerEntries = {
  kind: 'array' | 'object';
  entries: Array<{ key: number | string; value: unknown }>;
};

function jsonContainerEntries(value: object): JsonContainerEntries | undefined {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    const entries: JsonContainerEntries['entries'] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      entries.push({ key: index, value: descriptor.value });
    }
    for (const key of keys) {
      if (typeof key !== 'string') return undefined;
      if (key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (isJsonHookSentinel(key, descriptor)) continue;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
        return undefined;
      }
    }
    return { kind: 'array', entries };
  }
  if (!isRecord(value)) return undefined;
  const entries: JsonContainerEntries['entries'] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (isJsonHookSentinel(key, descriptor)) continue;
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    entries.push({ key, value: descriptor.value });
  }
  return { kind: 'object', entries };
}

export function canonicalizeJsonRpcValue(value: unknown): JsonRpcValue | undefined {
  type Container = JsonRpcValue[] | { [key: string]: JsonRpcValue };
  type Frame =
    | { kind: 'enter'; value: unknown; depth: number; parent?: Container; key?: number | string }
    | { kind: 'leave'; value: object };
  const ancestors = new WeakSet<object>();
  const stack: Frame[] = [{ kind: 'enter', value, depth: 1 }];
  let result: JsonRpcValue | undefined;

  function assign(frame: Extract<Frame, { kind: 'enter' }>, canonical: JsonRpcValue): void {
    if (!frame.parent) {
      result = canonical;
      return;
    }
    if (Array.isArray(frame.parent)) {
      frame.parent[frame.key as number] = canonical;
      return;
    }
    Object.defineProperty(frame.parent, frame.key as string, {
      configurable: true,
      enumerable: true,
      value: canonical,
      writable: true,
    });
  }

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === 'leave') {
        ancestors.delete(frame.value);
        continue;
      }
      const current = frame.value;
      if (frame.depth > MAX_JSON_DEPTH) return undefined;
      if (current === null || typeof current === 'string' || typeof current === 'boolean') {
        assign(frame, current);
        continue;
      }
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return undefined;
        assign(frame, current);
        continue;
      }
      if (typeof current !== 'object') return undefined;
      const containerEntries = jsonContainerEntries(current);
      if (!containerEntries || ancestors.has(current)) return undefined;
      const canonical: Container = containerEntries.kind === 'array'
        ? isolateInheritedJsonHook<JsonRpcValue[]>([])
        : isolateInheritedJsonHook<{ [key: string]: JsonRpcValue }>({});
      assign(frame, canonical);
      ancestors.add(current);
      stack.push({ kind: 'leave', value: current });
      for (let index = containerEntries.entries.length - 1; index >= 0; index -= 1) {
        const entry = containerEntries.entries[index]!;
        stack.push({
          kind: 'enter',
          value: entry.value,
          depth: frame.depth + 1,
          parent: canonical,
          key: entry.key,
        });
      }
    }
  } catch {
    return undefined;
  }
  return result;
}
