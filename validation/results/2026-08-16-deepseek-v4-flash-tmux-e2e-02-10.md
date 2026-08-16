# DeepSeek V4 Flash tmux-only E2E-02 / E2E-10 validation

## Result

Both scenarios passed their machine contracts while Pi's native `bash` tool
was disabled. Each controller run bound the agent to one pre-created tmux
session and persisted the raw pane stream with `pipe-pane`.

| Scenario | Task | Turns | Requirements | Result |
| --- | --- | ---: | ---: | --- |
| E2E-02 create layer/image | `task-20260816080759-6f88e96e` | 63 | 6/6 PASSED | PASS |
| E2E-10 full/minimal variants | `task-20260816081418-df96aae0` | 52 | 7/7 PASSED | PASS |

No RPC transcript contains a completed or attempted native `bash` tool call.
All recorded jobs start with `offline=true`; no clean, cleansstate, cleanall,
network fetch fallback, or active QEMU process remained after validation.

## E2E-02

The agent consumed the controller-owned application and LICENSE, compared
implementation options, prepared an exact six-file ChangeSet, and recovered
from two schema-level ChangeSet mistakes without bypassing approval. Review
and parse evidence preceded the image build. The offline
`validation-health-image` build succeeded and its manifest contains the exact
`validation-health` package.

The first QEMU command proved the functional output but produced the wrong
Evidence claim type. The agent stopped that QEMU, launched a fresh instance,
used the structured guest execution tool, and only then passed `S2-guest`:

```text
argv: ["validation-health", "--self-test"]
output: validation-health: ok
exitCode: 0
```

Both QEMU jobs ended in `STOPPED`. The tmux record contains the only direct
terminal command used by the agent, an `md5sum` of the isolated LICENSE input;
the returned MD5 is `d23c863dbfb78dd23ff11aa8049394b6`.

## E2E-10

The baseline `variant-full` build succeeded before modification. The agent
compared explicit coexisting binary names with `update-alternatives`, selected
the smaller non-conflicting design, added `variant-minimal_1.0.bb`, and added
the minimal package only to the validation image. Review returned zero errors
and parse succeeded with 923 recipes.

The minimal recipe and combined image built successfully. The image manifest
contains both exact package names, and one QEMU instance produced structured
guest Evidence for both commands:

```text
variant-full --mode    -> variant=full    (exit 0)
variant-minimal --mode -> variant=minimal (exit 0)
```

The ordinary confirmation build reported a 99% sstate match and:

```text
Attempted 3446 tasks of which 3446 didn't need to be rerun and all succeeded.
```

The agent did not need a direct terminal command in this scenario; all work
used bounded pi-yocto tools. The bound tmux record therefore contains only the
idle prompt, which is expected and independently proves there was no hidden
console activity.

## Protected baseline

- Poky remained at `a53cae3de9f45417b97efc4c46c42e4c8ebdb939`.
- The protected `scripts/runqemu` diff SHA-256 remained
  `64f0e199bdc4eb08d7926afbb2211af604bc1e14642c9ed08ee07164a6c98f08`.
- Changes and build artifacts are confined to the two run roots under
  `.pi-yocto/validation/e2e-02` and `.pi-yocto/validation/e2e-10`.
