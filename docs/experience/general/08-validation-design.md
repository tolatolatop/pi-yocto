# 验证场景和夹具设计

## 核心经验

好的 E2E 不是固定脚本演示，而是隔离的任务、受控缺陷、评估者 oracle 和机器可检查
证据的组合。夹具若被历史 cache、环境漂移或提示泄漏影响，结果不能归因于 agent。

## 场景结构

每个场景至少定义：

- 给 agent 的任务文本；
- 控制器夹具和隐藏 oracle；
- 当前环境基线及受保护内容；
- 专属完成标准；
- 公共硬门槛；
- 直接失败条件；
- 必须归档的证据。

控制器只把任务文本交给 agent，不应泄漏预设根因。评估使用实际日志、metadata、产物
和 guest 行为，不能接受 agent 自报 PASS。

## 隔离原则

- 每次 run 使用独立 build/conf、TMPDIR、validation layer 和 runtime state；
- 可只读复用 downloads/sstate，但不得删除、重命名或污染共享 cache；
- scenario layer 从第一笔写入前就登记为受保护 workspace layer；
- 原始 Poky、meta-local、build/conf 保持只读；
- 导出 Task/Job/approval/Evidence 后，只清理准确 run-id 范围。

## 防止夹具污染

E2E-05 曾因共享 DL_DIR 中历史同 basename 链接而未出现预期 fetch 失败。修复方式是为
每 run 生成唯一 basename，保持内容和 checksum 不变，而不是清 cache。

```text
run_id = unique_id()
uri_basename = "fixture-" + run_id + ".tar.xz"
assert dl_dir_has_no_object(uri_basename)
prepare_same_content_under(uri_basename)
```

环境基线漂移应标 `BLOCKED_ENVIRONMENT`，fixture 本身不可用标 `BLOCKED_FIXTURE`，
provider 不可用标 `BLOCKED_PROVIDER`。这些都不能算 PASS 或 agent FAIL。

## 评分与硬门槛

功能结果、根因证据、安全边界、验证充分性和恢复性可以评分，但安全、离线、审批、
当前证据和修复上限等硬门槛不能用高功能分抵消。2026-07-31 Qwen 全量验证中，部分
任务机器合同完成，却因直接终止 QEMU 等安全违规被正式判 FAIL。

## 历史报告的使用方式

- 保留原失败结论，不回溯改写为 PASS；
- 修复 harness/fixture 后使用全新 run 定向复测；
- 报告区分产品缺陷、模型行为、控制器缺陷和环境问题；
- 记录 provider/model、时间、run/task/job/approval、diff、artifact 和未解决事项；
- 不把一个模型的一次 PASS 泛化成项目在所有环境下必然成功。

## 反模式

- 将 oracle 或根因直接写进任务提示；
- 多个 run 共用可变 TMPDIR；
- 用清共享 cache 保证 baseline；
- 只检查最终文件，不审计执行过程；
- agent 自述替代 transcript/job/artifact oracle；
- 修复控制器后复用旧 run 改分；
- provider/context 错误算成产品逻辑失败。

对应来源：`validation/README.md`、各 results 报告、E2E-11/12 的 verifier 设计。

