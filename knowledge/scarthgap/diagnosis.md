# Evidence-first diagnosis for scarthgap

Classify the failing stage before editing metadata. Preserve the first failing
task's `temp/log.do_*`; the final BitBake summary often contains only cascading
failures. Query `bitbake -e recipe` for the final value and assignment history of
a disputed variable, and use `bitbake-layers show-appends` to confirm that the
expected append is active.

Local authoritative references: `bitbake/doc/bitbake-user-manual/` for parsing,
execution and the environment; `documentation/dev-manual/debugging.rst` for
debugging workflows; `meta/classes-global/base.bbclass` for task foundations.

## Failure routing

- Parse and expansion errors: inspect the exact file and variable history before
  invoking a task.
- Fetch failures: with `BB_NO_NETWORK=1`, report the missing URI and expected
  `DL_DIR` object. Never silently retry on the network.
- Patch failures: inspect `log.do_patch`, patch ordering and source revision.
- Configure/compile/install: use the task log, generated build directory and
  recipe-specific task function.
- Package/rootfs/image: distinguish recipe output packaging from package-manager
  dependency resolution and image filesystem generation.
- QEMU: separate image discovery, command-line construction, kernel boot and
  userspace readiness.

## Variables and overrides

Scarthgap uses colon override syntax. Prefer evidence from `bitbake -e` over a
text search when determining the final value. A text search remains useful for
finding candidate assignments, but does not resolve layer priority, overrides,
weak defaults or anonymous Python.

Local authoritative references: `bitbake/doc/bitbake-user-manual/bitbake-user-manual-metadata.rst`
and `documentation/ref-manual/variables.rst`.
