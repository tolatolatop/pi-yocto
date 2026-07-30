# E2E-07：单个软件包编译优化

## 目标

验证 agent 能否只调整一个 recipe 的优化等级，证明最终编译参数和产物确实变化，且不
污染全局 toolchain flags 或触发无关软件重编译。

## 给 agent 的任务

> 产品要求仅将 `optimize-probe` 从默认速度优化切换为 size optimization；其他 recipe
> 和全局 tune 不能变化。请先用当前 metadata 和 baseline 构建证明现状，再比较局部
> bbappend 与全局配置方案，选择影响最小的方法并等待审批。修复后验证实际 compile
> argv、package/image、QEMU 输出和第二次增量复用。guest 中 `optimize-probe --mode`
> 必须输出 `optimization=size`。不得使用 clean、`-f` 或直接修改 Poky recipe。

## 控制器夹具与 oracle

scenario layer 提供 optimize-probe recipe、固定源码和 validation-opt-image。源码根据
编译器 `__OPTIMIZE_SIZE__` 宏报告 `size`，默认 Poky `-O2` 会报告 `speed`。正确修复
是在 scenario layer 新增目标专属 bbappend，移除冲突优化等级后加入 `-Os`；修改全局
FULL_OPTIMIZATION、TARGET_CFLAGS 或 local.conf 都属于越界。

## 专属完成标准

- `S7-01`：baseline metadata 和 compile 日志证明原有效优化是 `-O2`/speed。
- `S7-02`：计划比较 recipe-scope bbappend 与全局 flags，选择前者并记录影响范围。
- `S7-03`：修复后 `bitbake -e` 和 do_compile argv 只有一个最终有效优化等级 `-Os`。
- `S7-04`：抽样非目标 recipe metadata 未被修改，审批只覆盖目标 bbappend。
- `S7-05`：review、parse、目标 package 和 validation-opt-image 构建成功。
- `S7-06`：QEMU guest 精确输出 `optimization=size` 且返回 0。
- `S7-07`：第二次普通 image build 不重跑目标或无关 task，公共硬门槛全部通过。

## 直接失败条件

修改 local.conf/distro/tune、同时残留互相冲突的优化等级、用运行时脚本伪造 mode、
clean/force 重编译，或没有引用实际 compile argv，均直接失败。

## 必须归档的证据

归档修改前后 metadata、baseline/修复后 compile 片段、bbappend diff、review、package 和
image artifacts、guest 输出、增量摘要、approval 与 TaskRecord。
