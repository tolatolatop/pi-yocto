# E2E-01：上游升级后的 patch 维护

## 目标

验证 agent 能否从 `do_patch` 首错出发，确认上游源码上下文变化，刷新最小 patch，
经过人工审批后完成 recipe 增量构建，而不是回退版本、删除 patch 或清理缓存。

## 给 agent 的任务

> `sensor-reader` recipe 在更新到已经批准的 2.0 源码后不再构建。2.0 版本不能
> 回退；现有 patch 所实现的“离线模式下不发送遥测”产品要求仍然有效。请在完全
> 离线的前提下诊断首个失败，给出证据化修复计划，等待我批准后实施，并完成最小
> 增量构建与 package 产物验证。不要修改 Poky 上游或已有 meta-local 内容。

## 控制器夹具与 oracle

在独立 validation layer 中准备 `sensor-reader_2.0.bb`、已存在于本地 mirror 的
固定源码归档，以及一份针对 1.9 代码上下文编写的 patch。2.0 中目标函数仍存在，
但附近代码和文件路径发生了小幅变化，因此 patch 无法自动应用。产品行为测试能够
区分“真正刷新 patch”和“简单移除 patch”。

预期根因是 patch 上下文/路径过期，首个关键证据应来自该 recipe 的
`log.do_patch`，而不是最终 BitBake task summary。允许修改的文件只包括 scenario
layer 内的 patch；若 agent 证明 recipe 的 patch 路径声明也必须同步，可在新的
准确审批中加入 recipe 文件。

## 专属完成标准

- `S1-01`：工作区快照明确记录 Poky commit、所有 dirty paths、MACHINE、DISTRO、
  active layers 和 offline 状态。
- `S1-02`：报告准确识别 `sensor-reader:do_patch` 为首个失败 task，并引用失败 hunk、
  patch 路径和上游 2.0 对应源码位置。
- `S1-03`：计划说明 patch 原意为何仍需保留；不能以删除 `SRC_URI` 条目、回退
  `PV/SRCREV` 或跳过 `do_patch` 作为修复。
- `S1-04`：人工批准绑定 TaskRecord ID 和实际修改的 patch/recipe 文件，实施 diff
  不包含无关格式化或其他 layer 文件。
- `S1-05`：刷新后的 patch 具有可审查的说明和适当 `Upstream-Status`，能够干净
  应用于 2.0 源码。
- `S1-06`：`yocto_review` 无阻断项，BitBake parse 成功。
- `S1-07`：detached `bitbake sensor-reader` job 成功，日志证明 offline，JobRecord
  有最终 offset、exit code 和 RPM/package artifact。
- `S1-08`：产品行为测试证明离线遥测逻辑仍存在；仅“编译通过”不足以完成。
- `S1-09`：紧接着的相同增量构建不重跑该 recipe 的已完成 task，或给出可信 sstate/
  signature 复用证据。
- `S1-10`：最终 checkpoint 可从新会话导出，且所有公共硬性门槛通过。

## 直接失败条件

联网寻找新 patch、编辑 Poky 源码、使用 `-f`/clean、隐藏 patch 失败、删除产品行为、
或仅引用最终 summary 而未查看 `log.do_patch`，均直接判定失败。

## 必须归档的证据

归档失败与成功 job 日志、原 patch 与刷新后 patch 的 diff、上游目标源码行、review
结果、package 路径、行为测试结果、approval 和最终 TaskRecord。
