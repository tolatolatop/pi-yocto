# 新建 layer 与集成新软件

适用：创建产品 layer/image，或把本地审核过的独立软件首次集成到现有 layer。

## 先区分两类任务

- 新 layer：需要 `layer.conf`、BBLAYERS 注册、recipe、固定输入和 image recipe 的联合
  ChangeSet；
- 现有 layer 新 recipe：先证明 active layers 中不存在该 recipe，再只增加 recipe 和
  recipe-local 输入，不引入第三方 layer。

## 准确文件计划

```text
meta-product/conf/layer.conf
meta-product/recipes-apps/tool/tool_1.0.bb
meta-product/recipes-apps/tool/files/tool.c
meta-product/recipes-apps/tool/files/LICENSE
meta-product/recipes-core/images/product-image.bb
isolated-build/conf/bblayers.conf        # 仅新 layer 需要
```

固定附件应逐字节复制到消费 recipe 的 `files/`，并与控制器输入 SHA-256 一致。不要让
recipe 从网络抓源码，也不要把宿主机 binary 当 target 输入。

## Recipe 设计

- 声明 SUMMARY、LICENSE 和准确 LIC_FILES_CHKSUM；
- `SRC_URI` 只引用固定本地输入；
- `S` 与 unpack 布局一致；
- 编译尊重 `${CC}`、`${CFLAGS}`、`${LDFLAGS}` 等交叉环境；
- `do_install` 写入 `${D}`，FILES 与安装路径一致；
- image 在自身 `IMAGE_INSTALL` 加入实际 output package；
- 不通过全局 `local.conf` 污染其他 image。

## 图级预检

申请审批前同时验证：layer 会被注册且只出现一次、recipe 路径命中 BBFILES、所有
`file://` 可由计划 FILESPATH 解析、image `require` 可解析、license hash 正确。早期
E2E 曾因附件放错目录、recipe 在 BBFILES 范围外而浪费修复 iteration。

## 验证闭环

1. `show-layers` 和 review；
2. 全局 parse；
3. 独立 package build，核对架构、package 和 license artifact；
4. image build，稳定 manifest 包含准确 package；
5. 从该 image JobRecord 启动 QEMU；
6. guest 中执行 `tool --self-test`，核对精确输出和 exit 0；
7. 停止 QEMU，再做普通增量确认。

```text
assert hashes(planned_fixed_inputs) == controller_manifest
assert layer_graph_preflight(change_set).passed
approval = request_exact_approval(change_set)
apply_only_if(approval.bound_hash_matches)
verify(parse, package, image_manifest, guest_behavior, incremental)
```

## 历史经验

- E2E-02 最终以六文件 ChangeSet、manifest 和 guest self-test 通过；
- E2E-06 的三个附件逐字节进入 recipe-local `files/`，第二次 image build 全部复用；
- 2026-08-16 在原生 bash 禁用的 tmux-only 环境，E2E-02 仍通过 6/6 合同，说明核心
  流程可由受限工具完成；
- schema 或预检错误应在写入前修正，不应绕过审批。

## 反模式

- 从网络复制现成 recipe；
- 无需要地添加 meta-openembedded 等第三方 layer；
- 修改原始 core-image-minimal 或全局 local.conf；
- recipe 使用宿主编译器或宿主 binary；
- 仅 rootfs 中看到文件，不执行 guest self-test；
- 用已有 core-image-minimal artifact 冒充新 image。

来源：E2E-02、06、12 及对应修复后报告。

