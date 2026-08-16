#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scenario = process.argv[2];
const runId = process.argv[3] ?? `run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
if (!/^(?:01|02|03|04|05|06|07|08|09|10)$/.test(scenario ?? "")) throw new Error("Usage: prepare-run.mjs <01..10> [run-id]");
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Unsafe run id: ${runId}`);

const runRoot = join(repoRoot, ".pi-yocto", "validation", `e2e-${scenario}`, runId);
try {
  await stat(runRoot);
  throw new Error(`Run already exists: ${runRoot}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const buildDir = join(runRoot, "build");
const layerDir = join(runRoot, scenario === "02" ? "meta-validation-health" : Number(scenario) <= 5 ? "layer" : `meta-validation-${scenario}`);
const tmpDir = join(runRoot, "tmp");
const piDir = join(runRoot, ".pi");
const sourceDir = "/home/agent/poky/poky-src";
const metaLocal = "/home/agent/poky/meta-local";
const downloads = "/home/agent/poky/cache/downloads";
const sstate = "/home/agent/poky/cache/sstate";
const license = await readFile(join(repoRoot, "validation", "assets", "edgeprobe", "LICENSE"), "utf8");
const fixtureLicense = `MIT License

Copyright (c) 2026 Validation Fixture Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

async function put(relative, content, mode) {
  const path = join(runRoot, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", ...(mode ? { mode } : {}) });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const collection = `validation${scenario}`;
if (scenario !== "02") await put(`${layerDir.slice(runRoot.length + 1)}/conf/layer.conf`, `BBPATH .= ":\${LAYERDIR}"
BBFILES += "\${LAYERDIR}/recipes-*/*/*.bb \${LAYERDIR}/recipes-*/*/*.bbappend"
BBFILE_COLLECTIONS += "${collection}"
BBFILE_PATTERN_${collection} = "^\${LAYERDIR}/"
BBFILE_PRIORITY_${collection} = "1000"
LAYERSERIES_COMPAT_${collection} = "scarthgap"
`);

await put("build/conf/local.conf", `MACHINE ??= "qemux86-64"
DISTRO ?= "poky"
PACKAGE_CLASSES ?= "package_rpm"
DL_DIR = "${downloads}"
SSTATE_DIR = "${sstate}"
TMPDIR = "${tmpDir}"
BB_NO_NETWORK = "1"
PATCHRESOLVE = "noop"
${scenario === "04" ? 'BB_DANGLINGAPPENDS_WARNONLY = "1"\n' : ""}BB_NUMBER_THREADS ?= "8"
PARALLEL_MAKE ?= "-j8"
EXTRA_IMAGE_FEATURES = "debug-tweaks"
USER_CLASSES ?= "buildstats"
INHERIT:remove = "create-spdx"
`);
const activeLayerEntry = scenario === "02" ? "" : `  ${layerDir} \\\n`;
await put("build/conf/bblayers.conf", `POKY_BBLAYERS_CONF_VERSION = "2"
BBPATH = "\${TOPDIR}"
BBFILES ?= ""
BBLAYERS ?= " \\
${activeLayerEntry}  ${metaLocal} \\
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

if (scenario === "01") {
  await put("controller/source/sensor-reader-2.0/LICENSE", fixtureLicense);
  await put("controller/source/sensor-reader-2.0/src/main.c", `#include <stdio.h>
#include <string.h>
#include "telemetry.h"

int main(int argc, char **argv)
{
    int offline_mode = argc == 2 && strcmp(argv[1], "--offline") == 0;
    puts(telemetry_should_send(offline_mode) ? "telemetry: sent" : "telemetry: disabled");
    return 0;
}
`);
  await put("controller/source/sensor-reader-2.0/src/telemetry.c", `#include "telemetry.h"

/* Version 2.0 moved telemetry into src/ and centralized policy here. */
int telemetry_should_send(int offline_mode)
{
    (void)offline_mode;
    return 1;
}
`);
  await put("controller/source/sensor-reader-2.0/src/telemetry.h", `#pragma once

int telemetry_should_send(int offline_mode);
`);
  const archive = join(layerDir, "recipes-validation", "sensor-reader", "files", "sensor-reader-2.0.tar.gz");
  await mkdir(dirname(archive), { recursive: true });
  await execFileAsync("tar", ["--sort=name", "--mtime=UTC 2026-01-01", "--owner=0", "--group=0", "--numeric-owner", "-C", join(runRoot, "controller", "source"), "-czf", archive, "sensor-reader-2.0"]);
  await put("layer/recipes-validation/sensor-reader/files/0001-disable-telemetry-while-offline.patch", `From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Validation Fixture <validation@example.invalid>
Date: Wed, 29 Jul 2026 00:00:00 +0000
Subject: [PATCH] telemetry: disable transmission while offline

The product must not send telemetry while it is operating without a network.

Upstream-Status: Inappropriate [product policy]
Signed-off-by: Validation Fixture <validation@example.invalid>
---
 telemetry.c | 4 ++++
 1 file changed, 4 insertions(+)

diff --git a/telemetry.c b/telemetry.c
index 025eedf..5de4c79 100644
--- a/telemetry.c
+++ b/telemetry.c
@@ -1,6 +1,10 @@
 #include "telemetry.h"
${" "}
 int telemetry_should_send(int offline_mode)
 {
+    if (offline_mode)
+        return 0;
+
     return 1;
 }
--${" "}
2.43.0
`);
  await put("layer/recipes-validation/sensor-reader/sensor-reader_2.0.bb", `SUMMARY = "Offline-aware sensor reader validation fixture"
DESCRIPTION = "Small fixture whose product patch must suppress telemetry in offline mode"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=d23c863dbfb78dd23ff11aa8049394b6"
SRC_URI = "file://sensor-reader-2.0.tar.gz file://0001-disable-telemetry-while-offline.patch"
S = "\${WORKDIR}/\${BP}"
do_compile() {
    \${CC} \${CFLAGS} \${LDFLAGS} -Isrc -o sensor-reader src/main.c src/telemetry.c
    \${BUILD_CC} -Isrc -o sensor-reader-selftest src/main.c src/telemetry.c
    output="$(./sensor-reader-selftest --offline)"
    test "$output" = "telemetry: disabled"
}
do_install() {
    install -d \${D}\${bindir}
    install -m 0755 sensor-reader \${D}\${bindir}/sensor-reader
}
FILES:\${PN} = "\${bindir}/sensor-reader"
`);
}

if (scenario === "02") {
  await mkdir(layerDir, { recursive: true });
  await put("attachments/validation-health", `#!/bin/sh

if [ "$1" = "--self-test" ]; then
    echo "validation-health: ok"
    exit 0
fi

echo "usage: validation-health --self-test" >&2
exit 2
`, 0o700);
  await put("attachments/LICENSE", fixtureLicense);
}

if (scenario === "03") {
  await put("layer/recipes-validation/field-console/field-console/field-console", `#!/bin/sh

if [ "$1" = "--version" ]; then
    echo "field-console 1.0"
    exit 0
fi
echo "usage: field-console --version" >&2
exit 2
`, 0o755);
  await put("layer/recipes-validation/field-console/field-console/LICENSE", fixtureLicense);
  await put("layer/recipes-validation/field-console/field-console_1.0.bb", `SUMMARY = "Field console package split validation fixture"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=d23c863dbfb78dd23ff11aa8049394b6"
SRC_URI = "file://field-console file://LICENSE"
S = "\${WORKDIR}"
PACKAGES =+ "\${PN}-cli"
do_install() {
    install -d \${D}\${bindir}
    install -m 0755 \${WORKDIR}/field-console \${D}\${bindir}/field-console
}
FILES:\${PN}-cli = "\${bindir}/field-console"
`);
  await put("layer/recipes-core/images/validation-field-image.bb", image("field console", "field-console"));
}

if (scenario === "04") {
  await put("layer/recipes-kernel/linux/linux-yocto/validation-ikconfig.cfg", `CONFIG_IKCONFIG=y
CONFIG_IKCONFIG_PROC=y
`);
  await put("layer/recipes-kernel/linux/linux-yocto_6.1.bbappend", `FILESEXTRAPATHS:prepend := "\${THISDIR}/\${PN}:"
SRC_URI += "file://validation-ikconfig.cfg"
`);
  await put("layer/recipes-core/images/validation-ikconfig-image.bb", image("kernel IKCONFIG", ""));
}

if (scenario === "05") {
  const archiveName = `offline-report-${runId}.tar.xz`;
  for (const candidate of [join(downloads, archiveName), join(downloads, `${archiveName}.done`)]) {
    try {
      await stat(candidate);
      throw new Error(`Shared DL_DIR already contains the unique fixture object: ${candidate}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await put("controller/source/offline-report-1.0/LICENSE", fixtureLicense);
  await put("controller/source/offline-report-1.0/offline-report", `#!/bin/sh
echo "offline-report: ready"
`, 0o755);
  const archive = join(runRoot, "mirror", archiveName);
  await mkdir(dirname(archive), { recursive: true });
  await execFileAsync("tar", ["--sort=name", "--mtime=UTC 2026-01-01", "--owner=0", "--group=0", "--numeric-owner", "-C", join(runRoot, "controller", "source"), "-cJf", archive, "offline-report-1.0"]);
  const archiveSha256 = await sha256(archive);
  await put("layer/recipes-validation/offline-report/offline-report_1.0.bb", `SUMMARY = "Offline mirror and recovery validation fixture"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=d23c863dbfb78dd23ff11aa8049394b6"
SRC_URI = "https://fixtures.example.invalid/${archiveName}"
SRC_URI[sha256sum] = "${archiveSha256}"
S = "\${WORKDIR}/offline-report-1.0"
do_install() {
    install -d \${D}\${bindir}
    install -m 0755 \${S}/offline-report \${D}\${bindir}/offline-report
}
FILES:\${PN} = "\${bindir}/offline-report"
`);
  await put("layer/recipes-core/images/offline-report-image.bb", image("offline report", "offline-report"));
}

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
