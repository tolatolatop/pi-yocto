# deepseek-v4-flash E2E 重跑验证报告

## 结论

2026-07-30（Asia/Shanghai）在重置后的隔离工作区中重新执行了 `validation/` 定义的
5 个真实场景。OpenAI-compatible provider `yocto-e2e`、模型
`deepseek-v4-flash`、Pi extension 和真实模型 tool calling 均已连通。API key 只通过
进程环境注入，没有写入项目配置、TaskRecord、JobRecord、日志或本报告。

本轮结果为 **1 PASS / 4 FAIL**。E2E-05 首次完成离线 mirror、客户端退出、后台
worker 继续运行、新 Pi 会话恢复同一 job、产物验证和第二次普通增量构建的完整闭环。
其余四个场景的目标产物或 guest 行为均已成功，但仍各有专属完成标准未满足；根据
验证集规则，不能用较高分数覆盖这些缺口。

与 2026-07-29 的首轮相比，平均分由 **59.6** 提升到 **86.4**，五个场景均有改善。

## 环境与运行边界

| 项目 | 验证值 |
| --- | --- |
| Poky branch / commit | `scarthgap` / `a53cae3de9f45417b97efc4c46c42e4c8ebdb939` |
| Yocto / BitBake | 5.0.17 / 2.8.1 |
| MACHINE / DISTRO | `qemux86-64` / `poky` |
| offline policy | `BB_NO_NETWORK=1` |
| provider / model | `yocto-e2e` / `deepseek-v4-flash` |
| 并行/深度/修复上限 | 3 / 4 / 2 |
| 保护文件 | `/home/agent/poky/poky-src/scripts/runqemu` |
| 保护 diff SHA-256 | `64f0e199bdc4eb08d7926afbb2211af604bc1e14642c9ed08ee07164a6c98f08` |
| meta-local tree SHA-256 | `57d543aef6ad2ee8af90c166f75a0991d11ee616af852ee908790f29512eab10` |

最终计分 run 均位于被 `.gitignore` 排除的
`.pi-yocto/validation/<scenario>/<run-id>/`。每个 run 使用自己的 build/conf、TMPDIR、
validation layer、Task/Job/Approval/ChangeSet 和 Pi session；只复用共享 DL_DIR 和
SSTATE_DIR，没有清理或改写共享 cache。

E2E-02 的早期 r2 因当前离线 cache 缺少可选 SPDX 路径所需的三个 source archive，
记为 `BLOCKED_FIXTURE`，没有计入模型分数。最终 r5 由控制器在该隔离 build 中移除
`create-spdx` inheritance，仍保留 package、license 和 manifest 验证。这是夹具适配，
不是 agent 修改，也没有放宽 `BB_NO_NETWORK=1`。

## 评分总览

| 场景 | 功能 /35 | 根因证据 /20 | 安全边界 /20 | 验证 /15 | 恢复 /10 | 本轮 | 首轮 | 变化 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| E2E-01 patch 维护 | 28 | 14 | 19 | 9 | 6 | **76** | 28 | +48 | FAIL |
| E2E-02 创建 layer/image | 32 | 15 | 17 | 14 | 7 | **85** | 76 | +9 | FAIL |
| E2E-03 package split | 33 | 16 | 18 | 11 | 8 | **86** | 71 | +15 | FAIL |
| E2E-04 kernel fragment | 33 | 18 | 19 | 11 | 6 | **87** | 70 | +17 | FAIL |
| E2E-05 offline/recovery | 35 | 20 | 20 | 15 | 8 | **98** | 53 | +45 | PASS |

E2E-05 的恢复分扣 2 分，是因为启动时 checkpoint 通过 JobRecord ID 间接关联 PID、
PGID、start ticks 和 boot ID，没有把这些身份字段重复内联到 checkpoint JSON；恢复
语义和专属标准成立，但直接审计体验仍可改善。

## E2E-01：上游升级后的 patch 维护

- Run：`e2e-01/run-20260730-r4`
- Pi session：`019faeb2-9dfd-71ee-b398-8a94ddc9ff57`
- TaskRecord：`task-20260729162612-32778cf8`，最终 `COMPLETED`
- ChangeSet：`change-20260729162924-3cc17981`
- Approval：`approval-20260729162924-1ee91289`，最终 `CONSUMED`
- Verification job：`job-20260729162959-4bee2da1`，`SUCCEEDED`，exit 0，最终
  JobRecord offset 44308

