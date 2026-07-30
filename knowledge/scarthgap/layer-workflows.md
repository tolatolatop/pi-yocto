# Recipe, layer, kernel, rootfs and QEMU workflows

## Minimal layer development

Create a layer with an explicit `BBFILE_COLLECTIONS` name,
`BBFILE_PATTERN`, `BBFILE_PRIORITY` and `LAYERSERIES_COMPAT`. Add it through
`bitbake-layers add-layer` only after reviewing the exact `bblayers.conf` edit.
Validate with `bitbake-layers show-layers`, a parse, and the narrowest build
target. Recipes should declare `SUMMARY`, `LICENSE`, `LIC_FILES_CHKSUM`, pinned
sources and explicit runtime/build dependencies where needed.

Local authoritative references: `documentation/dev-manual/layers.rst`,
`documentation/dev-manual/new-recipe.rst`, and `meta/conf/layer.conf`.

## Kernel fragments

Keep kernel configuration fragments in a product layer and attach them with an
append whose recipe/version pattern is intentional. Confirm that the append is
active, then inspect the kernel configuration audit rather than assuming every
requested symbol was accepted. Dependencies and architecture constraints may
change or suppress symbols.

Local authoritative references: `documentation/kernel-dev/` and the kernel
classes under `meta/classes-recipe/`.

## Root filesystem and QEMU

For rootfs failures, retain the package-manager solver output and identify the
package that introduced an unsatisfied dependency. For QEMU smoke tests, first
verify that the deploy directory contains mutually compatible kernel, rootfs and
machine artifacts. Preserve local `runqemu` changes and record the exact command
line and boot readiness criterion.

Local authoritative references: `documentation/dev-manual/qemu.rst`,
`documentation/ref-manual/classes.rst`, and `scripts/runqemu` in the configured
checkout.
