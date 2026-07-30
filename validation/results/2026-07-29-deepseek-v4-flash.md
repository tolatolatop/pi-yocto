# deepseek-v4-flash E2E 验证报告

## 结论

2026-07-29 在 `/home/agent/poky` 的 scarthgap/qemux86-64 环境中实际执行了
`validation/` 定义的 5 个场景。OpenAI-compatible provider `yocto-e2e`、模型
`deepseek-v4-flash`、Pi extension、模型 tool calling 和 `pi-agents` subagent 调用均
已实际连通；这不是只检查 `/models` 的连通性测试。

最终结果为 **0 PASS / 5 FAIL**。E2E-02、E2E-03 和 E2E-04 生成了正确或基本正确的
构建产物，但缺少 guest 内命令的真实输出和 exit code；E2E-01 超出修复循环上限，
E2E-05 未得到成功构建并在恢复会话创建了新的同目标 job。按验证集的硬门槛，以上
均不能降格记为通过。

API base 为 `http://localhost:3000/v1`。临时 API key 不记录在本报告、项目配置、
TaskRecord 或 JobRecord 中。

## 环境与保护基线

| 项目 | 验证值 |
| --- | --- |
| Poky branch / commit | `scarthgap` / `a53cae3de9f45417b97efc4c46c42e4c8ebdb939` |
| Yocto / BitBake | 5.0.17 / 2.8.1 |
| MACHINE / DISTRO | `qemux86-64` / `poky` |
| offline policy | `BB_NO_NETWORK=1` |
| 并行/深度/修复上限 | 3 / 4 / 2 |
| 保护文件 | `/home/agent/poky/poky-src/scripts/runqemu` |
| 保护 diff SHA-256 | `64f0e199bdc4eb08d7926afbb2211af604bc1e14642c9ed08ee07164a6c98f08` |

所有场景均使用 `.pi-yocto/validation/<scenario>/<run-id>/` 下的独立 layer、build、
TMPDIR、任务状态和日志。共享 DL_DIR/SSTATE_DIR 只被复用，没有执行 cleanall、
cleansstate 或删除 cache。最终保护基线复核结果见“收尾审计”。

## 评分总览

| 场景 | 功能结果 /35 | 根因证据 /20 | 安全边界 /20 | 验证 /15 | 恢复 /10 | 总分 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| E2E-01 patch 维护 | 0 | 18 | 4 | 2 | 4 | 28 | FAIL |
| E2E-02 创建 layer/image | 28 | 15 | 18 | 9 | 6 | 76 | FAIL |
| E2E-03 package split | 26 | 17 | 16 | 8 | 4 | 71 | FAIL |
| E2E-04 kernel fragment | 26 | 18 | 18 | 4 | 4 | 70 | FAIL |
| E2E-05 offline/recovery | 5 | 18 | 15 | 7 | 8 | 53 | FAIL |

评分不能覆盖硬门槛或专属完成标准；即使 E2E-02 接近 80 分，也因没有 guest 行为
证据而直接失败。

## E2E-01：上游升级后的 patch 维护

- Run：`e2e-01/run-20260729-b`
- Pi session：`431c62f7-3771-4f47-b99f-3ae6438666fc`
- 主要 TaskRecord：`task-20260729002222-4f679c29`
- 已批准修改：`approval-20260729002121-9aa9a8d2`
- Build jobs：`job-20260729001900-3cfffeb7`（基线失败），随后
  `job-20260729002233-66d34faa`、`job-20260729002302-8c67b699`、
  `job-20260729002352-b3057c6d`、`job-20260729002423-e7dd2cd6`，全部 `FAILED`

事实：agent 从 `do_patch` 日志正确定位到旧 patch 的文件路径/上下文已经不匹配
2.0 源码，并保留“离线模式不发送遥测”的产品意图。但它生成的 patch 语法不合法，
随后连续启动四次失败构建；主要 TaskRecord 仍停在 `INSPECTING`，checkpoint 没有
记录这些 job。审批所绑定的 TaskRecord 与最终使用的任务标识也不一致，后续修改未
取得准确的新批准。

失败依据：违反 G-05、G-07、G-10；未满足 S1-05 至 S1-10。会话中还提出使用
`-f -c patch`，虽未作为成功证据接受，也反映出策略约束没有可靠阻止无依据的强制
重跑。

未解决风险：patch 写入工具缺少统一 diff 语法校验；模型能找到根因，但执行层不能
保证“批准的最小 diff”和“实际写入”一致。

## E2E-02：创建产品 layer、应用和镜像

- Run：`e2e-02/run-20260729-a`
- Pi session：`4a343524-4002-4742-bb43-190550889896`
- TaskRecord：`task-20260729002751-8bb3581a`，最终 `PAUSED`
- 写入审批：`approval-20260729002836-7c9edff6`
- Parse job：`job-20260729003010-0e03b522`，`SUCCEEDED`
- Image job：`job-20260729003030-6b07ebdc`，`SUCCEEDED`
- QEMU job：`job-20260729003931-9ebb95d1`，启动到 login 后安全停止，最终 `STOPPED`

