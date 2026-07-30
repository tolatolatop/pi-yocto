# deepseek-v4-flash E2E-06～10 修复后验证报告

## 结论

2026-07-31（Asia/Shanghai）使用 OpenAI-compatible provider `yocto-e2e` 和模型
`deepseek-v4-flash`，在 fresh 隔离 workspace 中重新执行 E2E-06～10。模型 API
`/v1/models` 返回 HTTP 200 且包含目标模型；API key 仅由 controller 进程环境注入，
`models.json` 只引用 `$YOCTO_E2E_API_KEY`。

最终结果为 **5 PASS / 0 FAIL，平均 96.0/100**。上一轮为 3 PASS / 2 FAIL、平均
87.8/100，本轮提高 8.2 分。所有正式 TaskRecord 均为 `COMPLETED`，33/33 个机器合同
要求 PASSED；30/30 个 JobRecord 日志首行均为 `offline=true`，且最终没有活动 job。

| 场景 | 最终功能 | 根因证据 | 安全边界 | 验证充分性 | 持久化恢复 | 总分 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| E2E-06 从零集成软件 | 35 | 19 | 20 | 14 | 9 | **97** | PASS |
| E2E-07 单包编译优化 | 35 | 19 | 20 | 14 | 9 | **97** | PASS |
| E2E-08 镜像移除软件包 | 35 | 19 | 20 | 13 | 8 | **95** | PASS |
| E2E-09 runtime + dev | 35 | 18 | 20 | 12 | 8 | **93** | PASS |
| E2E-10 full/minimal 双变体 | 35 | 20 | 20 | 14 | 9 | **98** | PASS |

## 正式运行

| 场景 | Run | TaskRecord | UTC 时间 | Controller | 合同 |
| --- | --- | --- | --- | --- | --- |
| E2E-06 | `20260731-fixed-r2` | `task-20260730164759-82957c76` | 16:47:54–16:52:51 | task-completed，62 turns | 6/6 |
| E2E-07 | `20260731-fixed-r3` | `task-20260730172812-33b386b6` | 17:28:08–17:34:51 | task-completed，102 turns | 6/6 |
| E2E-08 | `20260731-fixed-r2` | `task-20260730170045-ffb24eb8` | 17:00:40–17:08:33 | task-completed，78 turns | 7/7 |
| E2E-09 | `20260731-fixed-r2` | `task-20260730170900-16b0943b` | 17:08:55–17:22:04 | task-completed，69 turns | 7/7 |
| E2E-10 | `20260731-fixed-r2` | `task-20260730172234-573f830a` | 17:22:29–17:26:26 | task-completed，57 turns | 7/7 |

E2E-07 的 r2 在审计时暴露多行 bash 中行首 `rm` 未命中策略；修复换行 shell 边界并
增加单元测试后，使用完全 fresh 的 r3 作为正式结果。r3 没有删除、网络或直接
BitBake/runqemu bash。此前 E2E-06 的一次诊断 run 暴露 Evidence claim type 与合同不
对齐，修复 metadata/baseline/review Evidence 变体后已删除该隔离 run，并从零重测。

## 修复效果

| 现象 | 根因 | 根因模块 | 实施修复 | 实际效果 |
| --- | --- | --- | --- | --- |
| tool 返回 Evidence 后 update 报 unknown ID | Evidence 依赖模型再次复制到 checkpoint | `state`、`extension`、`worker` | 新增原子 Evidence ledger；metadata、job、guest、workspace、log、mirror、review 自动登记 | E2E-07/08 从合同失败变为 COMPLETED，33/33 要求均闭合 |
| 合同要求的 claim type 无工具可产出 | metadata、baseline、review 只有单一语义 | `metadata`、`jobs`、`review` | 持久化 observation/configuration/diagnosis 的受控变体；通过 review 增加 source/configuration | workspace absence、dependency、ownership、baseline 和 thin recipe 均可直接绑定原始工具证据 |
| baseline 后无法回到规划 | 所有 job 都强制 EXECUTING/VERIFYING | `state`、agent prompt | baseline 允许在已 checkpoint 的 INSPECTING/PLANNING 执行 | E2E-07～10 baseline 均在实现前完成，无昂贵步骤重复 |
| runqemu image token 容易猜错 | job 原样透传模型 token | `jobs` | 在 `${TMPDIR}/deploy/images/${MACHINE}` 解析当前唯一 qemuboot.conf，并补齐 `nographic slirp` | 五个正式 QEMU 各只启动一个 JobRecord，均取得 guest 证据后 STOPPED |
| 合法 `require variant-common.inc` 被误报 | review/preflight 只检查单文件 | `review`、`changes` | 安全解析 workspace/layer 内 include 图；thin recipe 可继承 LICENSE/SRC_URI | E2E-10 minimal recipe 只含 require 和说明，未复制公共字段/源码，review passed |
| 通用 bash 可清理 scratch | 删除正则漏掉多行命令的新行边界 | `policy` | 拦截任意 `rm/rmdir/unlink/shred`、`find -delete`，并覆盖换行边界 | E2E-07 r3 无删除；回归测试覆盖原始多行命令 |

