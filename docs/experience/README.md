# pi-yocto 工程经验库

本目录把项目当前能力和 2026-07-29 至 2026-08-16 的真实验证记录整理为可复用经验。
内容面向 Yocto Project 5.0（scarthgap）、BitBake 2.8.x 和 pi-yocto 0.1.0。
它不是上游手册的替代品；变量、类和任务语义仍应以本机 Poky checkout 为准。

## 如何使用

先读通用问题，再按任务选择场景问题。每篇文档均尽量回答五件事：

1. 常见症状是什么；
2. 哪类证据可以证明根因；
3. 如何选择影响最小的修改；
4. 如何形成可恢复、可审计的验证闭环；
5. 哪些“看起来有效”的做法不应采用。

文中的“已验证”表示仓库内 E2E 报告记录过成功结果，不表示任意机器、发行版和模型
都必然得到相同结果。带路径的结论应在当前 workspace 重新取证。

## 通用问题

- [证据优先的诊断](general/01-evidence-first-diagnosis.md)
- [变更边界、审批与脏工作区](general/02-change-safety.md)
- [任务状态、后台作业与恢复](general/03-state-jobs-recovery.md)
- [验证合同与证据类型](general/04-verification-contracts.md)
- [离线、缓存与增量构建](general/05-offline-cache-incremental.md)
- [Layer、metadata 与预检](general/06-layer-metadata-review.md)
- [QEMU 与 guest 运行证据](general/07-qemu-guest-evidence.md)
- [验证场景和夹具设计](general/08-validation-design.md)

## 场景问题

- [Patch 升级回归](scenarios/01-patch-regression.md)
- [新建 layer 与集成新软件](scenarios/02-layer-and-new-recipe.md)
- [Package split、rootfs 与开发包](scenarios/03-packaging-rootfs-dev.md)
- [Kernel fragment 未生效](scenarios/04-kernel-fragment.md)
- [离线 mirror 与长构建恢复](scenarios/05-offline-long-build.md)
- [单 recipe 编译优化](scenarios/06-targeted-optimization.md)
- [从指定镜像移除软件包](scenarios/07-remove-package.md)
- [同源 full/minimal 双变体](scenarios/08-multiple-variants.md)
- [Native sstate 跨 MACHINE 复用](scenarios/09-native-sstate.md)
- [禁用原生 shell 后的 tmux 控制](scenarios/10-tmux-console.md)

## 证据等级

| 等级 | 含义 | 例子 |
| --- | --- | --- |
| 事实 | 当前 run 的工具或产物直接证明 | task 日志、`bitbake -e`、manifest、guest exit code |
| 推断 | 多项事实支持，但仍需标注前提 | 某变量变化导致 signature 变化 |
| 经验 | 历史场景反复有效，当前 run 尚未证明 | 优先局部 bbappend 而非全局 flags |
| 风险 | 尚未关闭或环境相关的条件 | cache 来源不可信、fixture 被历史对象污染 |

最终报告应分开写事实、假设和风险。通用经验只能帮助选择检查路径，不能替代当前日志。

## 主要依据

- `README.md`：当前 CLI、工具、安全和状态约束；
- `knowledge/scarthgap/`：随包提供的 scarthgap 工作流知识；
- `validation/scenarios/`：E2E-01～10 的任务与 oracle；
- `validation/native-cache-repair-e2e/`：E2E-11；
- `validation/tmux-console-e2e/`：E2E-12；
- `validation/results/`：失败、修复和复测结果；
- `validation/improvement-plan.md`：历史问题向执行层门禁的映射；
- `src/` 与 `test/`：当前实现和回归约束。