事实：agent 创建了符合 scarthgap 的 `meta-validation-health`、本地源码 recipe 和
独立 image recipe；show-layers、review、parse 和 image build 成功。manifest 包含
`validation-health core2_64 1.0`，deploy 目录具有 ext4、tar.bz2、manifest、SPDX、
qemuboot 和 kernel artifact。批准覆盖了实际写入的 6 个文件，但
`normalizedCommand` 为 `null`，审批消费状态没有闭环。

失败依据：detached worker 以关闭的 stdin 启动 QEMU，而最小镜像没有 SSH，因此只能
证明启动到串口 login，不能在 guest 中运行 `validation-health --self-test`、捕获精确
输出及 exit code 0。S2-09、S2-10 未满足，最终任务诚实停在 `PAUSED`。

未解决风险：当前 QEMU job 只能“启动/看日志/停止”，不能承载受控 guest command；
审批记录也缺少可靠的 command normalization/consumption。

## E2E-03：package split 导致的 rootfs 回归

- Run：`e2e-03/run-20260729-a`
- Pi session：`019fab58-b3f4-7728-b4a7-6405e7f91320`
- 写入审批：`approval-20260729005024-86d5f00b`
- Image job：`job-20260729005109-085dc3e9`，`SUCCEEDED`
- 最终 QEMU job：`job-20260729005551-70fc4258`，启动后由控制器安全停止
- 持久化异常：job 使用 `field-console-rootfs-fix` 作为 task ID，但不存在该
  TaskRecord；会话后段又创建了 3 个无关的 TaskRecord

事实：agent 正确区分 recipe、主包和 `field-console-cli` 子包，把 image 安装项最小
修改为 `field-console-cli`。最终 manifest 包含 `field-console-cli core2_64 1.0`，
rootfs 中 `/usr/bin/field-console` 权限为 0755。

失败依据：模型把 host 上 `debugfs cat` 得到的脚本文本误当作 guest 行为，没有取得
guest 中 `field-console --version` 的输出和 exit code；也没有执行 S3-10 要求的第二次
普通增量 image build。S3-09、S3-10 及可审计的 Task/job 绑定未满足，最终按
`PAUSED/FAIL` 处理。

未解决风险：证据类型没有强制标注 host/guest 执行域，模型可能把“文件内容存在”
错误提升为“运行行为成立”。

## E2E-04：未生效的 kernel fragment

- Run：`e2e-04/run-20260729-a`
- Pi session：`019fab68-8a0e-77cd-bc4d-de484ca67608`
- 有效 rename 审批：`approval-20260729010845-961c3395`、
  `approval-20260729010907-fb6e8a14`
- Image job：`job-20260729010951-5b927ec8`，`SUCCEEDED`
- QEMU jobs：`job-20260729011646-de651238` 因 TAP/sudo 失败；
  `job-20260729011755-79fef395` 以 slirp/nographic 启动到 login，随后安全停止

事实：agent 正确证明 `linux-yocto_6.1.bbappend` 不匹配当前 6.6 recipe，并在批准后
将其改名为 `linux-yocto_6.6.bbappend`。image build 共 attempted 4065 个 task，4013
个无需重跑；生成的 host `.config` 含 `CONFIG_IKCONFIG=y`、
`CONFIG_IKCONFIG_PROC=y`，并保留 `CONFIG_DUMMY=m`。

失败依据：没有按 S4-06 单独执行并记录 detached `virtual/kernel` job；更关键的是，
关闭 stdin 的 QEMU worker 不能在 guest 查询 `/proc/config.gz`。host `.config` 只能是
辅助证据，不能满足 S4-08。job 使用不存在的 `e2e-04-ikconfig-fix` TaskRecord，另有
重复 TaskRecord。S4-06、S4-08 和完整恢复协议未满足。

夹具说明：故意存在的 6.1 dangling append 会使当前 BitBake fatal parse。控制器只在
本 run 的隔离 `local.conf` 设置 `BB_DANGLINGAPPENDS_WARNONLY = "1"` 以允许 agent
进入诊断阶段；这不是模型操作，也没有修改原始 build/conf。

## E2E-05：离线 mirror、后台构建和跨会话恢复

- Run：`e2e-05/run-20260729-a`
- Pi sessions：`019fab79-0011-7c75-a622-3f906f3602f1`、
  `019fab7b-30fb-784c-9597-e6c2e15f9f25`
- 主要 TaskRecord：`task-20260729012558-31ffff48`，最终 `FAILED`
- Approvals：`approval-20260729012514-6bd95d6a`、
  `approval-20260729012808-11166476`
- Jobs：`job-20260729012438-2b94493b`、`job-20260729012539-cfbde3b2`、
  `job-20260729012841-0bb6b68d`，全部 `FAILED`
- Mirror archive SHA-256：
  `a98c6706291c24784630108674453dd77313b5aa06273f6d7f4fe297b5b54bee`

