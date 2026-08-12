# Native sstate pollution repair E2E

This scenario injects a real metadata regression into an isolated copy of
Poky, asks a Pi agent to diagnose and repair it, and then verifies native
sstate reuse across two target machines.

The injected patch changes `native.bbclass` from:

```bitbake
PACKAGE_ARCH = "${BUILD_ARCH}"
```

to:

```bitbake
PACKAGE_ARCH = "${MACHINE_ARCH}"
```

This keeps native tools buildable but contaminates their task signatures and
sstate keys with the target machine. A cache produced while building for
`qemux86-64` therefore cannot be fully reused for `qemuarm64`, even though both
native tools execute on the same x86-64 build host.

## Lifecycle

1. `prepare-run.mjs` creates a new run directory, copies Poky into it, and
   applies an isolated C.UTF-8 compatibility fixture required by this host.
2. The controller applies `fixtures/native-machine-pollution.patch` only to
   that copy and creates four independent build directories:
   broken/fixed × qemux86-64/qemuarm64.
3. The agent establishes the broken cross-machine baseline, diagnoses the
   first signature difference, repairs the isolated Poky copy, and performs a
   cold/warm build against a second initially empty cache.
4. `verify-run.mjs` mechanically checks the logs, stamps, cache population,
   exact source repair/scope, shared-Poky immutability, executed shell calls,
   and architecture-sensitive signature evidence with real 64-hex hashes.

No shared Poky source, TMPDIR, or sstate cache is modified. Downloads are
read-only inputs and every BitBake invocation is required to use
`BB_NO_NETWORK=1`.

## Commands

```bash
node validation/native-cache-repair-e2e/prepare-run.mjs <run-id>
node validation/native-cache-repair-e2e/run-agent.mjs <run-root>
node validation/native-cache-repair-e2e/verify-run.mjs <run-root>
```

The default model is `deepseek/deepseek-v4-flash`; it can be overridden with
`YOCTO_E2E_MODEL`. The run controller intentionally exposes normal read and
shell tools so the model can build, inspect signatures, edit the isolated
source, and retry without a doctor-only workflow.
