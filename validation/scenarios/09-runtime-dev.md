# E2E-09：runtime 与开发包同时集成

## 目标

验证 agent 能否理解一个 recipe 的 runtime 与 `-dev` output package，并只在指定开发
镜像中同时集成二者，而不是开启全局 dev-pkgs 或错误重写 package split。

## 给 agent 的任务

> `libwidget` 已能构建，`validation-dev-image` 当前只有 runtime。产品要求该镜像同时
> 包含 libwidget runtime 与 `libwidget-dev`，供现场诊断程序使用 header 和 pkg-config
> metadata；其他镜像不应变化。请先证明当前 package split/文件 ownership，比较显式
> image 安装与全局 `dev-pkgs`，选择最小方案并等待审批。最终在 QEMU 中验证
> `widget-info`、header、pkg-config 文件和开发 symlink 均真实存在。

## 控制器夹具与 oracle

libwidget recipe 构建 versioned shared library、unversioned development symlink、header、
pkg-config 文件和 widget-info CLI。默认 packaging 已正确将它们分到 libwidget 与
libwidget-dev；初始 image 只显式安装 libwidget。正确修复只修改 image recipe 的
IMAGE_INSTALL。

## 专属完成标准

- `S9-01`：pkgdata/metadata 明确区分 recipe、libwidget、libwidget-dev 及文件归属。
- `S9-02`：baseline manifest 只有 runtime，且 runtime CLI 可以正常链接。
- `S9-03`：比较显式安装 libwidget-dev 与全局 dev-pkgs，选择 image-scope 方案。
- `S9-04`：审批和 diff 只覆盖 validation-dev-image recipe，不修改 libwidget split。
- `S9-05`：review、parse、libwidget 与 image 构建成功，manifest 同时包含两个 package。
- `S9-06`：QEMU 中 widget-info 成功，header、.pc 和 libwidget.so symlink 均存在。
- `S9-07`：没有把 dbg/staticdev/src 包无依据带入镜像，第二次构建正常复用。

## 直接失败条件

设置全局 dev-pkgs、把开发文件塞进 runtime、手工复制 sysroot 文件、仅检查 host pkgdata
而不启动 guest，或污染其他 image，均直接失败。

## 必须归档的证据

归档 package ownership、baseline/最终 manifests、方案比较、image diff、review、
package/image jobs、QEMU runtime 与三类开发文件证据、增量摘要和最终 TaskRecord。
