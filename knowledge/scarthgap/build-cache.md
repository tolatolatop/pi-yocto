# Signatures, sstate and build performance

An ordinary `bitbake target` is the safe incremental operation. BitBake task
signatures determine what must rerun, and matching shared-state objects restore
eligible outputs. Do not prescribe `cleanall`, delete `tmp`, or force tasks until
signature evidence establishes that normal invalidation is insufficient.

Use buildstats to establish a repeatable baseline, then compare the same target,
machine, distro and concurrency settings. For unexpected rebuilds, compare task
signatures and siginfo/sigdata rather than relying only on elapsed time. For slow
builds, separate task execution time, scheduler parallelism, disk pressure,
download availability and sstate misses.

Local authoritative references: `documentation/dev-manual/debugging.rst`,
`documentation/ref-manual/classes.rst` (buildstats) and BitBake's signature
handling documentation in `bitbake/doc/`.

## Native cache inspection

For a host tool such as `autoconf-native`, inspect effective metadata before
editing configuration. The important distinction is between variables merely
present in the datastore and variables that are effective task-signature inputs.

1. Resolve `SSTATE_DIR`, `SSTATE_MIRRORS`, `SSTATE_PKGARCH`, uninative/hash-server
   settings, `BB_ENV_PASSTHROUGH_ADDITIONS`, and BUILD/HOST/TARGET/PACKAGE values
   with `bitbake -e <recipe-native>`. Keep the variable history comments because
   they identify the conf, class, environment, or recipe assignment that won.
2. Read the newest `tmp/log/cooker/${MACHINE}/*.log` and parse `Sstate summary`.
   `Local` means the configured `SSTATE_DIR`; `Mirrors` means `SSTATE_MIRRORS`;
   `Current` means the current TMPDIR/stamps already satisfy the task. A cache
   restore is best demonstrated in a fresh TMPDIR by non-zero Local/Mirrors and
   zero Missed, not by Current alone.
3. Dump the native `do_compile` or `do_populate_sysroot` sigdata. BUILD variables
   and `TARGET_ARCH=${BUILD_ARCH}` are normal. Effective dependencies on MACHINE,
   MACHINE_ARCH, MACHINEOVERRIDES, MACHINE_FEATURES, DEFAULTTUNE, target-side
   TUNE_FEATURES/TUNE_PKGARCH, or TARGET_FPU require justification.
4. Compare signatures from two otherwise equivalent builds with
   `bitbake-diffsigs`. Repair the first unwanted input rather than adding it to a
   global hash-ignore list.

`pi-yocto cache native --target autoconf-native` performs the read-only portions
of this inspection. The Pi extension exposes the same evidence as
`yocto_native_cache_inspect`.

For multiple local build directories, a typical writable cache is:

```bitbake
SSTATE_DIR = "/data/.cache/sstate-cache"
DL_DIR = "/data/.cache/downloads"
```

Keep TMPDIR, STAMPS_DIR, WORKDIR, PKGDATA_DIR, and DEPLOY_DIR build-local. If the
shared cache is curated or untrusted builds must not write to it, use a local
`SSTATE_DIR` plus a read-only `SSTATE_MIRRORS` entry instead.

Environment variables can affect cache identity only when BitBake imports them.
Audit `BB_ENV_PASSTHROUGH_ADDITIONS`, `BB_ENV_PASSTHROUGH`, and the corresponding
effective variables. Common accidental inputs include compiler wrappers, ccache,
proxy/toolchain settings, locale variables, and custom product variables. PATH,
TMPDIR, WORKDIR and other standard path variables have established exclusion or
relocation handling; do not generalize that into ignoring arbitrary inputs.

## Cache safety

`DL_DIR` contains source downloads. `SSTATE_DIR` contains reusable task output.
`TMPDIR` contains the active build output. Their roles are not interchangeable.
Cleaning any of them is a high-impact operation and requires a specific recovery
reason, exact path, and human approval.