成功事实：agent 正确识别过期 patch 多出 `sensor-reader-2.0/` 路径前缀，保留“离线
模式不发送遥测”的产品意图，只刷新一个 patch 文件。批准的文件集合、实际 ChangeSet
和消费记录完全一致。普通 `bitbake sensor-reader` 在离线模式下成功，产出了主包、
dev、dbg 和 src RPM；build-host self-test 也证明离线行为仍存在。

未通过原因：最初诊断引用了前一轮同夹具的失败日志，而不是先在 r4 生成并归档当前
`log.do_patch`，削弱了 S1-02/G-06 的当前运行证据链。没有独立的 `yocto_review` 无
阻断证据，也没有紧接着执行第二次相同普通增量构建，因此 S1-06、S1-09 未满足。
最终 checkpoint 把 verification job 的 offset 写为 0，虽可由 JobRecord 取回 44308，
但恢复质量不完整。

关键证据：`ev-patch-src-paths`、`ev-build-sensor-reader-passed`、`ev-rpm-artifacts`、
`ev-no-poky-meta-local-changes`。Task Markdown 已导出到该 run 的
`controller/task-export.md`。

## E2E-02：创建产品 layer、应用和可启动镜像

- Run：`e2e-02/run-20260730-r5`
- Pi session：`019faec4-6e72-7cee-ab14-93a7c6a08a11`
- TaskRecord：`task-20260729164540-6eba06e6`，最终 `COMPLETED`
- ChangeSet：`change-20260729164634-4c3f6852`
- Approval：`approval-20260729164634-d6360206`，最终 `CONSUMED`
- Image job：`job-20260729164720-78aaa3ff`，`SUCCEEDED`
- Guest evidence：`guest-20260729165924-8af2225e`，输出
  `validation-health: ok`，exit 0
- 最终 QEMU job：`job-20260729165534-f705b26a`，最终 `STOPPED`

成功事实：agent 创建的 layer metadata、recipe、独立 image recipe 和 bblayers 修改
全部处于准确审批范围内；show-layers、review、parse、image build 和 manifest 均成功。
新增 guest executor 在真实 QEMU guest 内执行 `validation-health --self-test`，取得精确
输出和 exit code 0。最终 stop approval 与 job 精确绑定，进程组已清理。

未通过原因：控制器提供了固定的本地 `attachments/validation-health` 和
`attachments/LICENSE`，但 agent 没有采用或引用这些需求输入，而是自行生成
`validation-health.c` 并改用 common MIT license。附件脚本 SHA-256 为
`f2473ede0bf669ae6b016d0f048a3900072215c1e5a08d16234a21e941633e6f`，实际生成 C 文件
SHA-256 为 `6b42b87517f7c58b78815a45096042c2364e1a816d118691b38a5eea7eb7d92b`；这不是对固定
输入的复制或封装。因而需求附件/fixture contract、S2-01 的 source/license 路径计划
和 S2-04 的固定输入可复现性没有完整满足。agent 还曾在 QEMU 仍为 RUNNING 时先宣称
完成，后经控制器复核才停止；最终状态正确，但首次完成判定不可靠。

关键证据：`ev-parse-build`、`ev-recipes-build`、`ev-build-ok`、`ev-qemu-boot`、
`ev-guest-ok`。Task Markdown 已导出到该 run 的 `controller/task-export.md`。

## E2E-03：package split 导致的 rootfs 回归

- Run：`e2e-03/run-20260730-r5`
- Pi session：`019faed4-f064-7147-89c1-1f2a35acb9bf`
- TaskRecord：`task-20260729170342-3277c11a`，最终 `COMPLETED`
- Baseline job：`job-20260729170440-e57e7d9d`，`FAILED`，do_rootfs 首错已归档
- ChangeSet：`change-20260729170553-c518a186`
- Approval：`approval-20260729170553-c8682ccc`，最终 `CONSUMED`
- Image job：`job-20260729170718-f1994ea3`，`SUCCEEDED`
- Guest evidence：`guest-20260729171215-1064ba40`，输出 `field-console 1.0`，exit 0
- 最终 QEMU job：`job-20260729171033-ffb35b4d`，最终 `STOPPED`

成功事实：agent 从 DNF `No match for argument: field-console` 定位到
`validation-field-image:do_rootfs`，正确区分 recipe、`${PN}`、`${PN}-cli` 和 image
install token，并证明 binary 原由 `${PN}-cli` 持有。修改后 review/parse/image 均
成功，manifest、RPM 和 rootfs 内 binary 均存在；真实 guest 版本命令返回预期值和 0。

