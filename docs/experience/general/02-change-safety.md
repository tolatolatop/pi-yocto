# 变更边界、审批与脏工作区

## 核心经验

“修改内容正确”不等于“修改过程安全”。工程现场常有未提交修改、共享 cache、外部
layer 和长期运行任务。pi-yocto 将安全边界建立在精确快照、不可变 ChangeSet、内容
哈希和单次审批消费上，而不是依赖口头约束。

早期 E2E 暴露过审批命令为空、批准范围与实际写入不一致、直接 kill QEMU、以及多行
shell 中删除命令漏检等问题。当前执行层会阻断这些路径，但任务计划仍应主动缩小范围。

## 修改前必须记录

- Poky commit 与分支；
- dirty/untracked 路径及受保护文件哈希；
- 原始 build/conf 与本次隔离 build/conf 的边界；
- active layers 和允许写入的 layer；
- DL_DIR、SSTATE_DIR、TMPDIR 的用途与所有权；
- TaskRecord ID、准确文件集合、预期 pre-image；
- 风险、恢复方法和验证合同。

## 安全变更模型

```text
plan exact paths and content
        ↓
prepare immutable ChangeSet
        ↓
preflight patch + metadata + layer graph
        ↓
request approval bound to task/change/hash/files
        ↓
recheck pre-image and content hash
        ↓
atomically apply or rollback
        ↓
review exact applied diff
```

审批只授权已经展示的内容。文件集合、命令、内容或风险发生变化，应准备新的 ChangeSet，
不能扩展旧审批。

## 最小影响原则

| 需求 | 优先范围 | 避免扩大到 |
| --- | --- | --- |
| 单镜像加/删包 | image recipe | distro、全局 `local.conf` |
| 单 recipe flags | recipe-scope bbappend | tune、全局 CFLAGS |
| 新软件 | 产品/scenario layer | Poky 或第三方 layer |
| kernel fragment | 产品 layer bbappend | Poky defconfig、TMPDIR `.config` |
| 本次 run mirror | 隔离 build conf | 全局 proxy、共享 cache 策略 |

## 脏文件保护

不要“顺手整理”基线中的 dirty/untracked 内容。即便一个文件看似与任务相关，也应先
证明必须修改，并把原始哈希和完整 diff 纳入新审批。已有 `scripts/runqemu` 修改、
meta-local 配置或外层未跟踪目录都可能是用户资产，不是待清理垃圾。

## 失败和回滚

- 预检失败：不申请审批，不写入；
- 审批 pending/denied/expired：停止写入；
- pre-image 漂移：拒绝应用，重新检查，而非覆盖；
- 部分应用失败：原子回滚本 ChangeSet，不触碰无关文件；
- 验证失败：保留 diff、日志和 Evidence，走受控重规划；
- 不可恢复：诚实终止，不用 destructive cleanup 掩盖现场。

## 反模式

- 审批“修改这个 layer”而不列文件和内容；
- 先写文件，之后补审批；
- 修改已脏文件却不记录 pre-image；
- 用 `rm -rf`、cleanall 或删除共享 cache 作为恢复；
- 直接 `kill/pkill` 停止受管 job；
- 把凭据写进 repo、TaskRecord、日志或模型配置；
- 将构建成功与审批合规互相替代。

## 复核清单

最终报告应能回答：实际写了哪些路径、由哪个 ChangeSet 和 approval 授权、审批是否被
单次消费、受保护快照是否不变、是否存在活动 job、是否有未归档的失败或回滚。

对应来源：验证公共门槛 G-01～G-05、E2E-02、07、08，以及 2026-07-31 全量报告。

