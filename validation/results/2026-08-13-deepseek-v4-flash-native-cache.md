# deepseek-v4-flash native cache capability validation

## Scope and result

On 2026-08-13 (Asia/Shanghai), `deepseek/deepseek-v4-flash` was invoked through
OpenRouter against the configured Poky scarthgap workspace. The model received
only `yocto_task_open` and the new read-only `yocto_native_cache_inspect` tool;
shell, file-write, and build-start tools were not enabled.

Result: **PASS**. The model opened one diagnostic TaskRecord, called the native
cache inspector for `autoconf-native`, and grounded all requested conclusions in
the returned evidence.

## Observed facts

- Effective `SSTATE_DIR`: `/home/agent/poky/cache/sstate`, outside the build
  directory.
- Cooker summary: `Wanted 0 Local 0 Mirrors 0 Missed 0 Current 1428`. The model
  correctly stated that this is only current TMPDIR/stamp state and does not
  demonstrate a Local or Mirror restore.
- `BUILD_ARCH`, native-remapped `TARGET_ARCH`, and `PACKAGE_ARCH` were all
  `x86_64`; the model correctly classified this as normal native behavior.
- `MACHINE_FEATURES` was present in the metadata datastore, but absent from the
  inspected task dependency list. The model correctly stated that datastore
  presence alone is insufficient to prove signature pollution.
- The inspected `autoconf-native:do_populate_sysroot` sigdata reported an empty
  suspicious target-side dependency list.

## Harness verification

- Provider/model: `openrouter` / `deepseek/deepseek-v4-flash`.
- Pi process exit: `0`; provider stderr was empty.
- The model created Evidence `ev-a4a6a49c692181c2` through the new tool.
- No BitBake build, clean, force operation, cache mutation, or source/config
  modification was authorized or performed by the model validation.
- The complete repository test suite passed: 58/58 tests.

The raw Pi session and streamed controller output were held in a mode-0700
temporary directory outside the repository and are intentionally not packaged;
they may contain verbose metadata history. No API key was written to this report,
the repository configuration, TaskRecord, or model transcript.
