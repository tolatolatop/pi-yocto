# pi-yocto

`pi-yocto` is an offline-first Pi package and CLI for evidence-backed Yocto/Poky
diagnosis, approved metadata changes, detached BitBake jobs, and resumable task
records. Version 0.1.0 targets Linux/WSL2, Node.js 22, Poky scarthgap, and
`pi-agents` 0.2.1.

The harness keeps commit-safe project configuration in `.pi/yocto.json` and all
logs, indexes, approvals, jobs, and checkpoints in ignored `.pi-yocto/`. It does
not use or modify `.agent/`.

## Install and initialize

```sh
npm install
npm run build
npm link                         # optional: exposes pi-yocto
pi install /absolute/path/pi-yocto -l

pi-yocto init \
  --project "$PWD" \
  --workspace /path/to/workspace \
  --source /path/to/poky \
  --build /path/to/build
pi-yocto knowledge build
pi-yocto doctor
```

`init` discovers MACHINE, DISTRO, BBLAYERS, DL_DIR and SSTATE_DIR and installs
the eight project agents plus five fixed workflow specs under `.pi/`. Existing
agent definitions are never overwritten.

## CLI

```text
pi-yocto doctor [--json]
pi-yocto knowledge build|status|search <query>
pi-yocto task create "build and verify core-image-minimal"
pi-yocto job start --kind bitbake --purpose verification \
  --task <task-id> --iteration 1 -- core-image-minimal
pi-yocto job list
pi-yocto job status <job-id>
pi-yocto job logs <job-id> [--offset N]
pi-yocto job exec <qemu-job-id> --task <task-id> -- <guest-command> [args...]
pi-yocto job stop <job-id> --task <task-id> --approval <approval-id>
pi-yocto task status [task-id]
pi-yocto task resume <task-id>
pi-yocto task export <task-id> [--output report.md]
```

Workers are detached process-group leaders. Their PID start ticks, Linux boot ID,
heartbeat, log offset and final status are persisted. A stale/reused PID or reboot
is reported as `INTERRUPTED`; builds are never restarted automatically.

## Pi tools and workflows

The extension registers task open/status, workspace/knowledge/metadata/log/review,
verification-plan/update, immutable ChangeSet prepare/apply, mirror preflight,
detached job start/status/tail/stop, controlled QEMU guest execution, checkpoint,
and approval tools. `pi-agents` provides the `agent` and `workflow` tools and
persisted `/flow` views.

Run `/yocto-diagnose`, `/yocto-fix-and-verify`, `/yocto-create-layer`,
`/yocto-optimize-build`, or `/yocto-long-build`. Read-only branches run with a
maximum parallelism of three. Each Pi/subagent session binds to one persisted task
ID. Only `layer-engineer` may write, using a ChangeSet whose complete content hash,
task, command and file set are covered by one expiring, single-use approval.
Fix/verify loops stop after two iterations; job fingerprints prevent a resumed
session from launching the same work again.

Before implementation, the workflow persists a verification contract. Build
evidence includes the exact command and exit code. Guest requirements accept only
evidence produced by the serial guest executor, never host artifact inspection or
QEMU boot logs. A task cannot become `COMPLETED` until every required item is
`PASSED`, no pending step remains, and an auditable final summary is stored.

Controllers may additionally provide a versioned `.pi/yocto-contract.json`. A new
TaskRecord snapshots its required Evidence, exact job kind/purpose/target entries,
fixed input SHA-256 manifest, review and QEMU cleanup gates, recovery session count,
and any required multi-option impact decision. The controller contract cannot be
replaced by an agent-defined weaker contract.

`yocto_checkpoint` captures log offsets, PID/PGID, process start ticks, boot ID and
heartbeat from JobStore rather than trusting model-supplied values. Completion is
rejected if a required job/input/review/decision is absent, a QEMU job is active,
or recovery identity is incomplete. Evidence from another validation workspace is
rejected. Binary or oversized guest output is stored as a hashed runtime artifact
instead of being embedded in TaskRecord JSON.

## Offline and safety policy

Every BitBake environment sets `BB_NO_NETWORK=1` and `PATCHRESOLVE=noop`.
Ordinary incremental builds are allowed. Explicit `curl`, `wget`, `git clone`,
package installation, cache cleaning, forced tasks, layer-config edits and Git
mutations require human confirmation (and are blocked without an interactive UI).
Direct shell BitBake/runqemu calls are blocked. Poky source, layer metadata and
build configuration can only be changed through preflighted immutable ChangeSets;
generic edit/write cannot consume those approvals. The harness never prescribes
`cleanall`, deletes `tmp`/downloads/sstate, or modifies a pre-existing dirty file
without exact approval.

The local MiniSearch index is deterministic and database-free. It records release,
source path, Poky commit, SHA-256, license and confidence for official RST/classes
and bundled curated workflows. See `knowledge/scarthgap/ATTRIBUTION.md`.

## Verification

```sh
npm test
npm run check
PI_OFFLINE=1 node_modules/.bin/pi -e . --approve --list-models
```

The configured reference workspace can additionally be checked with an offline
detached incremental build. Missing downloads fail with their normal BitBake URI
evidence; the harness does not fall back to the network.

The model-backed acceptance suite is documented in `validation/README.md`. It
defines five isolated, near-production E2E development scenarios, common safety
gates, evaluator-only oracles, required evidence and objective completion criteria.