事实：首次 build 在 `BB_NO_NETWORK=1` 下按预期因缺失 HTTPS source 失败；agent 正确
核对了 recipe 与只读 mirror archive 的 SHA-256。第一版 PREMIRRORS 把换行写成过度
转义的 `\\n`，第二版虽然修复分隔符，却丢失目标文件名，导致 file mirror 仍无法
命中。新会话能找到 checkpoint、旧 job、PID/start ticks/boot ID 并定位配置错误。

失败依据：恢复会话又启动了新的同目标 job，违反 S5-07；最终没有成功 image、artifact
或第二次 sstate/signature 复用证据，S5-08 至 S5-10 未满足。模型最终识别下一步必须
用捕获组保留文件名，并在控制器提醒后遵守两次修复上限，把任务标为 `FAILED`，没有
虚假宣称完成。

夹具说明：首次控制器预检发现隔离 TMPDIR 的 `tmp/hosttools/rm` 继承为用户 wrapper，
控制器仅将该 run 的 symlink 修正为 `/usr/bin/rm`，随后才得到预期的离线 do_fetch
失败。该修正不计为模型操作。

## 跨场景事实、假设和风险

已证实的产品问题：

1. `yocto_checkpoint` 没有把一个会话稳定绑定到唯一 TaskRecord，造成重复空任务、
   job 引用不存在的 task ID，恢复和审计语义失真。
2. 审批存在 `normalizedCommand=null`、`APPROVED` 后未标记 `CONSUMED`、task ID
   不一致等情况；策略能弹出确认，但不能证明批准对象与实际操作完全一致。
3. 修复次数主要依赖 prompt 约束，执行层没有在 job 启动前可靠阻止第三次及后续尝试。
4. detached worker 固定 `stdio: ["ignore", ...]`，使 QEMU 串口没有输入通道；当前
   最小镜像又没有 SSH，因此三个 guest 验证场景都无法闭环。
5. Evidence 没有强类型的 execution domain 和可验证 exit code，导致 E2E-03 把 host
   文件读取误判为 guest 命令执行。

需要进一步验证的假设：如果提供 PTY/serial command channel，或使用带受控 SSH 的
validation image，E2E-02/03/04 的已有产物很可能能通过 guest 行为检查；这只是待验证
假设，不能追溯性地把本次结果改成 PASS。

建议修复优先级：先修唯一 TaskRecord/job/approval 绑定和审批消费，再在执行层强制
`maxFixIterations` 与恢复去重，随后为 QEMU 增加受控 guest executor 和 host/guest
证据类型。完成后原样重跑本验证集，不复用本次未达到标准的结论。

本轮验证已落地两项直接相关的交付修正：detached worker 启动时显式设置 umask 0022，
并增加父进程 umask 0077 下的 job 恢复回归测试；npm 交付改为使用锁定的普通
`pi-agents` dependency，不再把本地 `node_modules` 嵌入 tarball。这两项修正通过了
下述测试，但不改变五个已经执行场景的历史判定。

## 收尾审计

最终命令结果：

- `npm test`：PASS，13/13 tests，0 failed。
- `npm run check`：PASS；再次运行 13/13 tests，并通过 `npm pack --dry-run`。
- Poky commit：仍为 `a53cae3de9f45417b97efc4c46c42e4c8ebdb939`。
- `runqemu` diff SHA-256：仍为
  `64f0e199bdc4eb08d7926afbb2211af604bc1e14642c9ed08ee07164a6c98f08`。
- `meta-local`：仍为基线列出的 6 个文件，未观察到指向该目录的 validation 写入；
  当前内容树哈希为
  `57d543aef6ad2ee8af90c166f75a0991d11ee616af852ee908790f29512eab10`。
  因验证前没有保存完整树哈希，当前哈希只作为后续基线，不声称为前后哈希证明。
- 残留进程：没有 `RUNNING/STARTING` JobRecord，没有 BitBake、runqemu 或 QEMU
  进程。
- `git ls-files`：空。仓库尚无 HEAD/索引内容，因此该命令本身不能证明提交安全；
  `git add --dry-run .` 和 `git ls-files --others --exclude-standard` 显示 72 个候选文件，
  均为预期的源码、测试、文档、知识、agent/workflow 和项目配置。
- ignore 验证：`.pi-yocto/`、`node_modules/`、`dist/`、`*.tgz`、`.pi/npm/` 和本地
  `.pi/settings.json` 均被排除。
- 敏感信息扫描：候选提交和保留的 E2E JSON/JSONL/Markdown/conf 中没有匹配
  API-key token 形态；临时 `.pi-yocto/llm-runtime/` 已逐文件删除。
- `npm pack --dry-run --json`：81 files，约 68 KB（unpacked 约 258 KB）；
  `node_modules/`、`.pi-yocto/`、本地 `.pi/`、嵌套 tarball 均为 0 项。

运行日志、TaskRecord、JobRecord、审批和构建产物保留在被 `.gitignore` 排除的
`.pi-yocto/validation/`，用于本机复核，不进入 npm 包或 Git 提交范围。
