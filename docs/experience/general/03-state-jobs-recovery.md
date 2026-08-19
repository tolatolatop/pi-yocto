# 任务状态、后台作业与恢复

## 核心经验

长构建的可靠性来自持久化身份和幂等恢复，不来自保持一个终端会话。pi-yocto 的 worker
是 detached 进程组 leader，JobRecord 保存 PID/PGID、process start ticks、boot ID、
heartbeat、log offset 和最终状态。

早期验证出现过错误 task ID、恢复时重复建 TaskRecord、同 target 重复构建、phase
错误占用 iteration 等问题。当前实现用单 session 绑定、job fingerprint、reservation
和两轮修复上限约束这些行为。

## 状态语义

- `INSPECTING`：只读建立基线，可执行合同要求的 baseline job；
- `PLANNING`：冻结验证合同和准确变更计划；
- `WAITING_HUMAN`：等待内容绑定审批；
- `EXECUTING`：应用已批准变更；
- `VERIFYING`：按成本从低到高执行验证；
- `REPLANNING`：由当前失败 job 或可信语义失败 Evidence 进入；
- `SUMMARIZING`：汇总所有门禁；
- `PAUSED`：仍可恢复，必须给出 resume action；
- `FAILED`：不可恢复终态；
- `COMPLETED`：所有合同和 completion policy 原子闭合。

不要用普通 checkpoint 强行把 phase 倒退。build exit 0 但 manifest/guest 断言失败时，
它是可修复的语义失败，应绑定可信非零 Evidence 后进入 `REPLANNING`。

## 作业去重

作业指纹由 task、kind、purpose、iteration、argv、cwd 和必要的 source job 等构成。
相同恢复请求应返回既有 JobRecord，不应启动第二个进程。

```text
fingerprint = hash(task, kind, purpose, iteration, argv, cwd, source_job)

if existing_job(fingerprint):
  return existing_job
if phase_or_iteration_invalid:
  reject_without_persisting_failed_job
reserve_iteration()
persist_job()
start_detached_worker()
```

## Checkpoint 最小内容

- TaskRecord ID 与当前 phase；
- JobRecord ID、target、purpose、iteration；
- PID/PGID、start ticks、boot ID、heartbeat；
- 已读取 log offset；
- 已完成证据和剩余合同项；
- 下一会话的 status/tail/resume 动作；
- 若有 QEMU，准确停止动作。

## 恢复流程

```text
task = open_existing_task()
job = status(saved_job_id)

if same_boot_and_start_ticks(job) and job.running:
  tail(from=saved_offset)
elif job.succeeded:
  collect_bound_artifacts()
elif identity_stale_or_rebooted:
  mark_interrupted_and_replan()
else:
  analyze_current_failure()

never start_same_fingerprint_again()
```

不能只用 PID 判断进程仍是原 job：PID 会复用，系统也会重启。身份不匹配应标记
`INTERRUPTED`，系统不会自动重启高成本构建。

## 验证顺序

通常按 review → parse → narrow package/kernel → image → artifact assertion → QEMU →
ordinary incremental confirmation 执行。只有第一次验证成功后，才把相同构建作为
`incremental-confirmation`；诊断复现使用独立 purpose，不消耗修复 iteration。

## 反模式

- Pi 客户端退出时顺带终止 worker；
- 恢复时新建 task 或重复启动 target；
- 固定 sleep，而不基于 status/heartbeat/log offset；
- phase 调用错误后落一个假的 FAILED job；
- 达到修复上限仍继续 build；
- 有恢复动作却写 terminal `FAILED`，或 FAILED 后强行回退；
- QEMU 仍运行就宣称完成。

对应来源：E2E-05、E2E-08，`src/state.ts`、`src/jobs.ts` 和 jobs/invariants/state 测试。

