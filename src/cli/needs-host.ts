/**
 * needsHost() — pure argv pre-parse (no Nest/DBOS import).
 *
 * Returns true ONLY for host-requiring commands:
 *   - dev:ping, dev:status (slice 0001)
 *   - run start (slice 0003 — enqueues a DBOS workflow, needs the host)
 *
 * All other run subcommands (create/list/show/events/cancel) remain host-free.
 *
 * Design rules:
 *   - Help/version flags anywhere → always host-free (consensus MINOR, codex round 2).
 *   - Default is host-free (allowlist miss → false); fail-safe for unknown commands.
 *   - No Nest, DBOS, or AppModule imports here (F1 — keep the host-free path lightweight).
 *
 * M5 (TASK 0003): subcommand-aware `run start` routing.
 */

/** Commands that require the Nest/DBOS host context (colon-style, no subcommand needed). */
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

  // M5: `run start` is host-requiring; all other `run` subcommands are host-free.
  if (command === 'run') {
    const commandIdx = args.indexOf(command);
    const sub = args.slice(commandIdx + 1).find((a) => !a.startsWith('-'));
    return sub === 'start';
  }

  return HOST_COMMANDS.has(command);
}
