# 单 recipe 编译优化

适用：只改变一个 recipe 的优化等级，并证明其他 recipe 和全局 tune 不变。

## 为什么 build 成功不够

编译器通常接受同时出现的 `-O2 -Os`，最后一个参数可能获胜；因此 build exit 0、
recipe 中出现 `-Os`、甚至程序输出正确，都不足以证明 metadata 无冲突和影响范围正确。

E2E-07 的合同后来要求专用 optimization assertion，检查最终 CFLAGS、展开后的实际
compiler argv，以及一个非目标 recipe 的 metadata fingerprint。

## Baseline

在修改前记录：

- 目标 recipe 的最终优化 flags 和赋值历史；
- `run.do_compile` 中展开的 compiler argv；
- baseline package/guest 行为，例如 `optimization=speed`；
- 一个非目标 reference recipe 的 fingerprint；
- MACHINE、DISTRO、target 和 build settings。

Baseline job 可在 INSPECTING/PLANNING 中执行，不能把实现前基线误当 fix iteration。

## 方案选择

| 方案 | 影响范围 | 结论 |
| --- | --- | --- |
| 目标 recipe 的 bbappend | 单 recipe | 优先 |
| 修改原 recipe | 上游/共享内容 | 通常越界 |
| local.conf / distro / tune flags | 全局 | 禁止用于单包需求 |

局部修改应先移除继承的冲突 `-O` flag，再追加目标 flag。不要简单追加 `-Os` 后保留
`-O2`，也不要用运行时脚本伪造 mode。

```text
baseline_ref = optimization_assert(target, reference_target)
apply(recipe_scoped_bbappend(remove_inherited_O, append="-Os"))
build(target)
result = optimization_assert(
  target,
  expected_flag="-Os",
  expected_reference_fingerprint=baseline_ref
)
require(result.no_conflicting_O_flags)
require(result.compile_argv_matches)
```

## 验证闭环

1. review 拒绝错误变量、override 和冲突 flags；
2. parse、目标 package 和 image build；
3. 专用断言验证最终 metadata、compiler argv、非目标 fingerprint；
4. guest 执行 mode 命令，输出 `optimization=size` 且 exit 0；
5. ordinary incremental confirmation，不使用 clean/force。

2026-07-31 修复后 E2E-07 的唯一变更是目标 bbappend，目标为 `-Os`、非目标仍为
`-O2`，guest 正确，第二次 image build 3432/3432 task 不需重跑。

## 反模式

- 修改 FULL_OPTIMIZATION、TARGET_CFLAGS、tune 或 local.conf；
- 同时保留多个冲突 `-O` 等级；
- 只用通用 `bitbake -e` Evidence 满足专用合同；
- 不查看实际 compile argv；
- clean 或 `-f` 强迫目标重编译；
- 不比较非目标 recipe。

来源：E2E-07、`src/optimization.ts`、metadata/optimization 相关测试。

