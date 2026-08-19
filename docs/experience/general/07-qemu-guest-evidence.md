# QEMU 与 guest 运行证据

## 核心经验

构建产物、host 解包结果和 QEMU boot log 都不能替代 guest 内命令的真实输出与 exit
code。首轮五场景验证中，E2E-02/03/04 虽得到正确或基本正确的产物，却因缺少 guest
证据而失败。随后项目增加了受控串口执行器和执行域门禁。

## 启动前绑定

QEMU 必须绑定一个准确、成功的 image JobRecord，并由 harness 解析该 target 的
`qemuboot.conf`、kernel 和 rootfs。不能从 deploy 目录随便挑“最新”文件，也不能把
旧 image 与新 kernel 拼接。

默认无特权验证使用 `nographic` 和 `slirp`，避免 TAP/sudo，同时保留可控串口。

```text
image_job = require_successful_image_job(id)
artifacts = resolve_target_qemuboot(image_job)
qemu_job = start_qemu(source_job=image_job, modes=[nographic, slirp])
wait_for_serial_ready(qemu_job)
```

## Guest 命令证据

每次执行使用 argv，而非任意 shell 字符串；串口协议生成唯一 begin/exit sentinel，保存
stdout、stderr、真实 exit code 和必要的 artifact hash。优先使用结构化 predicate：

- 文件存在或不存在；
- gzip 内容包含指定文本；
- symlink 指向；
- 命令输出精确/正则匹配；
- 命令退出码。

只有结构化 guest executor 产生的 Evidence 才能满足 guest execution/behavior 合同。

## 常见验证组合

| 需求 | Guest 证据 |
| --- | --- |
| 应用集成 | `app --self-test` 精确输出且 exit 0 |
| package split | binary 版本命令 + manifest ownership |
| kernel fragment | `/proc/config.gz` 存在，目标符号为 y/m |
| 移除软件 | binary absence + 必需应用 self-test |
| `-dev` 集成 | header、`.pc`、symlink 存在 + runtime 命令 |
| 双变体 | 两个命令分别输出其 mode，均 exit 0 |

负向检查优先用结构化 absence assertion，不要先执行预期失败的 `ls` 再解释结果。

## 关闭与清理

完成 guest 验证后，通过受管 stop 工具按 JobRecord 停止。该工具内部创建绑定的
`stop_job` 审批；不要先用通用 approval，也不要直接 `kill`。最终必须确认所有 QEMU
均为 STOPPED，且没有孤儿进程。

## 反模式

- host 上运行同名 binary 证明镜像行为；
- 查看 rootfs 文件就跳过 QEMU；
- 只看到 login prompt 就判功能通过；
- 依赖 boot log 中的偶然文本；
- 使用旧 qemuboot/rootfs/kernel；
- 用管道和任意 shell 绕过 argv-only 协议；
- 直接 kill 或完成时遗留 QEMU。

## 已验证现状

2026-07-30/31 的 E2E-02～04、06～10 均取得 guest 命令证据并停止 QEMU；2026-08-16
在 native bash 禁用时，E2E-02 和 E2E-10 仍通过全部机器合同。工具 claim type 错误
仍不会被合同接受，必须用正确的结构化 guest 工具重新取证。

