/**
 * needsHost() — pure argv pre-parse (no Nest/DBOS import).
 *
 * Returns true ONLY for host-requiring commands (dev:ping, dev:status in slice 0001).
 * Everything else — including --help, --version, revisium/bootstrap/run/work — is host-free.
 *
 * Design rules:
 *   - Help/version flags anywhere → always host-free (consensus MINOR, codex round 2).
 *   - Default is host-free (allowlist miss → false); fail-safe for unknown commands.
 *   - No Nest, DBOS, or AppModule imports here (F1 — keep the host-free path lightweight).
 */

/** Commands that require the Nest/DBOS host context in slice 0001. */
const HOST_COMMANDS = new Set(['dev:ping', 'dev:status']);

/** Flags that force host-free regardless of the command. */
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-v']);

/**
 * Decide whether an argv array needs the Nest host context.
 * @param argv - process.argv-style array (first two elements are node + script).
 */
export function needsHost(argv: string[]): boolean {
  const args = argv.slice(2); // strip node + script

  // Any help/version flag anywhere → host-free.
  if (args.some((a) => HELP_FLAGS.has(a))) return false;

  // Find the first non-flag argument (the command name).
  const command = args.find((a) => !a.startsWith('-'));
  if (!command) return false;

  return HOST_COMMANDS.has(command);
}
