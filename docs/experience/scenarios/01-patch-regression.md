# Patch 升级回归

适用：源码版本升级后 `do_patch` 失败，但 patch 承载的产品行为仍必须保留。

## 典型症状

- recipe 已切到批准的新版本；
- `do_fetch/unpack` 成功，`do_patch` 报路径或 hunk 不匹配；
- 最终 BitBake summary 只显示 recipe 失败；
- 删除 patch 或回退版本能构建，但违反产品要求。

## 证据链

1. 保存当前 `log.do_patch`，指出失败 patch、hunk 和目标路径；
2. 确认实际 `SRC_URI`、patch 顺序及 `striplevel/patchdir`；
3. 对照当前展开源码，定位 patch 原始行为对应的新位置；
4. 证明产品行为仍需要，不能以删除 patch 解决；
5. 判断是 patch 内容过期，还是 URI 的应用参数错误。

不要预设一定要“刷新 patch”。2026-07-30 的 E2E-01 最终证据表明源码行为未变，实际
根因是 patch URI 缺少正确的 `striplevel=2`，因此唯一修改是 recipe 中的应用参数，
patch 本体未变。诊断应服从当前日志，而不是服从场景标题。

## 决策

| 证据 | 最小修复 |
| --- | --- |
| patch 内容仍匹配，路径剥离错误 | 修正 `striplevel/patchdir` |
| 文件移动或上下文小变，行为仍需 | 针对当前源码刷新最小 hunk |
| 上游已等价实现产品行为 | 提供行为等价证据后重新评审是否移除 |
| 版本或源码对象错误 | 修正已批准版本的输入问题，不回退掩盖 |

## 实施要点

- 只修改 scenario/product layer 中的 patch 或必要 recipe；
- patch 保留可审查说明和合适 `Upstream-Status`；
- 申请审批前执行 patch 语法、numstat 和 applicability preflight；
- 不编辑 Poky checkout 中的展开源码或 TMPDIR；
- 不使用 `PATCHRESOLVE=user`、`-f`、clean 或网络取新 patch。

```text
failure = analyze(do_patch_log)
source = inspect(unpacked_current_revision)

if failure.caused_by_path_strip:
  change(recipe_patch_parameter)
else:
  refreshed = replay_original_intent_on(source)
  require(minimal_diff(refreshed))
  change(patch)
```

## 验证闭环

1. review 和全局 parse；
2. detached `bitbake <recipe>`；
3. 检查 package/RPM 等目标产物；
4. 执行能够区分“patch 保留”和“patch 被删除”的行为测试；
5. 再次普通构建，证明已完成 task 不需重跑或正确复用 sstate；
6. 归档失败/成功 job、审批、diff、源码位置和行为输出。

## 反模式

- 只引用 summary，不看 `log.do_patch`；
- 删除 `SRC_URI` patch 条目；
- 回退 PV/SRCREV；
- 手改 workdir 源码让本次构建通过；
- patch 不可应用仍先批准写入；
- 只验证编译，不验证 patch 所保护的行为。

来源：E2E-01 和 2026-07-29、07-30 最终验证报告。

