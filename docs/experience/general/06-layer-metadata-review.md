# Layer、metadata 与预检

## 核心经验

单个文件语法正确，不代表 metadata 图完整。新 layer、新 recipe 和 bbappend 必须同时
满足注册、BBFILES 匹配、FILESPATH 解析、include 关系、license/checksum 和作用域。

历史 E2E 暴露过 layer 未加入 BBLAYERS、recipe 放在 BBFILES glob 外、固定附件放错
`files/`、image `require` 路径拼错、以及合法公共 include 被误报。当前 ChangeSet
preflight 会联合检查这些关系，但仍需在计划中显式描述。

## 新 layer 最小结构

```text
meta-product/
  conf/layer.conf
  recipes-apps/<name>/<name>_<version>.bb
  recipes-apps/<name>/files/<fixed-inputs>
  recipes-core/images/<image>.bb
```

`layer.conf` 至少应给出唯一 collection、pattern、priority 和 scarthgap compatibility。
路径必须落入展开后的 `BBFILES` glob，layer 只注册一次。

## Recipe 计划检查

- `SUMMARY`、`LICENSE`、正确 `LIC_FILES_CHKSUM`；
- 固定、可复核的 `SRC_URI`，离线输入位于消费 recipe 的 `files/`；
- 正确 `S`、交叉编译和 install 语义；
- `PACKAGES/FILES` 与实际安装路径一致；
- 需要时显式 build/runtime dependency；
- 不复制公共 include 已提供的字段和源码；
- image 用自身 `IMAGE_INSTALL` 表达产品范围。

## Metadata 不是文本覆盖

最终值受 layer priority、override、weak/default assignment、append、class 和匿名 Python
共同影响。scarthgap 使用 colon override。确认值时查看 `bitbake -e` 的值和历史；确认
append 时用 `show-appends`；确认 layer 时用 `show-layers`。

```text
candidate = text_search(variable)
effective = bitbake_environment(target, variable, history=true)
active_append = show_appends(recipe)

assert candidate_is_not_treated_as_effective_without(effective)
```

## 联合预检

在申请审批前检查：

1. changed layer 是否会在本次 BBLAYERS 中注册；
2. 每个 recipe/bbappend 是否匹配该 layer 的 BBFILES；
3. 每个静态 `file://` 是否能在计划 FILESPATH 中解析；
4. `require/include` 是否在允许图内可解析；
5. patch 是否有状态说明且可应用；
6. image、package removal、flags 等语义是否采用最小作用域；
7. 所有固定输入 hash 是否与控制器清单一致。

## 验证顺序

review → show-layers/show-appends → 全局 parse → 独立 recipe/package → image → manifest →
guest。低成本失败应在昂贵 image build 前暴露。

## 反模式

- 只检查新文件，不检查 metadata 图；
- 把附件放在 layer 根或另一个 recipe 的 `files/`；
- recipe 文件路径不匹配 BBFILES；
- 为单镜像需求修改全局 local.conf；
- 为避免 include review 问题复制公共源码/字段；
- 看到文件存在就认定 append 或 fragment 生效；
- parse 未通过就启动高成本构建。

对应来源：E2E-02、04、06、09、10，`knowledge/scarthgap/layer-workflows.md` 和 changes/review 测试。

