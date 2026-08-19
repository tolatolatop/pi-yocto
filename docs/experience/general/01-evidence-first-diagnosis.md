# 证据优先的诊断

## 核心经验

先定位首个失败任务，再判断最终 metadata 和产物语义。BitBake 最后的 summary 常是
级联结果，不足以证明根因；文本搜索只能找到候选赋值，也不足以证明最终值。

历史 E2E 中，错误证据绑定曾让静态 review 冒充当前 `do_rootfs` 根因。修复后的合同
要求 baseline 失败、metadata ownership 和 guest 行为分别使用对应执行域的证据。

## 诊断顺序

1. 固化 workspace：Poky commit、dirty/untracked、MACHINE、DISTRO、layers、cache、
   offline 状态。
2. 保存当前失败 job 和 `log.do_*`，定位第一个 actionable error。
3. 按失败阶段选择证据，而不是先改文件。
4. 用 `bitbake -e <target>` 查看最终值和赋值历史。
5. 用 `bitbake-layers show-appends/show-layers` 证明 layer/append 是否激活。
6. 用 pkgdata、manifest、sigdata 或 guest 行为补齐 metadata 之外的结论。
7. 明确事实、推断和未解决风险，再提出最小修改。

## 按阶段路由

| 阶段 | 首要证据 | 常见误判 |
| --- | --- | --- |
| parse/expand | 报错文件、变量展开链 | 把语法后的级联错误当成多处故障 |
| fetch | URI、checksum、DL_DIR 对象、offline 日志 | 认为重试或联网能“诊断” |
| patch | `log.do_patch`、失败 hunk、当前源码 | 只看最终 summary |
| configure/compile | 对应 task log、展开后的命令 | 只看 recipe 中写了什么 flags |
| package/rootfs | solver、PACKAGES/FILES/RDEPENDS、pkgdata | 混淆 recipe 名与 output package |
| image/artifact | 稳定 manifest、deploy 绑定关系 | build exit 0 等同于产品语义通过 |
| QEMU/guest | 受控命令 stdout/stderr/exit code | host rootfs 检查冒充运行行为 |

## 伪代码

```text
snapshot = inspect_workspace()
job = reproduce_or_select_current_failure()
first_error = analyze_first_actionable_error(job.log)

switch first_error.task:
  case fetch:    inspect(uri, checksum, dl_dir, offline)
  case patch:    inspect(patch_hunk, source_revision, patch_order)
  case rootfs:   inspect(solver, package_ownership, dependency_source)
  case compile:  inspect(effective_metadata, expanded_compile_argv)
  default:       inspect(task_log, effective_metadata)

root_cause = claim_only_with_current_run_evidence()
plan = choose_smallest_scope(root_cause)
```

## 判断证据是否够用

- 能否指出当前 run、当前 target、当前 task？
- 能否从日志 offset、文件路径或 Evidence ID 复核？
- 证据执行域是否与结论一致？
- 变量是“存在于 datastore”还是“进入了有效值/签名依赖”？
- 产物是否绑定到这次成功 JobRecord，而不是旧 deploy 文件？
- 负向结论是否有结构化 absence assertion，而不是“没有看到”？

## 反模式

- 一看到错误类型就套用通用修复；
- 仅 `rg` 到变量赋值便断言它生效；
- 只保留 BitBake summary，不保留首错 task log；
- 用成功编译证明 package 已进入镜像；
- 用 host `.config` 或解包 rootfs 证明 guest 行为；
- 为了“排除缓存问题”先 clean、force 或删 TMPDIR。

## 对应项目能力

优先使用 workspace inspection、log analysis、metadata query、review、artifact assertion
和 guest assertion。它们会产生持久化 Evidence；不要把工具输出手工改写成另一种
claim type。相关来源见 `knowledge/scarthgap/diagnosis.md`、E2E-01、03、04、07 和 11。

