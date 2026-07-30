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

下一验收步骤是先完成 package/提交内容审计，再以新的隔离目录和 run ID 原样重跑
五个场景，记录新分数、旧/新差异及仍未通过的门槛。
