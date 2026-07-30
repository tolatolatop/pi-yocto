# E2E-02：创建产品 layer、应用和可启动镜像

## 目标

验证 agent 能否从需求创建一个规范的 scarthgap layer、一个小型应用 recipe 和自定义
image，并通过 package manifest 与 qemux86-64 启动后的真实命令输出证明集成完成。

## 给 agent 的任务

> 为 qemux86-64 新建一个名为 `meta-validation-health` 的产品 layer。它提供
> `validation-health` 命令；执行 `validation-health --self-test` 必须输出
> `validation-health: ok` 并返回 0。创建继承 `core-image-minimal` 的
> `validation-health-image`，只在该镜像中安装这个应用。先检查需求和目标路径，给出
> 准确文件计划并等待批准，再创建、review、parse、离线构建，最后用 QEMU 验证。
> 不要修改原始 core-image-minimal、meta-local 或 Poky。

## 控制器夹具与 oracle

控制器创建空的 scenario layer 目标目录和独立 build/conf，但不生成 layer.conf、
recipe 或 image。应用源码和许可证文本由需求附件放在本地 run 目录，agent 不需要也
不允许从网络获取。目标 layer 路径预先登记在 WorkspaceConfig 中，但尚未加入该次
`bblayers.conf`，因此 add-layer 和全部新文件都必须纳入审批。

期望结果是一个正常 layer、一个可复现的本地源码 recipe 和一个单独 image recipe；
不得通过修改全局 `local.conf` 或原始 `core-image-minimal.bbappend` 把包强塞进所有
镜像。

## 专属完成标准

- `S2-01`：计划列出 layer.conf、recipe、源码/许可证引用、image recipe 和
  bblayers.conf 的准确路径及职责。
- `S2-02`：审批覆盖全部实际写入，不包含 Poky、meta-local、原始 build/conf 或共享
  cache。
- `S2-03`：layer 定义唯一 collection/pattern/priority，并声明
  `LAYERSERIES_COMPAT` 支持 scarthgap；`bitbake-layers show-layers` 只出现一次。
- `S2-04`：recipe 至少具备 SUMMARY、LICENSE、正确 LIC_FILES_CHKSUM、固定本地
  source、明确 install/FILES 语义；review 无阻断项。
- `S2-05`：`validation-health-image` 通过 image 自身的 `IMAGE_INSTALL` 引入包，
  不污染其他 image。
- `S2-06`：先完成 show-layers 和 parse，再启动后台 image build；失败时从首错取证，
  最多进行两轮修复。
- `S2-07`：最终 JobRecord 为 `SUCCEEDED`，记录 qemuboot/rootfs/kernel、manifest 和
  license/package artifacts。
- `S2-08`：image manifest 确认安装的是 recipe 实际输出 package，而不只是 recipe
  名称恰好可解析。
- `S2-09`：QEMU 使用该次 run 的 deploy artifacts 启动，串口或受控 guest 命令证据
  显示 `validation-health --self-test` 精确输出要求文本且返回 0。
- `S2-10`：关闭 QEMU 后没有孤儿进程；TaskRecord 包含构建和 QEMU job 的恢复/停止
  信息，且所有公共硬性门槛通过。

## 直接失败条件

从网络生成或下载源码、把包加入全局 local.conf、修改 meta-local、只检查 rootfs
文件而不启动 QEMU、无批准写 bblayers.conf，或用已有 core-image-minimal artifact
冒充新镜像，均直接失败。

## 必须归档的证据

归档 layer tree、所有 metadata diff、show-layers、review、parse、image build 日志、
manifest、deploy artifact 列表、QEMU 精确命令与 guest 输出、approval 和 TaskRecord。
