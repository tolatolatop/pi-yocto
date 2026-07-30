# E2E-10：同一源码 full/minimal 双变体共存

## 目标

验证 agent 能否从一个共享源码和公共 recipe include 建立两个不同 PACKAGECONFIG 的
可共存输出，处理命名/文件冲突，并在同一镜像中证明两种功能形态同时存在。

## 给 agent 的任务

> 产品已有基于公共 `variant-common.inc` 的 `variant-full`，现在要求同一
> `validation-variant-image` 同时安装 full 和 minimal 两种构建形态。请检查公共源码、
> 当前 full recipe、PACKAGECONFIG 和安装路径；比较“两个显式命名命令共存”与
> update-alternatives/覆盖同名文件方案，选择低风险方案并等待审批。新增 minimal
> recipe 后离线完成 review、metadata、构建、镜像和 QEMU 验证：
> `variant-full --mode` 输出 `variant=full`，`variant-minimal --mode` 输出
> `variant=minimal`。两个包不得互相覆盖或冲突。

## 控制器夹具与 oracle

scenario layer 已有公共 inc、固定 C 源码、MIT 许可证、variant-full recipe 和只安装
full 的 image。公共 inc 根据 `PACKAGECONFIG[extras]` 编译 mode，并以 `${BPN}` 作为
命令名。正确最低影响方案是新增只清空 extras 的 variant-minimal recipe，再在 image
显式加入两个包；不需要复制源码、fork include 或设置 alternatives。

## 专属完成标准

- `S10-01`：metadata 证明 full 的 PACKAGECONFIG 包含 extras，公共源码/include 唯一。
- `S10-02`：方案比较覆盖显式命名与同名 alternatives，选择无文件冲突的低影响方案。
- `S10-03`：新增 minimal recipe 复用公共 inc/source，只有必要的变体变量差异。
- `S10-04`：审批准确覆盖 minimal recipe 和 image recipe，不修改既有公共源码/full。
- `S10-05`：修复后 metadata 分别证明 full/minimal feature，review 和 parse 成功。
- `S10-06`：两个 package 和 image 构建成功，manifest/file ownership 无冲突。
- `S10-07`：QEMU 中两个显式命令分别输出精确 mode 并返回 0。
- `S10-08`：第二次普通 image build 不重复无关 task，公共硬门槛全部通过。

## 直接失败条件

复制或分叉公共源码、让两个包安装同一路径后互相覆盖、用 alternatives 隐藏其中一个
变体、修改 Poky/meta-local、或仅凭 recipe 变量不执行 guest 命令，均直接失败。

## 必须归档的证据

归档修改前后 PACKAGECONFIG、方案比较、minimal/image diff、review、两个 package 和
image jobs、manifest/file ownership、QEMU 双命令输出、增量摘要、approval 和 TaskRecord。
