# 验证合同与证据类型

## 核心经验

“做完了”必须由实施前冻结的验收条件定义，而不是由最终叙述决定。历史验证中曾出现
功能已经实现但合同未更新而判 FAIL，也出现普通 `bitbake -e` 被误当成专用优化断言。
当前实现同时校验 requirement、Evidence 类型、来源和 completion policy。

## 合同应包含什么

- required Evidence：每项需求的可观察结论；
- expected execution domain：host、guest、build、metadata、source、documentation；
- expected claim type：observation、diagnosis、configuration、build、artifact、execution、
  behavior；
- 必要时限定 `expectedEvidenceSource`；
- required jobs：kind、purpose、target、最小数量和允许状态；
- 固定输入 SHA-256 清单；
- review、决策分析、跨会话次数、无活动 job、QEMU cleanup 等门禁。

控制器提供的合同是上限约束，agent 不能用更弱的自定义合同覆盖。

## 证据域必须匹配结论

| 结论 | 合适证据 | 不足证据 |
| --- | --- | --- |
| rootfs solver 根因 | 当前 FAILED build 日志 | 静态 review |
| 最终变量值 | metadata query 及历史 | 文本搜索 |
| 包在镜像中/不在 | 成功 image job 的稳定 manifest assertion | recipe 可解析 |
| 优化 flags 生效 | 专用 optimization assertion + compile argv | 普通 `bitbake -e` 摘要 |
| guest 功能正常 | guest stdout/exit code | host rootfs 文件存在 |
| kernel 配置运行时生效 | guest `/proc/config.gz` | host `.config` |

Evidence 应由 harness 工具原子登记。工具返回 ID 后直接绑定；不要复制输出再伪造新的
来源、执行域或 claim type。

## 完成判定伪代码

```text
status = completion_status(task)

require all(required_input_hashes_match)
require review_passed
require decision_analysis_if_requested
require all(required_jobs_satisfied)
require all(required_requirements == PASSED)
require no_active_jobs
require all_qemu_stopped
require job_identity_and_offsets_complete
require final_summary_has_facts_assumptions_risks

if every_gate_passes:
  finalize_atomically(COMPLETED)
elif legal_recovery_exists:
  checkpoint(PAUSED or REPLANNING)
else:
  checkpoint(FAILED)
```

## 语义失败不等于进程失败

image build exit 0，但 forbidden package 仍在 manifest，是语义失败。应由 artifact
assertion 产生可信非零 Evidence，将对应 requirement 标为 FAILED，再在没有活动 job、
仍有修复次数时受控重规划。不要伪造 BitBake 失败，也不要清 sstate。

## Required job 容易遗漏

E2E-07/08 曾在总结阶段才发现 parse 未执行。进入 VERIFYING 时应读取 readiness 清单，
逐项执行建议的合法调用；总结前再次检查 completion status，而不是凭记忆核对。

## 最终总结模板

```text
事实：路径/Evidence ID/job ID/exit code 支持的结论
假设：仍依赖的环境或解释前提；没有则明确写“无”
风险：尚未关闭、无法在当前 scope 验证的事项；没有则明确写“无”
```

## 反模式

- 实施后才设计验收条件；
- 用 prose 声称 PASS，但 ledger 仍 PENDING；
- 把 host/source evidence 提升为 guest behavior；
- 绑定另一个 workspace 或旧 run 的 Evidence；
- build exit 0 就把所有需求标 PASSED；
- 为了完成而跳过 required parse/review/cleanup；
- 有 active QEMU 或缺 final offset 时 finalize。

对应来源：E2E-03、07、08，2026-07-30/31 修复报告，`src/state.ts` 和 contracts 测试。

