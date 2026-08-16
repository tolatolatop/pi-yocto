# E2E 得分改进计划与落地状态

基于 `results/2026-07-29-deepseek-v4-flash.md` 的首次五场景结果，本轮优先把
关键约束放入执行层，而不是只依赖模型提示词。下表中的“已实现”表示已有代码和
回归测试；真实场景仍须使用全新 run ID 重新执行，不能回溯修改旧报告的 FAIL。

| 现象 | 根因 | 根因模块 | 改进方案 | 预期效果 | 状态 |
| --- | --- | --- | --- | --- | --- |
| job 使用不存在或不一致的 task ID，恢复时产生重复 TaskRecord | 会话没有不可歧义的任务上下文，job 启动未强制反向绑定 | `state`、Pi extension、`jobs` | Pi/session 只绑定一个真实 TaskRecord；所有 job/approval/ChangeSet 先校验 task；checkpoint 自动记录 job 和恢复命令 | G-07/G-08 可由状态记录机械验证，恢复不会换任务或重复高成本操作 | 已实现并测试 |
| 审批停在 APPROVED、命令为空或实际内容超出范围 | 审批只覆盖描述/路径，没有原子消费和完整内容绑定 | `approval`、`changes`、权限 hook | 规范化命令与完整文件集精确匹配；审批单次原子消费；ChangeSet 绑定 pre/post hash，并在应用前复核内容及 pre-image，失败回滚 | G-05 从提示约束升级为执行层约束，批准内容与实际写入一致 | 已实现并测试 |
| 同一问题启动三次以上失败构建，恢复会话又重跑相同 target | 修复上限只存在于 prompt，job 没有稳定指纹和 iteration | `jobs`、`state` | task+kind+purpose+iteration+argv+cwd 生成指纹；同指纹复用；同 iteration/target 只允许一次；最多两次；第二次无改动构建使用独立 purpose | G-08/G-10 可被拒绝而非依赖模型自律，E2E-03 的第二次增量验证仍可明确执行 | 已实现并测试 |
| E2E-02/03/04 只能证明 QEMU 到 login，不能证明 guest 行为 | worker 关闭 stdin，缺少受控串口协议与 exit-code 取证 | `worker`、`guest` | QEMU stdin pipe；受控 root login；argv-only shell quoting；唯一 begin/exit sentinel；命令队列、超时、输出 hash 和真实 exit code | 能执行 self-test、版本查询、`/proc/config.gz` 检查，补齐三个场景的硬门槛 | 已实现，fake-serial 集成测试通过 |
| host `debugfs`/`.config` 被提升为 guest 运行证明 | Evidence 没有执行域、结论类型和命令退出码 | `types`、`schemas`、`state` | Evidence 强制 `executionDomain`/`claimType`；build/guest 行为要求 command+exitCode；VerificationContract 可声明期望域且完成前必须 PASS | host/source 证据无法满足 guest requirement，防止虚假完成 | 已实现并测试 |
| patch 内容不合法仍被批准和写入 | 缺少统一 patch/metadata preflight 和审批后完整性检查 | `changes`、`review` | `.patch/.diff` 检查 Upstream-Status、`git apply --numstat/--check`；recipe 基础规范检查；应用时重新验证 hash | E2E-01 在修改前阻止坏 patch，减少无效修复 iteration | 已实现并测试 |
| PREMIRRORS 过度转义或丢失 basename | mirror 规则由模型手写，缺少确定性生成器 | `mirror` | 核对 HTTP(S) basename、本地文件 SHA-256，生成恰好一个 BitBake `\n` 分隔符及预期 file URI | E2E-05 离线 fetch 配置可复核，缺失/错文件明确失败 | 已实现并测试 |
| task 可在缺少 guest/build 证明时宣称完成 | 最终状态没有机器可检查的验收合同 | `state`、extension、agents/workflows | 规划阶段冻结 VerificationContract；Evidence 先 checkpoint 后绑定；required 全 PASS、pending 为空且 finalSummary 存在才允许 COMPLETED | 五场景的专属标准进入持久化门禁，报告结论与证据一致 | 已实现并测试 |
| 同步 metadata query 在安全凭据 shell 中被 BitBake sanity 拒绝，后台 build 却正常 | worker 规范化了 umask，`runCommand` 子进程仍继承 controller 的 `0077` | `process`、`metadata`、`doctor`、`workspace` | 给受控子进程增加原子、可选的 child umask；BitBake 环境和同步命令固定为 `0022`，spawn 后立即恢复调用者 umask | `bitbake -e/-p` 与 `bitbake-layers` 在安全 shell 和 worker 中行为一致，不再诱导模型修改 sanity 配置 | 已实现，真实 show-appends 与回归测试通过 |
| phase 错误的 job 调用落盘为 FAILED，后续合法 iteration 1 被判重复/跳号 | JobRecord 在 TaskStore reservation 前持久化，预条件拒绝被误当成真实执行 | `jobs`、`state` | reservation 失败时原子删除未启动的临时 JobRecord；不附加 task、checkpoint 或 verification attempt，并允许纠正 phase 后重试相同 iteration | 模型的一次调用顺序错误不会永久毒化验证预算，真实失败仍完整保留 | 已实现并测试 |
| QEMU 首次默认走 TAP 需要 sudo，slirp-only 又没有可控串口 | runqemu 默认模式不符合无特权受控 guest executor 的协议 | `jobs`、`worker`、agent prompt | QEMU JobRecord 缺省补齐 `nographic` 与 `slirp`，仍使用 argv 数组和进程组；prompt 明示受控串口模式 | E2E-02/03/04 每个场景只需一次无特权 QEMU 启动即可取得 guest stdout/exit code | 已实现并测试 |
| E2E-03 可在没有当前 do_rootfs 首错时把静态 review 绑定为根因并 COMPLETED | 合同没有 FAILED baseline job，root-cause/ownership/guest requirement 未限定 Evidence domain | `validation contract`、`state` | 增加当前 `validation-field-image` FAILED baseline；根因强制 build/diagnosis、ownership 强制 metadata/configuration、guest 强制 guest/execution | 旧日志或静态源码不能替代本轮 solver/metadata/guest 证据，S3-02/S3-03/S3-09 成为硬门禁 | 已实现并测试，待定向重跑 |
| E2E-05 预期 fetch 失败被历史 DL_DIR 同名链接和 sstate 命中绕过 | fixture 跨 run 使用相同 URI basename，隔离目录未隔离共享下载键 | validation controller fixture | 每个 run 使用唯一 archive basename，保持归档内容和 recipe checksum 不变，不删除或修改 shared cache | baseline 必定针对本 run 缺失对象触发 BB_NO_NETWORK do_fetch，恢复场景可重复执行 | 已实现，r8 真实 E2E 通过 |
| 通用 `mkdir` 在审批外创建目录，拒绝 stop 后可直接 `kill` QEMU | shell 策略未把目录创建和进程终止纳入专用状态协议 | `policy`、extension、`jobs` | generic mkdir/touch 等写操作直接阻断；kill/pkill/killall 只能经 `yocto_job_stop` 消费精确 JobRecord-bound approval | E2E-02 不再产生 run 外副作用；E2E-03/08 无法绕过 stop 审批 | 已实现并测试 |
| E2E-08 从 FAILED 回退并绕过受控重规划 | FAILED 允许回到多个执行阶段 | `state`、CLI、agents/workflows | FAILED 改为不可恢复终态；可恢复任务使用 PAUSED；成功 build 后的可信 FAILED semantic requirement 可进入一次 REPLANNING | 状态历史不可改写，同时 manifest/metadata/guest 语义失败仍可合法修复 | 已实现并测试 |
| required parse Job 到总结阶段才发现 | requiredJobs 只在 finalizer 检查 | `state`、extension、verifier | VERIFYING checkpoint 返回 verificationReadiness、全部缺失 Job 及合法工具参数；completion status 同步返回精确 next action | E2E-08 在构建/总结前补齐 parse，减少无效往返 | 已实现并测试 |
| PREMIRRORS 双转义、孤立分隔符或字面换行导致第二次 fetch 失败 | 模型重写生成规则且 ChangeSet 不解析 mirror pairs | `mirror`、`changes`、layer-engineer | 返回无 JSON `\\n` 歧义的 canonical multiline rule；ChangeSet 解析 pair、regex 与 file URI，拒绝双转义/分号/非 canonical source | E2E-05 的 mirror 配置在审批前确定性通过 | 已实现并测试 |
| 新 layer 首轮遗漏 BBLAYERS，固定输入放错 FILESPATH | preflight 只逐文件检查，不检查联合 metadata 图 | `changes`、review、layer-engineer/create-layer | 联合校验 changed layer 注册和每个静态 `file://` 的 planned FILESPATH resolution | E2E-02 不完整 ChangeSet 不消耗审批或 build iteration | 已实现并测试 |
| 单包优化 build 成功但最终仍有 `-O2` | 修改 CFLAGS/错误 override，未检查有效 metadata 和 compiler argv | `review`、`optimization`、verifier/optimize workflow | 静态拒绝错误变量/override/冲突 flags；专用 assertion 检查 bitbake -e、run.do_compile 和非目标 fingerprint | E2E-07 只有真实单包 `-Os` 且非目标不变才能 PASS | 已实现并测试 |
| E2E-03/06 已完成 guest 验证却反复创建错误 stop approval | 模型把底层 `action=stop_job` 误解为应先调用通用审批工具，completion status 只返回模糊提示 | `extension`、`state`、verifier/summarizer、controller | 通用审批拒绝保留动作；`yocto_job_stop` 文档明确内部发起审批；completion status 和控制器续跑提示返回精确工具与 JobRecord ID | QEMU 可通过一次正确的工具调用进入 STOPPED，不再耗尽会话/token | 已实现并测试，待定向 E2E |
| E2E-07 普通 `bitbake -e` Evidence 错误满足有效 flags 合同 | 合同只约束 domain/claimType，无法区分通用 metadata 与专用 oracle | `types`、`schemas`、`state`、E2E-07 contract | 增加 `expectedEvidenceSource`，S7 强制可信 `bitbake:optimization-assertion`，仍要求 compiler argv 与 reference fingerprint | 同时含 `-O2 -Os` 时无法再把 S7 标 PASS | 已实现并测试，待定向 E2E |
| E2E-08 build exit 0 但 manifest 语义失败后进入终态 FAILED | 缺少稳定 artifact assertion，模型把成功 build Evidence 标 FAILED；terminal checkpoint 仍保留修复步骤 | `artifact-assertion`、`state`、review、agents | 新增稳定 manifest 精确包断言和非零可信 Evidence；有 pending/replan 余量时禁止 terminal FAILED；拒绝无效 IMAGE_RRECOMMENDS 并引导 image-scope BAD_RECOMMENDATIONS | 成功构建后的包残留可在同一 TaskRecord 合法进入第二次修复，不清 sstate | 已实现并测试，待定向 E2E |
| E2E-02 recipe 放在 layer 的 BBFILES 范围外仍消耗审批/迭代 | graph preflight 只检查 BBLAYERS 与 FILESPATH，不解析 BBFILES glob | `changes`、layer-engineer | 展开 `${LAYERDIR}`，按 layer.conf 的 BBFILES glob 校验每个计划 recipe/bbappend 路径 | 错目录在写入前被拒绝，首个 build iteration 留给完整 layer/image | 已实现并测试，待定向 E2E |
| 长会话在 E2E-08 请求 14 万 output tokens 导致 provider context 400 | OpenRouter 内置模型元数据的输出预算过大，controller 未覆盖 | validation controller | OpenRouter 也使用隔离 models.json，advertise 131072 context/16384 output，促使 Pi 更早压缩 | 长流程不再因输入+最大输出超过 provider 上限而突然终止 | 已实现静态检查，待真实长会话 |

下一验收步骤是先完成 package/提交内容审计，再以新的隔离目录和 run ID 原样重跑
十个场景，记录新分数、旧/新差异及仍未通过的门槛。
