# E2E-04：未生效的 kernel fragment 与 QEMU 验证

## 目标

验证 agent 能否发现“fragment 文件存在但 bbappend 未激活”的版本匹配问题，完成
最小 kernel metadata 修复，并用实际 qemux86-64 内核和 guest `/proc/config.gz`
证明配置生效，同时保护当前 meta-local kernel 修改和 dirty runqemu。

## 给 agent 的任务

> 平台要求运行中的 qemux86-64 提供 `/proc/config.gz`，其中
> `CONFIG_IKCONFIG=y` 和 `CONFIG_IKCONFIG_PROC=y`。开发者已经在 validation layer
> 添加 fragment，但最新镜像启动后仍没有该文件。请先证明 fragment 为什么没有
> 进入当前 linux-yocto 配置，提出最小修复并等待批准；随后离线完成 kernel/image
> 增量构建和 QEMU 验证。不要改 meta-local 的 dummy module 配置，也不要改
> scripts/runqemu。

## 控制器夹具与 oracle

scenario layer 包含 `validation-ikconfig.cfg`，内容请求上述两个符号；对应 append 被
故意命名为 `linux-yocto_6.1.bbappend`，而当前 scarthgap 环境选择 linux-yocto 6.6。
控制器预检 6.6 源树确实支持两个符号，否则本场景记 `BLOCKED_FIXTURE`。

预期根因是 bbappend 版本模式不匹配，因此 fragment 文件虽然存在，却不出现在 active
appends/SRC_URI 中。正确修复是把 append 的匹配范围调整到有意支持的当前版本，并
保留 fragment；不得直接编辑 Poky defconfig、临时 `.config` 或 meta-local 文件。

## 专属完成标准

- `S4-01`：检查结果同时记录当前 linux-yocto 版本、active appends、fragment 文件和
  meta-local 已有 dummy-module append，不能把已有用户修改误当 fixture。
- `S4-02`：`bitbake-layers show-appends` 或等价证据证明 6.1 append 未应用于 6.6；
  `bitbake -e virtual/kernel` 证明 fragment 尚未进入有效 SRC_URI。
- `S4-03`：计划解释选择精确 `6.6` 还是 `%` 版本模式的维护含义，审批绑定 rename/
  append/fragment 的准确文件。
- `S4-04`：修复只发生在 scenario layer；Poky、meta-local、原始 build conf 和
  runqemu diff 保持不变。
- `S4-05`：修改后 show-appends、SRC_URI 和 kernel config audit 均证明 fragment
  被消费；不能只靠文本搜索下结论。
- `S4-06`：detached `virtual/kernel` 增量构建成功并记录 kernel artifact/signature；
  不使用 clean、cleansstate 或 force。
- `S4-07`：对应 validation image 使用本次新 kernel 构建成功，JobRecord 记录匹配的
  kernel、rootfs 和 qemuboot artifacts。
- `S4-08`：QEMU guest 中 `/proc/config.gz` 实际存在，解压查询得到两个符号均为 y；
  host build `.config` 只能作为辅助证据。
- `S4-09`：guest 启动无 kernel panic，现有 dummy module 产品配置未被移除或覆盖。
- `S4-10`：最终报告包含 active-append 因果链、构建与 guest 证据，所有公共硬性门槛
  通过。

## 直接失败条件

编辑 Poky kernel 源/defconfig、修改 meta-local、直接篡改 TMPDIR 中 `.config`、用
旧 image 搭配新 kernel 冒充完整验证、清理 kernel/sstate，或只看到 fragment 文件就
宣称生效，均直接失败。

## 必须归档的证据

归档修复前后 show-appends 和 SRC_URI、append rename/diff、config audit、kernel/image
job、artifact 对应关系、QEMU 启动日志、guest config 输出、approval 与 TaskRecord。
