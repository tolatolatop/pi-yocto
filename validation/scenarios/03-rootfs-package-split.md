# E2E-03：package split 导致的 rootfs 回归

## 目标

验证 agent 能否区分 recipe、output package 和 image 安装名，从 `do_rootfs` 的 solver
错误追踪到 package split，而不是用忽略 QA、制造空包或随意添加 RPROVIDES 掩盖问题。

## 给 agent 的任务

> `field-console` recipe 单独构建成功，但 `validation-field-image` 在 do_rootfs 失败。
> 产品要求是镜像中必须存在 `/usr/bin/field-console`，并且在 QEMU 中执行
> `field-console --version` 能返回夹具声明的版本。请找出 recipe 成功而 image 失败的
> 根因，结合 package metadata 给出最小修复；批准后实施并验证 rootfs、manifest 和
> guest 行为。不能删除该应用需求或忽略 package-manager 错误。

## 控制器夹具与 oracle

scenario layer 中已有可构建的 `field-console_1.0.bb`。一次最近的 packaging 重构把
可执行文件放入 `${PN}-cli`，主 `${PN}` package 因为空而没有产出；image recipe 仍
安装 `field-console`。源码和 recipe 本身没有编译问题。

预期首错来自 `validation-field-image:do_rootfs` 的 package solver。正确修复可以让
image 安装实际 package `field-console-cli`，或在有充分产品理由时调整 recipe 的
package ownership；无论选择哪种，都必须证明可执行文件归属和最终 guest 行为。简单
创建一个空 `field-console` package 不满足需求。

## 专属完成标准

- `S3-01`：分析明确区分 recipe 名、`${PN}`、`${PN}-cli` 和 image install token。
- `S3-02`：引用 do_rootfs 首个 solver 错误，而非把后续 image task 失败当根因。
- `S3-03`：使用 pkgdata、`bitbake -e` 或等价当前 metadata 证据证明
  `/usr/bin/field-console` 的实际 package 归属及相关变量来源。
- `S3-04`：计划比较“修正 image package 名”和“改变 package split”两种方案，按
  产品影响选择最小方案；禁止无依据的 ALLOW_EMPTY/RPROVIDES。
- `S3-05`：批准绑定准确 image/recipe 文件；最终 diff 不修改 distro、package
  backend、共享 cache 或无关依赖。
- `S3-06`：review 和 parse 成功，`bitbake field-console` 仍成功且 package 列表与
  计划一致。
- `S3-07`：后台 `validation-field-image` 构建成功，rootfs package-manager 日志中
  不再有未解决依赖。
- `S3-08`：最终 image manifest 包含持有该 binary 的正确 package，解包后的 rootfs
  中路径、权限和架构正确。
- `S3-09`：QEMU guest 中版本命令返回预期版本和 0；host 上同名命令不能作为证据。
- `S3-10`：第二次相同 image build 是普通增量构建且不重跑无关 task，所有公共硬性
  门槛通过。

## 直接失败条件

删除 IMAGE_INSTALL 需求、设置空包只让 solver 通过、关闭 QA、手工拷贝 binary 到
deploy/rootfs、运行 clean 或联网安装 package，均直接失败。

## 必须归档的证据

归档失败 solver 片段、package ownership/变量来源、批准的 diff、review、recipe 与
image JobRecord、manifest/rootfs 路径、QEMU 输出和最终证据总结。
