# Kernel fragment 未生效

适用：fragment 文件存在，但当前 kernel 配置或运行中的 guest 没有目标符号。

## 典型因果链

```text
fragment 文件存在
  ≠ bbappend 匹配当前 kernel 版本
  ≠ fragment 进入有效 SRC_URI
  ≠ Kconfig 依赖接受符号
  ≠ image 使用本次新 kernel
  ≠ guest 运行时配置生效
```

每个箭头都需要独立证据。

## 诊断步骤

1. 记录当前 `virtual/kernel` provider/PV 和已有产品 append；
2. `show-appends` 检查目标 bbappend 是否激活；
3. `bitbake -e virtual/kernel` 检查 fragment 是否进入最终 SRC_URI；
4. 检查 config audit，区分未消费、依赖不满足和架构限制；
5. 保护已有 meta-local kernel 配置和 dirty `scripts/runqemu`。

E2E-04 中 append 名为 `linux-yocto_6.1.bbappend`，当前 scarthgap 选择 6.6。文件存在
但 append 不激活。最终唯一变更是改为精确 6.6 匹配，并同时验证已有
`CONFIG_DUMMY=m` 未被覆盖。

## 版本匹配决策

| 选择 | 适用 | 风险 |
| --- | --- | --- |
| 精确 `_6.6.bbappend` | 已验证只支持当前系列 | 升级时需显式维护 |
| `%` 通配 | 多版本确实共用且持续验证 | 可能静默应用到不兼容版本 |

不要为了省维护直接选 `%`。计划应写明维护范围和升级策略。

## 实施边界

- 只修改产品/scenario layer 的 append 名称、内容或 fragment；
- 不编辑 Poky kernel source/defconfig；
- 不修改 TMPDIR 中 `.config`；
- 不删除已有 fragment 或 meta-local 配置；
- 不 clean、cleansstate 或 force kernel task。

## 验证闭环

1. 修复后再次 `show-appends` 和查询 SRC_URI；
2. config audit 证明目标符号被消费；
3. detached `virtual/kernel` 普通增量构建；
4. 构建对应 validation image，记录 kernel/rootfs/qemuboot 绑定；
5. 从该 image job 启动 QEMU；
6. guest 中确认 `/proc/config.gz` 存在并读取目标符号；
7. 确认无 panic，既有产品符号仍在，停止 QEMU。

Host `.config` 只能辅助说明构建结果，不能满足运行时合同。E2E-04 的最终 guest artifact
同时包含 `CONFIG_IKCONFIG=y`、`CONFIG_IKCONFIG_PROC=y` 和 `CONFIG_DUMMY=m`。

## 反模式

- 看到 `.cfg` 文件便宣布生效；
- 只验证 show-appends，不看最终 SRC_URI/config audit；
- 直接篡改 defconfig 或 workdir `.config`；
- 新 kernel 配旧 image/rootfs；
- host `.config` 冒充 guest `/proc/config.gz`；
- 为 kernel 变化清空 sstate。

来源：E2E-04 和 2026-07-30 最终验证报告。