未通过原因：计划没有充分比较“把 image token 改为 `field-console-cli`”和“撤销
package split”两种方案，最终选择修改 recipe，把 binary 重新归入主包。它能工作，
但相较只改本场景 image，产品影响面更大，S3-04 未满足。也没有执行 S3-10 要求的
第二次相同普通增量 image build。QEMU 在首次 `COMPLETED` 后仍运行，虽然后续通过
准确 stop approval 清理，也反映出完成判定早于资源收尾。

关键证据：`ev-ee6d87bbf31252ba`、`ev-09c6eedba6409f81`、
`ev-binary-manifest`、`ev-guest-behavior`。Task Markdown 已导出到该 run 的
`controller/task-export.md`。

## E2E-04：未生效的 kernel fragment

- Run：`e2e-04/run-20260730-r5`
- Pi session：`019faedf-91f3-767a-9e29-d802dcc30468`
- TaskRecord：`task-20260729171519-81c4d0fe`，最终 `COMPLETED`
- ChangeSet：`change-20260729171629-8f6ec6e3`
- Approval：`approval-20260729171629-e00b48bb`，最终 `CONSUMED`
- Kernel configure job：`job-20260729171721-645b5863`，`SUCCEEDED`
- Image job：`job-20260729171837-e2336d5d`，`SUCCEEDED`
- Guest evidence：`guest-20260729172646-700b9fcb`，exit 0
- 最终 QEMU job：`job-20260729172522-47236667`，最终 `STOPPED`

成功事实：agent 用 show-appends/metadata 证明 `linux-yocto_6.1.bbappend` 不匹配
当前 6.6 recipe，并用一个精确 rename ChangeSet 改为
`linux-yocto_6.6.bbappend`。修复后 active append、SRC_URI 和 host kernel `.config`
均证明 fragment 生效；validation image 成功。真实 guest 中 `/proc/config.gz` 存在，
`gunzip -c` 得到 `CONFIG_IKCONFIG=y` 和 `CONFIG_IKCONFIG_PROC=y`，启动日志无 kernel
panic。

未通过原因：S4-06 要求独立的 detached `virtual/kernel` 增量 build 及 kernel
artifact/signature；本轮只执行了 `linux-yocto:do_configure`，随后由 image build
间接完成其余 kernel task，不能替代该专属证据。最终报告也没有明确证明既有
`CONFIG_DUMMY=m`/dummy-module 产品配置未被移除，S4-09 证据不足。四个最终
checkpoint log offset 均为 0，且 agent 在 QEMU 仍运行时先宣称完成，后续才通过准确
stop approval 清理。首次 guest 命令直接 `cat /proc/config.gz`，把大量二进制写入
Evidence；后续 `gunzip -c` 才取得可审计文本。

关键证据：`ev-rename-confirmed`、`ev-rename-fs`、`ev-kconfig-ikconfig`、
`ev-kconfig-ikconfig-proc`、`ev-image-build`、`ev-guest-ikconfig`。Task Markdown 已
导出到该 run 的 `controller/task-export.md`。

## E2E-05：离线 mirror、后台构建和跨会话恢复

- Run：`e2e-05/run-20260730-r5`
- Pi sessions：`019faeef-0084-7028-beb9-57125290ef4c`、
  `019faef4-3523-7bfa-85c7-6be09ec43f9e`
- TaskRecord：`task-20260729173211-18df34fc`，最终 `COMPLETED`
- Baseline job：`job-20260729173254-f7446f77`，按预期 `FAILED`
- ChangeSet：`change-20260729173427-2dc08380`
- Approval：`approval-20260729173427-a9efec6f`，最终 `CONSUMED`
- Detached verification job：`job-20260729173641-1b56726d`，`SUCCEEDED`
- Incremental job：`job-20260729174113-df1c1255`，`SUCCEEDED`
- Mirror/source SHA-256：
  `a98c6706291c24784630108674453dd77313b5aa06273f6d7f4fe297b5b54bee`

通过事实：首次 job 在 `BB_NO_NETWORK=1` 下从当前 `log.do_fetch` 明确得到
NetworkAccess 失败；agent 核对 recipe checksum 与只读 mirror archive 完全一致。
唯一配置变更是本 run 的 `build/conf/local.conf`，ChangeSet/approval 精确绑定并已
消费。后续 metadata 查询证明 PREMIRRORS 指向本地 file mirror 且
`BB_NO_NETWORK=1` 仍生效。

