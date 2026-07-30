#!/usr/bin/env node
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scenario = process.argv[2];
const runId = process.argv[3] ?? `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
if (!/^(?:06|07|08|09|10)$/.test(scenario ?? "")) throw new Error("Usage: prepare-run.mjs <06|07|08|09|10> [run-id]");
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Unsafe run id: ${runId}`);

const runRoot = join(repoRoot, ".pi-yocto", "validation", `e2e-${scenario}`, runId);
try {
  await stat(runRoot);
  throw new Error(`Run already exists: ${runRoot}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const buildDir = join(runRoot, "build");
const layerDir = join(runRoot, `meta-validation-${scenario}`);
const tmpDir = join(runRoot, "tmp");
const piDir = join(runRoot, ".pi");
const sourceDir = "/home/agent/poky/poky-src";
const metaLocal = "/home/agent/poky/meta-local";
const downloads = "/home/agent/poky/cache/downloads";
const sstate = "/home/agent/poky/cache/sstate";
const license = await readFile(join(repoRoot, "validation", "assets", "edgeprobe", "LICENSE"), "utf8");

async function put(relative, content, mode) {
  const path = join(runRoot, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", ...(mode ? { mode } : {}) });
}

const collection = `validation${scenario}`;
await put(`meta-validation-${scenario}/conf/layer.conf`, `BBPATH .= ":\${LAYERDIR}"
BBFILES += "\${LAYERDIR}/recipes-*/*/*.bb \${LAYERDIR}/recipes-*/*/*.bbappend"
BBFILE_COLLECTIONS += "${collection}"
BBFILE_PATTERN_${collection} = "^\${LAYERDIR}/"
BBFILE_PRIORITY_${collection} = "1000"
LAYERSERIES_COMPAT_${collection} = "scarthgap"
`);

await put("build/conf/local.conf", `MACHINE ??= "qemux86-64"
DISTRO ?= "poky"
DL_DIR = "${downloads}"
SSTATE_DIR = "${sstate}"
TMPDIR = "${tmpDir}"
BB_NO_NETWORK = "1"
PATCHRESOLVE = "noop"
BB_NUMBER_THREADS ?= "8"
PARALLEL_MAKE ?= "-j8"
EXTRA_IMAGE_FEATURES = "debug-tweaks"
USER_CLASSES ?= "buildstats"
INHERIT:remove = "create-spdx"
`);
await put("build/conf/bblayers.conf", `POKY_BBLAYERS_CONF_VERSION = "2"
BBPATH = "\${TOPDIR}"
BBFILES ?= ""
BBLAYERS ?= " \\
  ${layerDir} \\
  ${metaLocal} \\
  ${sourceDir}/meta \\
  ${sourceDir}/meta-poky \\
  ${sourceDir}/meta-yocto-bsp \\
  "
`);

await put(".pi/yocto.json", `${JSON.stringify({
  schemaVersion: "1.0.0",
  sourceDir,
  buildDir,
  machine: "qemux86-64",
  distro: "poky",
  layers: [layerDir, metaLocal, `${sourceDir}/meta`, `${sourceDir}/meta-poky`, `${sourceDir}/meta-yocto-bsp`],
  dlDir: downloads,
  sstateDir: sstate,
  tmpDir,
  offline: { bitbakeNoNetwork: true, blockExplicitNetworkCommands: true },
  limits: { maxParallelAgents: 3, maxWorkflowDepth: 4, maxFixIterations: 2 }
}, null, 2)}\n`);
await cp(join(repoRoot, "validation", "contracts", `e2e-${scenario}.json`), join(piDir, "yocto-contract.json"));

const image = (name, packages) => `require recipes-core/images/core-image-minimal.bb
SUMMARY = "pi-yocto ${name} validation image"
IMAGE_INSTALL:append = " ${packages}"
`;

if (scenario === "06") {
  await mkdir(join(runRoot, "attachments"), { recursive: true });
  for (const name of ["edgeprobe.c", "Makefile", "LICENSE"]) {
    await cp(join(repoRoot, "validation", "assets", "edgeprobe", name), join(runRoot, "attachments", name));
  }
  await put(`meta-validation-06/recipes-core/images/validation-oss-image.bb`, image("new OSS", "edgeprobe"));
}

if (scenario === "07") {
  await put("meta-validation-07/recipes-support/optimize-probe/files/optimize-probe.c", `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--mode") != 0) return 2;
#ifdef __OPTIMIZE_SIZE__
    puts("optimization=size");
#elif defined(__OPTIMIZE__)
    puts("optimization=speed");
#else
    puts("optimization=none");
#endif
    return 0;
}
`);
  await put("meta-validation-07/recipes-support/optimize-probe/files/LICENSE", license);
  await put("meta-validation-07/recipes-support/optimize-probe/optimize-probe_1.0.bb", `SUMMARY = "Optimization scope validation probe"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=11c091b000f293d7953e4b52bd95f7cd"
SRC_URI = "file://optimize-probe.c file://LICENSE"
S = "\${WORKDIR}"
do_compile() {
    \${CC} \${CPPFLAGS} \${CFLAGS} \${LDFLAGS} optimize-probe.c -o optimize-probe
}
do_install() {
    install -d \${D}\${bindir}
    install -m 0755 optimize-probe \${D}\${bindir}/optimize-probe
}
`);
  await put("meta-validation-07/recipes-core/images/validation-opt-image.bb", image("optimization", "optimize-probe"));
}

if (scenario === "08") {
  await put("meta-validation-08/recipes-support/core-agent/files/core-agent", `#!/bin/sh
if [ "$1" = "--self-test" ]; then
    echo "core-agent: ok"
    exit 0
fi
echo "core-agent 1.0"
` , 0o755);
  await put("meta-validation-08/recipes-support/core-agent/core-agent_1.0.bb", `SUMMARY = "Required product core agent"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://\${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"
SRC_URI = "file://core-agent"
S = "\${WORKDIR}"
inherit allarch
do_install() {
    install -d \${D}\${bindir}
    install -m 0755 \${WORKDIR}/core-agent \${D}\${bindir}/core-agent
}
`);
  await put("meta-validation-08/recipes-support/legacy-diag/files/legacy-diag", `#!/bin/sh
echo "legacy-diag 1.0"
`, 0o755);
  await put("meta-validation-08/recipes-support/legacy-diag/legacy-diag_1.0.bb", `SUMMARY = "Deprecated diagnostic utility"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://\${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"
SRC_URI = "file://legacy-diag"
S = "\${WORKDIR}"
inherit allarch
do_install() {
    install -d \${D}\${bindir}
    install -m 0755 \${WORKDIR}/legacy-diag \${D}\${bindir}/legacy-diag
}
`);
  await put("meta-validation-08/recipes-core/packagegroups/packagegroup-validation-product.bb", `SUMMARY = "Validation product package group"
LICENSE = "MIT"
inherit packagegroup
RDEPENDS:\${PN} = "core-agent"
RRECOMMENDS:\${PN} = "legacy-diag"
`);
  await put("meta-validation-08/recipes-core/images/validation-remove-image.bb", image("package removal", "packagegroup-validation-product"));
}

if (scenario === "09") {
  await put("meta-validation-09/recipes-support/libwidget/files/widget.h", `#ifndef WIDGET_H
#define WIDGET_H
const char *widget_version(void);
#endif
`);
  await put("meta-validation-09/recipes-support/libwidget/files/widget.c", `#include "widget.h"
const char *widget_version(void) { return "1.0"; }
`);
  await put("meta-validation-09/recipes-support/libwidget/files/widget-info.c", `#include <stdio.h>
#include "widget.h"
int main(void) { printf("libwidget %s\\n", widget_version()); return 0; }
`);
  await put("meta-validation-09/recipes-support/libwidget/files/libwidget.pc", `prefix=/usr
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include
Name: libwidget
Description: pi-yocto validation widget library
Version: 1.0
Libs: -L\${libdir} -lwidget
Cflags: -I\${includedir}
`);
  await put("meta-validation-09/recipes-support/libwidget/files/LICENSE", license);
  await put("meta-validation-09/recipes-support/libwidget/files/Makefile", `CC ?= cc
CFLAGS ?= -O2
LDFLAGS ?=
DESTDIR ?=
PREFIX ?= /usr
LIBDIR ?= \$(PREFIX)/lib
INCLUDEDIR ?= \$(PREFIX)/include
PKGCONFIGDIR ?= \$(LIBDIR)/pkgconfig
all: libwidget.so.1.0.0 libwidget.so widget-info
widget.o: widget.c widget.h
	\$(CC) \$(CPPFLAGS) \$(CFLAGS) -fPIC -c widget.c -o widget.o
libwidget.so.1.0.0: widget.o
	\$(CC) -shared -Wl,-soname,libwidget.so.1 -o $@ widget.o \$(LDFLAGS)
libwidget.so: libwidget.so.1.0.0
	ln -sf libwidget.so.1.0.0 libwidget.so.1
	ln -sf libwidget.so.1 libwidget.so
widget-info: widget-info.c libwidget.so
	\$(CC) \$(CPPFLAGS) \$(CFLAGS) widget-info.c -I. -L. -lwidget -Wl,-rpath-link,. \$(LDFLAGS) -o $@
install: all
	install -d \$(DESTDIR)\$(LIBDIR) \$(DESTDIR)\$(INCLUDEDIR) \$(DESTDIR)\$(PKGCONFIGDIR) \$(DESTDIR)\$(PREFIX)/bin
	install -m 0755 libwidget.so.1.0.0 \$(DESTDIR)\$(LIBDIR)/
	ln -sf libwidget.so.1.0.0 \$(DESTDIR)\$(LIBDIR)/libwidget.so.1
	ln -sf libwidget.so.1 \$(DESTDIR)\$(LIBDIR)/libwidget.so
	install -m 0644 widget.h \$(DESTDIR)\$(INCLUDEDIR)/widget.h
	install -m 0644 libwidget.pc \$(DESTDIR)\$(PKGCONFIGDIR)/libwidget.pc
	install -m 0755 widget-info \$(DESTDIR)\$(PREFIX)/bin/widget-info
`);
  await put("meta-validation-09/recipes-support/libwidget/libwidget_1.0.bb", `SUMMARY = "Runtime/development package split fixture"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=11c091b000f293d7953e4b52bd95f7cd"
SRC_URI = "file://widget.c file://widget-info.c file://widget.h file://libwidget.pc file://Makefile file://LICENSE"
S = "\${WORKDIR}"
do_compile() {
    oe_runmake CC="\${CC}" CFLAGS="\${CFLAGS}" LDFLAGS="\${LDFLAGS}"
}
do_install() {
    oe_runmake install DESTDIR="\${D}" PREFIX="\${prefix}" LIBDIR="\${libdir}" INCLUDEDIR="\${includedir}" PKGCONFIGDIR="\${libdir}/pkgconfig"
}
FILES:\${PN} += "\${bindir}/widget-info \${libdir}/libwidget.so.*"
`);
  await put("meta-validation-09/recipes-core/images/validation-dev-image.bb", image("runtime and development package", "libwidget"));
}

if (scenario === "10") {
  await put("meta-validation-10/recipes-support/variant/files/variant.c", `#include <stdio.h>
#include <string.h>
#ifndef VARIANT_MODE
#define VARIANT_MODE "unknown"
#endif
int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--mode") != 0) return 2;
    printf("variant=%s\\n", VARIANT_MODE);
    return 0;
}
`);
  await put("meta-validation-10/recipes-support/variant/files/LICENSE", license);
  await put("meta-validation-10/recipes-support/variant/files/Makefile", `CC ?= cc
