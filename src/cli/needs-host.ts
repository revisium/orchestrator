/**
 * needsHost() — pure argv pre-parse (no Nest/DBOS import).
 *
 * Returns true ONLY for host-requiring commands:
 *   - dev:ping, dev:status (slice 0001)
 *   - run start (slice 0003 — enqueues a DBOS workflow, needs the host)
 *   - run create (resolves installed playbooks/profiles through host services)
 *   - inbox resolve --approve|--reject (slice 0004 — signals a parked workflow, needs DBOS)
 *   - mcp (local stdio MCP server over the host services)
 *
 * Other read-only run subcommands (list/show/events) remain host-free.
 * inbox list/show and inbox resolve --answer (non-gate) remain host-free.
 *
 * Design rules:
 *   - Help/version flags anywhere → always host-free (consensus MINOR, codex round 2).
 *   - Default is host-free (allowlist miss → false); fail-safe for unknown commands.
 *   - No Nest, DBOS, or AppModule imports here (F1 — keep the host-free path lightweight).
 *   - `inbox resolve` is classified host-requiring ONLY when --approve or --reject is present
 *     in argv (pure argv-parse; cannot read the row here). Non-gate `--answer` stays host-free.
 *   - `run create` is host-requiring because route resolution reads installed playbooks and profiles.
 *
 * M5 (TASK 0003): subcommand-aware `run start` routing.
 * G4/G6 (TASK 0004): subcommand-aware `inbox resolve --approve|--reject` routing.
 * Current contract: `run create` → host-requiring.
 */

/** Commands that require the Nest/DBOS host context (colon-style, no subcommand needed). */
const HOST_COMMANDS = new Set(['dev:ping', 'dev:status', 'mcp']);

/** Flags that force host-free regardless of the command. */
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-v']);

/** Gate-resolve flags that make `inbox resolve` host-requiring (0004). */
const GATE_FLAGS = new Set(['--approve', '--reject']);

function firstCommand(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

export function isMcpCommand(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.some((a) => HELP_FLAGS.has(a))) return false;
  return firstCommand(args) === 'mcp';
}

/**
 * Decide whether an argv array needs the Nest host context.
 * @param argv - process.argv-style array (first two elements are node + script).
 */
export function needsHost(argv: string[]): boolean {
  const args = argv.slice(2); // strip node + script

  // Any help/version flag anywhere → host-free.
  if (args.some((a) => HELP_FLAGS.has(a))) return false;

  // Find the first non-flag argument (the command name).
  const command = firstCommand(args);
  if (!command) return false;

  // M5: `run start` is host-requiring.
  // Current contract: `run create` is host-requiring because it resolves installed route data.
  if (command === 'run') {
    const commandIdx = args.indexOf(command);
    const sub = args.slice(commandIdx + 1).find((a) => !a.startsWith('-'));
    if (sub === 'start') return true;
    if (sub === 'create') return true;
    return false;
  }

  // G4/G6: `inbox resolve --approve|--reject` is host-requiring (gate path — signals DBOS).
  // `inbox list`/`show` and `inbox resolve --answer` (non-gate) stay host-free.
  if (command === 'inbox') {
    const commandIdx = args.indexOf(command);
    const sub = args.slice(commandIdx + 1).find((a) => !a.startsWith('-'));
    if (sub === 'resolve') {
      return args.some((a) => GATE_FLAGS.has(a));
    }
    return false;
  }

  return HOST_COMMANDS.has(command);
}