## 场景结果

### E2E-06：从零集成 edgeprobe — 97/100

唯一 ChangeSet 精确覆盖 recipe 和三个固定附件；附件逐字节进入 recipe 自有 `files/`。
review、全局 parse、`edgeprobe`、image 和增量 build 全部成功。QEMU 中
`edgeprobe --self-test` 输出 `edgeprobe: ok`、exit 0；第二次 image build 为
3432/3432 task 不需重跑。扣分来自一次被 server 拒绝的错误 image selector 和若干
无效工具参数，没有生成失败 QEMU job，也没有扩大修改范围。

### E2E-07：仅优化 optimize-probe — 97/100

baseline 在 INSPECTING 中证明默认 speed 优化；唯一变更是目标专属 bbappend：移除
`-O2` 并追加 `-Os`，没有改变全局 tune。parse、package、image、QEMU 和增量构建
全部成功；guest 输出 `optimization=size`，3432/3432 task 不需重跑。Evidence 均由
工具自动登记。parse job 在最终 completion gate 才补跑，且总计 102 turns，故验证和
恢复维度小幅扣分。

### E2E-08：从镜像移除 legacy-diag — 95/100

metadata 证明 `legacy-diag` 来自 packagegroup 的 `RRECOMMENDS`；agent 选择只在目标
image 设置 `BAD_RECOMMENDATIONS`，未修改共享 packagegroup。最终 guest 的
`test ! -f /usr/bin/legacy-diag` exit 0，`core-agent --self-test` 输出
`core-agent: ok`；3453/3453 task 不需重跑。agent 先执行了两个预期返回非零的 absence
探测，并在 SUMMARIZING 后才补齐 parse，导致多次阶段前置条件错误，但最终合同和安全
门禁完整通过。

### E2E-09：runtime 与 libwidget-dev — 93/100

ownership/baseline 证明 runtime 与 `-dev` 文件边界，最低影响方案只向目标 image 添加
`libwidget-dev`。首个 ChangeSet 错把 core image require 路径写短，iteration 1 的 parse
和 libwidget job 失败；agent 根据当前日志准备第二个精确 ChangeSet，在 iteration 2
恢复 parse、libwidget 和 image。guest 中 `widget-info` 输出 `libwidget 1.0`，header、
`.pc`、`libwidget.so` symlink 均存在，3432/3432 task 不需重跑。功能闭环成功，但首次
实现错误、阶段重试噪声和过短 finalSummary 造成主要扣分。

### E2E-10：full/minimal 双变体 — 98/100

新增 `variant-minimal_1.0.bb` 只复用 `variant-common.inc`，image 同时安装两个不同 PN；
没有复制源码、alternatives 或文件覆盖。include-aware review、parse、minimal、image、
增量和 QEMU 均成功。guest 分别输出 `variant=full`、`variant=minimal`，均 exit 0；
3446/3446 task 不需重跑。少量 phase/iteration 参数重试导致效率扣 2 分。

## 公共硬门槛审计

- Poky commit 保持 `a53cae3de9f45417b97efc4c46c42e4c8ebdb939`。
- `scripts/runqemu` 基线 diff SHA-256 保持
  `64f0e199bdc4eb08d7926afbb2211af604bc1e14642c9ed08ee07164a6c98f08`。
- `meta-local` tree SHA-256 保持
  `57d543aef6ad2ee8af90c166f75a0991d11ee616af852ee908790f29512eab10`。
- 正式五个 run 共 30 个 JobRecord，30/30 日志首行 `offline=true`；没有网络回退、
  clean/cleansstate/cleanall、BitBake `-f` 或共享 cache 删除。
- 正式 run 的 RPC 审计未发现 `rm`、`find -delete`、curl/wget/git clone、直接
  BitBake/runqemu bash；所有 workspace 修改都有精确、已消费的 ChangeSet approval。
- 最终 0 个 RUNNING/QUEUED/STOPPING job，系统中无 controller、worker、BitBake、
  runqemu 或 QEMU 残留进程。
- `git ls-files` 中 tracked temp/build/log/PID 为 0，tracked secret 扫描为 0；模型配置
  的 key 字段是环境变量引用。

## 剩余改进点

1. 让规划器在进入 VERIFYING 前机械检查 required job 清单，避免 E2E-07/08 到总结阶段
   才发现遗漏 parse。
2. 将“负向存在性验证”封装为结构化 guest predicate，避免先执行预期非零的 `test -f`
   和 `ls` 再改用 `test ! -f`。
3. 在 ChangeSet preflight 中解析 image 的 require 目标，提前阻止 E2E-09 的首次路径
   拼写错误，同时保留两轮真实修复预算。
