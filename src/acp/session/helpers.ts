import type { AcpCanonicalObject } from '../protocol/values.js';

export type DeferredPromise<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

export function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function ownString(value: object, key: 'name' | 'message'): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function snapshotSessionError(error: unknown): AcpCanonicalObject {
  if (typeof error !== 'object' || error === null) {
    return { name: 'Error', message: 'ACP session operation failed' };
  }
  const name = ownString(error, 'name') ?? 'Error';
  const message = ownString(error, 'message') ?? 'ACP session operation failed';
  return { name, message };
}
