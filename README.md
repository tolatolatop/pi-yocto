# pi-yocto

`pi-yocto` is an offline-first Pi package and CLI for evidence-backed Yocto/Poky
diagnosis, approved metadata changes, detached BitBake jobs, and resumable task
records. Version 0.1.0 targets Linux/WSL2, Node.js 22.19 or newer, Poky
scarthgap, and `pi-agents` 0.2.1.

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

## Configure a NewAPI gateway with LLMGates

`pi-yocto` bundles the LLMGates provider, so a NewAPI or another OpenAI-compatible
gateway can be configured through Pi without putting credentials in this
repository:

```text
pi
/login
```

Choose **LLMGates 网关**, then **NewAPI**, and enter an instance ID, display
name, base URL (normally `https://your-newapi-host/v1`), and API key. Select the
new provider/model with `/model`; use `/llmgates list` to inspect configured
instances. LLMGates stores the credential in Pi's user-level `auth.json` and the
non-secret instance registry under `~/.pi/agent/llmgates/`, not in
`.pi/yocto.json` or `.pi-yocto/`.

After updating an existing linked installation, run `npm install`, rebuild, and
use `/reload` (or restart Pi) so the bundled provider is loaded.

## CLI

```text
pi-yocto doctor [--json]
pi-yocto knowledge build|status|search <query>
pi-yocto cache native [--target autoconf-native] [--log <cooker-log>] [--sig <sigdata>]
pi-yocto task create "build and verify core-image-minimal"
pi-yocto job start --kind bitbake --purpose verification \
  --task <task-id> --iteration 1 -- core-image-minimal
pi-yocto job start --kind bitbake --purpose diagnostic \
  --task <task-id> -- core-image-minimal
pi-yocto job start --kind qemu --purpose qemu --task <task-id> \
  --iteration 1 --source-job <successful-image-job-id> -- core-image-minimal
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

The extension registers task open/status/replan/completion/finalize, workspace/knowledge/metadata/log/native-cache/review,
verification-plan/update, immutable ChangeSet prepare/apply, mirror preflight,
target-scoped optimization assertion, image-manifest package assertion, detached job start/status/tail/stop, controlled QEMU guest execution/assertions, checkpoint,
and approval tools. `pi-agents` provides the `agent` and `workflow` tools and
persisted `/flow` views.

For an already-created interactive console, bind the extension to one exact
tmux session and remove Pi's native shell tool:

```bash
tmux new-session -d -s pi-yocto-console -c /path/to/project
pi --extension /path/to/pi-yocto/dist/src/extension.js \
  --tmux-session pi-yocto-console --disable bash
```

The resulting `yocto_tmux` tool can inspect pane status/output, type literal
text, wait for literal or regular-expression output, and send a small
allowlist of interactive keys such as `C-c`. The session name is fixed at
agent launch; individual tool calls cannot retarget another tmux session.

Run `/yocto-diagnose`, `/yocto-fix-and-verify`, `/yocto-create-layer`,
`/yocto-optimize-build`, or `/yocto-long-build`. Read-only branches run with a
maximum parallelism of three. Each Pi/subagent session binds to one persisted task
ID. Only `layer-engineer` may write, using a ChangeSet whose complete content hash,
task, command and file set are covered by one expiring, single-use approval.
Fix/verify loops stop after two iterations; job fingerprints prevent a resumed
session from launching the same work again. A diagnostic build can reproduce a
problem during `INSPECTING` without consuming a fix iteration. Failed verification
can enter `REPLANNING` only through `yocto_task_replan`, bound to current non-zero
failed-job or trusted semantic assertion evidence and with no active jobs; an unchanged
failed input cannot be rebuilt. `FAILED` is terminal; resumable work uses `PAUSED`.

Before implementation, the workflow persists a verification contract. Build
evidence includes the exact command and exit code. Guest requirements accept only
evidence produced by the serial guest executor, never host artifact inspection or
QEMU boot logs. `yocto_guest_assert` supplies structured file, gzip, symlink and
command-output predicates without shell pipes. QEMU startup is bound to the exact
successful image JobRecord and its target-specific `qemuboot.conf`. Use
`yocto_completion_status` to inspect remaining gates and `yocto_task_finalize` to
atomically capture final offsets/identity, summary and `COMPLETED` state.
A VERIFYING checkpoint also returns every missing controller-required Job with a
legal `yocto_job_start` suggestion. `yocto_optimization_assert` checks effective
`CFLAGS`, expanded compiler argv, and an unchanged non-target metadata fingerprint;
specialized contracts can require this exact tool source so generic `bitbake -e`
output cannot produce a false pass. `yocto_artifact_assert` checks exact package
membership in the stable manifest from one successful image JobRecord. A failed
manifest assertion is persisted as trusted non-zero semantic Evidence for
`yocto_task_replan`, without pretending that the BitBake process itself failed.

Controllers may additionally provide a versioned `.pi/yocto-contract.json`. A new
TaskRecord snapshots its required Evidence, exact job kind/purpose/target entries,
fixed input SHA-256 manifest, review and QEMU cleanup gates, recovery session count,
and any required multi-option impact decision. The controller contract cannot be
replaced by an agent-defined weaker contract.

`yocto_checkpoint` captures log offsets, PID/PGID, process start ticks, boot ID and
heartbeat from JobStore rather than trusting model-supplied values. Completion is
rejected if a required job/input/review/decision is absent, a QEMU job is active,
or recovery identity is incomplete. Evidence from another validation workspace is
rejected. Binary/oversized guest output and large metadata output are stored as
hashed runtime artifacts instead of being embedded in TaskRecord JSON or model
context.

## Offline and safety policy

Every BitBake environment sets `BB_NO_NETWORK=1` and `PATCHRESOLVE=noop`.
Ordinary incremental builds are allowed. Explicit `curl`, `wget`, `git clone`,
package installation, cache cleaning, forced tasks, layer-config edits and Git
mutations require human confirmation (and are blocked without an interactive UI).
Direct shell BitBake/runqemu calls, process termination, and generic directory/file
creation are blocked; stopping a worker must consume the exact JobRecord-bound
`stop_job` approval. In Pi, call `yocto_job_stop` directly with the job ID and no
approval ID; the tool creates and prompts for the bound approval internally. The
generic approval tool cannot create `stop_job` or ChangeSet approvals. Poky source, layer metadata and
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
defines ten isolated, near-production E2E development scenarios, common safety
gates, evaluator-only oracles, required evidence and objective completion criteria.
