# 从指定镜像移除软件包

适用：只从一个 image 移除不允许出货的软件，同时保留引入它的核心产品功能。

## 先追踪进入路径

不能只在 recipe 文本中搜索包名。用 baseline manifest/rootfs 证明包存在，再查询最终
metadata 或依赖图，判断它是：

- image 直接安装；
- 由 `RDEPENDS` 硬依赖引入；
- 由 `RRECOMMENDS` 推荐引入；
- packagegroup 或 image feature 间接引入。

不同路径对应不同修复，不能通用地使用 `IMAGE_INSTALL:remove`。

## 影响分析

E2E-08 中 packagegroup 硬依赖 `core-agent`，推荐 `legacy-diag`。修改共享 packagegroup
会影响其他消费者，全局 `NO_RECOMMENDATIONS` 会移除所有推荐。最低影响方案是在目标
image 定向设置 `BAD_RECOMMENDATIONS`。

```text
source = dependency_source(forbidden_package)

if source.kind == RRECOMMENDS:
  choose(image_scoped_BAD_RECOMMENDATIONS)
elif source.kind == direct_install:
  choose(image_scoped_install_removal)
elif source.kind == RDEPENDS:
  analyze_required_function_before_any_change()
else:
  stop_and_collect_more_metadata()
```

如果是硬依赖，不能靠 BAD_RECOMMENDATIONS 或 solver hack 移除；需要重新评估产品功能、
包拆分或依赖设计。

## 验证闭环

1. baseline manifest 和 rootfs 同时证明 forbidden/core package 存在；
2. metadata 证明完整依赖来源；
3. 比较共享 packagegroup 与 image-scope 方案；
4. 审批只覆盖目标 image recipe；
5. review、parse 和 image build 无 solver 错误；
6. 对成功 image JobRecord 执行 manifest absence assertion；
7. guest 结构化断言 forbidden binary 不存在；
8. guest 中核心应用 self-test 成功；
9. 增量确认并停止 QEMU。

Build exit 0 但 manifest 仍含 forbidden package 时，是可修复语义失败。将 artifact
assertion Evidence 标为 FAILED 并受控重规划，不要把整个 task 提前设为 terminal
FAILED，也不要清 sstate。

## 历史经验

初次 E2E-08 功能实现但合同未完整闭合，正式判 FAIL；修复 Evidence ledger、semantic
replan 和 artifact assertion 后，新 run 得到 95 分 PASS。这个场景说明功能结果不能
抵消证据和状态错误。

## 反模式

- do_rootfs 后手工删除文件；
- 全局 `NO_RECOMMENDATIONS`；
- 修改共享 packagegroup 解决单 image；
- 屏蔽 solver/QA；
- 连核心应用一起移除；
- 只看 recipe 文本，不核对稳定 manifest；
- 用预期失败的零散命令替代结构化 absence assertion。

来源：E2E-08、artifact assertion 和 state semantic-replan 测试。