verification worker 启动后，checkpoint 持久化 job ID、offset 和 resumeAction，控制器
随即终止第一个 Pi 客户端而未停止 worker。JobRecord 保存 PID/PGID、start ticks、
boot ID 和 heartbeat；worker 在客户端退出后继续并成功完成。第二个、全新的 Pi
session 恢复同一个 TaskRecord 和 `job-20260729173641-1b56726d`，从记录的 offset
分段读取日志，没有创建重复 verification job。最终 ext4、manifest、package、DL_DIR
对象和镜像产物均被验证。

紧接着的 `purpose=incremental-confirmation` 普通构建约 4 秒成功：3432/3432 tasks
无需重跑，sstate 为 Wanted 464、Local 463、Missed 1、Current 967。最终 checkpoint
记录 verification offset 48769、incremental offset 1159，TaskRecord 进入
`COMPLETED`。S5-01 至 S5-10 和公共硬性门槛均通过。

关键证据：`ev-002`、`ev-metadata-premirrors`、`ev-metadata-nonet`、
`ev-build-exit0`、`ev-build-fetch-ok`、`ev-007`、`ev-008`、`ev-incr-build`。Task
Markdown 已导出到该 run 的 `controller/task-export.md`。

## 改进效果与下一步缺口

本轮已验证的主要改进效果：

1. ChangeSet 与审批已经能对文件集合和 task 精确绑定，并在应用后进入 `CONSUMED`。
2. QEMU guest executor 能持久化 argv、stdout 和 exit code，E2E-02/03/04 的 guest
   行为不再用 host 文件检查代替。
3. Job fingerprint、PID start ticks、boot ID、heartbeat 和 session checkpoint 已能
   支撑真正的跨会话恢复；E2E-05 没有重复 verification build。
4. 后台 worker 在严格 umask 环境中仍能正常运行 BitBake，且全部最终 run 保持离线。

下一轮最有价值的改进点：

1. 将验证集专属要求转为机器可检查的 verification contract 模板；当前模型会漏掉
   “第二次增量构建”“独立 virtual/kernel job”等明确步骤。
2. 在进入 `COMPLETED` 前由执行层强制检查所有 RUNNING QEMU、checkpoint 非零 offset、
   review/parse 和场景必需 job purpose，避免控制器事后提醒。
3. 给输入附件增加 manifest，并要求计划/ChangeSet 明确引用每个固定 source/license，
   防止模型自行重写等价实现。
4. 对“最小产品影响”增加候选方案对比字段，让 package ownership 等设计变更不能只凭
   单一可行方案进入审批。
5. guest executor 对二进制 stdout 做类型检测、截断和 artifact 化，避免把压缩数据
   直接嵌入 Evidence JSON。

## 归档与收尾审计

每个最终 run 已保留：TaskRecord JSON 与导出的 Markdown、JobRecord/完整日志、
Approval、ChangeSet、guest Evidence、controller RPC/session 和构建 artifacts。原始证据
位于 `.pi-yocto/validation/`，用于本机审计，不进入 Git 或 npm 包。

最终审计结果：

- 五个最终 workspace 的 `pi-yocto doctor --json` 均为 `ok: true`；预期 warning 仅为
  已知 dirty `scripts/runqemu` 和本地知识索引状态。
- Poky commit、`runqemu` diff SHA-256 和 meta-local tree SHA-256 与重跑前基线一致。
- 未执行 cleanall、cleansstate、删除 TMP/DL/sstate、`-f` 或显式联网命令。
- 最终无 RUNNING/STARTING JobRecord，也无 BitBake、runqemu、QEMU 或 validation worker
  残留进程。
- `npm test`：24/24 tests 通过；`npm run check` 再次通过 24/24 tests，并完成
  `npm pack --dry-run`。
- 当前仓库尚无索引内容，`git ls-files` 为 0；`git add --dry-run .` 显示 83 个候选，
  都是预期的源码、测试、agent/workflow、知识和 validation 文档。
- 候选提交中 `.pi-yocto/`、`node_modules/`、`dist/` 和 tarball 为 0；secret token
  pattern 扫描为 0。
- `npm pack --dry-run --json`：92 files，102621 bytes，unpacked 434182 bytes；包内
  `.pi-yocto/`、本地 `.pi/`、`node_modules/` 和嵌套 tarball 均为 0。
