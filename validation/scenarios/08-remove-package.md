# E2E-08：从指定镜像移除软件包

## 目标

验证 agent 能否追踪一个软件包进入镜像的完整运行时依赖链，并以 image-scope 的最小
修改将其移除，同时保持必需产品功能和镜像可启动性。

## 给 agent 的任务

> `validation-remove-image` 当前包含不再允许出货的 `legacy-diag`，但必须继续保留并运行
> `core-agent`。请先构建 baseline，用 manifest 和 metadata 解释 legacy-diag 是直接、
> RDEPENDS 还是 RRECOMMENDS 引入；比较修改 packagegroup 与只影响该镜像的方案，等待
> 审批后实施。最终镜像不得包含 package 或 `/usr/bin/legacy-diag`，QEMU 中
> `core-agent --self-test` 仍须成功。不能在 do_rootfs 后手工删文件或全局禁用推荐包。

## 控制器夹具与 oracle

packagegroup-validation-product 硬依赖 core-agent，并通过 RRECOMMENDS 引入 legacy-diag；
image 只安装该 packagegroup。正确最低影响方案是在目标 image 中定向拒绝
legacy-diag recommendation。直接修改 packagegroup 会影响它的其他潜在消费者；全局
NO_RECOMMENDATIONS 影响更大。

## 专属完成标准

- `S8-01`：baseline manifest/rootfs 证明两个包和命令均存在。
- `S8-02`：metadata 或依赖图证明 legacy-diag 来自 packagegroup 的 RRECOMMENDS。
- `S8-03`：至少比较 packagegroup 修改与 image-scope 排除，选择影响分最低方案。
- `S8-04`：审批和最终 diff 仅覆盖目标 image recipe，不修改 package backend/cache。
- `S8-05`：review、parse 和修复后 image build 成功，无 solver/依赖错误。
- `S8-06`：新 manifest/rootfs 均不存在 legacy-diag，且没有 post-rootfs 手工删除痕迹。
- `S8-07`：QEMU 中 legacy-diag 不存在，core-agent self-test 输出正确且返回 0。
- `S8-08`：第二次普通 image build复用已完成 task，公共硬门槛全部通过。

## 直接失败条件

手工删除 rootfs/deploy 文件、全局 NO_RECOMMENDATIONS、屏蔽 solver/QA、移除 core-agent、
修改共享 packagegroup 或只看 recipe 文本不核对 manifest，均直接失败。

## 必须归档的证据

归档 baseline/最终 manifest、依赖变量来源、方案比较、image diff、review、两次 image
JobRecord、rootfs 路径检查、QEMU 两项行为证据、approval 与 TaskRecord。
