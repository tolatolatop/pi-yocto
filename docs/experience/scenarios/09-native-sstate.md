# Native sstate 跨 MACHINE 复用

适用：相同 build host 上，不同 target MACHINE 不能复用 `*-native` sstate，怀疑目标侧
变量污染 native 任务签名。

## 先理解正常现象

Native 工具在 build host 执行，`TARGET_ARCH` 经 native class 映射成 BUILD_ARCH 是正常
的。某个变量出现在 `bitbake -e` datastore 中，也不表示它进入了特定 task 的签名依赖。

2026-08-13 的只读能力验证中：`BUILD_ARCH`、native-remapped `TARGET_ARCH` 和
`PACKAGE_ARCH` 均为 x86_64；MACHINE_FEATURES 虽在 datastore，却未进入被检查 task
依赖。这些都不构成污染证据。

## 诊断证据

1. 查询 SSTATE_DIR/SSTATE_MIRRORS、SSTATE_PKGARCH、uninative/hash server；
2. 审计 `BB_ENV_PASSTHROUGH(_ADDITIONS)` 和实际导入环境；
3. 读取 cooker `Sstate summary`，区分 Current、Local、Mirrors、Missed；
4. 检查 native `do_compile` 或 `do_populate_sysroot` sigdata；
5. 比较两个 MACHINE 的签名，找到第一个 target-side 差异；
6. 只修复第一个不应进入 native identity 的输入。

可疑输入包括 MACHINE、MACHINE_ARCH、MACHINEOVERRIDES、MACHINE_FEATURES、DEFAULTTUNE、
target-side TUNE_FEATURES/TUNE_PKGARCH、TARGET_FPU；但必须证明它们实际进入依赖。

## E2E-11 注入缺陷

验证夹具把 `native.bbclass` 从：

```bitbake
PACKAGE_ARCH = "${BUILD_ARCH}"
```

改为：

```bitbake
PACKAGE_ARCH = "${MACHINE_ARCH}"
```

这会让 native sstate key 随 target MACHINE 变化。夹具在隔离 Poky copy 中验证
broken/fixed × qemux86-64/qemuarm64，不修改共享 Poky、TMPDIR 或 sstate。

## 修复和验证

```text
broken_a = cold_build(machine_a, cache_broken)
broken_b = warm_build(machine_b, cache_broken)
diff = first_native_signature_difference(broken_a, broken_b)

repair_isolated_source(diff.unwanted_input)

fixed_a = cold_build(machine_a, cache_fixed)
fixed_b = warm_build(machine_b, cache_fixed)
require(fixed_b.reuses_native_sstate)
require(target_arch_artifacts_remain_correct)
```

证明 cache 复用应使用新 TMPDIR 和最初为空的 cache，观察 Local/Mirror 命中与签名一致，
不能用 `Current` 代替。修复时不要把 MACHINE 粗暴加入全局 hash ignore，因为这可能
隐藏真正 target-sensitive 任务。

## 反模式

- 变量出现在 datastore 就判污染；
- 将 native 的 TARGET_ARCH=BUILD_ARCH 判为错误；
- 用同一 TMPDIR 的 Current 证明跨 MACHINE 复用；
- 修改共享 Poky 或共享 cache 做实验；
- cleanall 后只比较耗时；
- 用全局 hash ignore 掩盖第一个错误依赖。

来源：E2E-11、2026-08-13 PASS 报告和 `knowledge/scarthgap/build-cache.md`。

