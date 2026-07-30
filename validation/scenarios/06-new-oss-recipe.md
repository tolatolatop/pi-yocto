# E2E-06：从零集成独立开源软件

## 目标

验证 agent 能否在不引入 meta-openembedded 等第三方 layer、也不复制现成 recipe 的
情况下，将一个具有固定源码和许可证的独立 C 软件从零集成进产品 layer 和镜像。

## 给 agent 的任务

> 产品需要在 `validation-oss-image` 中加入新开源工具 `edgeprobe`。当前 active layers
> 中没有它的 recipe；审核后的 1.0 源码、Makefile 和 MIT 许可证已作为固定附件提供。
> 请检查附件、目标 layer 和构建环境，自行设计规范 recipe，等待准确审批后实现。
> 随后完成 review、parse、独立 package 构建、镜像构建和 QEMU 验证。
> `edgeprobe --self-test` 必须输出 `edgeprobe: ok` 并返回 0。不得添加第三方 layer、
> 联网获取 recipe/源码，或修改 Poky、meta-local 和原始 build 配置。

## 控制器夹具与 oracle

隔离 scenario layer 只包含 layer.conf 和继承 `core-image-minimal` 的 image recipe；image
要求安装 `edgeprobe`，但没有对应 recipe。三个文本附件是完整的审核输入，ChangeSet
必须逐字节复制到消费 recipe 的 `files/`，并新建 recipe。附件使用标准 Make 变量，
能够被正确的交叉编译 recipe 构建，不需要宿主工具或网络。

## 专属完成标准

- `S6-01`：工作区和 recipe 搜索证明 active layers 中不存在 edgeprobe。
- `S6-02`：计划准确列出 recipe、三个固定输入的目标路径、构建系统和输出 package。
- `S6-03`：recipe 包含完整 License/checksum、固定本地 SRC_URI、正确 S、编译和安装语义。
- `S6-04`：三个附件逐字节复制，审批只覆盖 scenario layer 中预定文件。
- `S6-05`：review、全局 parse 和 `bitbake edgeprobe` 成功，package 文件/架构正确。
- `S6-06`：validation-oss-image 构建成功，manifest 确认安装 edgeprobe。
- `S6-07`：QEMU guest 中 self-test 输出精确文本并返回 0。
- `S6-08`：第二次普通 image build 不重跑已完成 task，所有公共硬门槛通过。

## 直接失败条件

引入第三方 layer、从网络下载源码或 recipe、用宿主机 binary、跳过 License/QA、修改
共享 Poky/meta-local，或只检查 deploy/rootfs 而不执行 guest self-test，均直接失败。

## 必须归档的证据

归档附件哈希、recipe/文件 diff、recipe 搜索、review、parse、package/image JobRecord、
manifest、QEMU guest 输出、增量摘要、approval 和最终 TaskRecord。
