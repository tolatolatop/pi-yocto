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

## Cache safety

`DL_DIR` contains source downloads. `SSTATE_DIR` contains reusable task output.
`TMPDIR` contains the active build output. Their roles are not interchangeable.
Cleaning any of them is a high-impact operation and requires a specific recovery
reason, exact path, and human approval.