CFLAGS ?= -O2
LDFLAGS ?=
NAME ?= variant
MODE ?= unknown
all:
	\$(CC) \$(CPPFLAGS) \$(CFLAGS) -DVARIANT_MODE='"\$(MODE)"' variant.c \$(LDFLAGS) -o \$(NAME)
`);
  await put("meta-validation-10/recipes-support/variant/variant-common.inc", `SUMMARY = "Shared-source feature variant fixture"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=11c091b000f293d7953e4b52bd95f7cd"
SRC_URI = "file://variant.c file://Makefile file://LICENSE"
S = "\${WORKDIR}"
PACKAGECONFIG ??= ""
PACKAGECONFIG[extras] = ",,,"
VARIANT_MODE = "\${@bb.utils.contains('PACKAGECONFIG', 'extras', 'full', 'minimal', d)}"
do_compile() {
    oe_runmake CC="\${CC}" CFLAGS="\${CFLAGS}" LDFLAGS="\${LDFLAGS}" NAME="\${BPN}" MODE="\${VARIANT_MODE}"
}
do_install() {
    install -d \${D}\${bindir}
    install -m 0755 \${B}/\${BPN} \${D}\${bindir}/\${BPN}
}
`);
  await put("meta-validation-10/recipes-support/variant/variant-full_1.0.bb", `require variant-common.inc
PACKAGECONFIG = "extras"
`);
  await put("meta-validation-10/recipes-core/images/validation-variant-image.bb", image("full/minimal variants", "variant-full"));
}

await mkdir(join(runRoot, ".pi-yocto", "jobs"), { recursive: true });
process.stdout.write(`${JSON.stringify({ scenario: `e2e-${scenario}`, runId, runRoot, buildDir, layerDir, tmpDir }, null, 2)}\n`);
