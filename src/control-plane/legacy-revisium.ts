import { ControlPlaneError } from './errors.js';

export function legacyRevisiumDisabled(context: string): never {
  throw new ControlPlaneError(
    'LEGACY_REVISIUM_DISABLED',
    `${context} is disabled. Use the embedded engine storage path instead.`,
  );
}
