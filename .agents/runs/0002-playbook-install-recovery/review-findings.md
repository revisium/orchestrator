# Review Findings - Playbook Install Recovery

## Reviewer Voice: Codex Subagent

Status: completed.

### AO-001 - High - Imported roles overwrite executable runtime role rows

Resolution: fixed.

The importer now stores playbook roles as scoped snapshots with row ids
`<playbook-id>/<role-id>` instead of bare runtime ids such as `developer` or
`pr-watcher`. The mapped row keeps `runtime_role_id` inside `scope_rules` for
compatibility context, but installing a playbook no longer replaces executable
MVP role rows.

Changed files:

- `src/playbook/import-mapper.ts`
- `src/playbook/import-mapper.test.ts`
- `src/playbook/playbook-installer.test.ts`
- `docs/plans/0009-playbook-install.md`
- `docs/control-plane-schema.md`

### AO-002 - Medium - Recovery artifact claimed canonical route approval

Resolution: fixed.

The run artifact now records this as process recovery authorization, not
file-backed evidence of route approval before developer execution. The
`route-approval` gate remains open/`needs_human` for the pre-recovery gap, and a
separate `process-recovery` gate records the user's instruction to continue
with developer already completed.

Changed files:

- `.agents/runs/0002-playbook-install-recovery/RUN.md`

### AO-003 - Medium - Dry-run evidence and local source identity were not deterministic

Resolution: fixed.

Local playbook sources with package metadata now use deterministic package-based
source identity, for example
`local:@revisium/agent-playbook@0.1.0-alpha.0`, instead of a machine-specific
absolute path. The verification artifact was updated to match the observed
output.

Changed files:

- `src/playbook/source-resolver.ts`
- `src/playbook/source-resolver.test.ts`
- `.agents/runs/0002-playbook-install-recovery/verification-result.md`

## Reviewer Voice: Claude Code

Status: unavailable.

The `claude -p` review attempt produced no output after a bounded wait and was
terminated. Dual-model consensus is therefore incomplete; the completed
independent review voice is the Codex reviewer subagent.

## Post-Fix Reviewer Gate

Status: passed.

The post-fix reviewer reported no blocking/high/medium findings. The run
continues with the human-approved single-reviewer fallback plus PR watcher
feedback because Claude Code remained unavailable in this session.

## Watcher Finding: SonarCloud `typescript:S2871`

Status: fixed.

After draft PR publication, SonarCloud failed the quality gate on reliability
for `src/playbook/import-mapper.ts` because `Array.prototype.sort()` did not use
an explicit comparator. The stable stringifier now sorts object keys with
`left.localeCompare(right)`.

Verification after the fix:

- `npx tsx --test src/playbook/import-mapper.test.ts src/playbook/playbook-installer.test.ts`
- `npm run typecheck`
- `npm run lint:ci`
- `npm run verify`
- `npm run build`
- `./bin/revo.js playbook install ../agents --dry-run`
