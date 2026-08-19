# 同源 full/minimal 双变体

适用：同一源码、公共 include 和不同 PACKAGECONFIG 生成两个可在同一镜像共存的包。

## 设计目标

- 公共源码、license 和构建逻辑只维护一份；
- 每个变体 recipe 只表达必要差异；
- output package 和安装路径不冲突；
- image 显式安装两个包；
- guest 能同时执行两种功能形态。

## 先检查公共设计

确认 full recipe 的最终 PACKAGECONFIG、公共 `require/include`、源码归属、`${BPN}` 对
命令名的影响，以及两个包预期安装路径。review 必须理解 include 图，不能把 thin
recipe 因未重复 LICENSE/SRC_URI 而误报。

## 方案比较

| 方案 | 优点 | 风险 |
| --- | --- | --- |
| 两个显式命名命令 | 可同时使用，语义清晰 | 需确保 `${BPN}` 和 FILES 不冲突 |
| update-alternatives | 提供统一入口 | 同一时刻隐藏其中一个变体，不满足同时验证 |
| 复制/分叉源码 | 修改自由 | 维护漂移、license/hash 重复 |

E2E-10 的最低影响方案是新增 `variant-minimal_1.0.bb`，继续 require
`variant-common.inc`，只清空 `extras`，并让 `${BPN}` 产生独立命令名。

```text
full = recipe(require common, PACKAGECONFIG += extras)
minimal = recipe(require common, PACKAGECONFIG -= extras)

assert full.source_identity == minimal.source_identity
assert full.installed_paths ∩ minimal.installed_paths == empty
image.install(full.PN, minimal.PN)
```

## 验证闭环

1. baseline 证明 full feature 和现有 image 行为；
2. 方案比较显式命名与 alternatives；
3. ChangeSet 只含 minimal recipe 和 image recipe；
4. include-aware review、metadata query 和 parse；
5. 两个 package 和组合 image build；
6. manifest/file ownership 无冲突；
7. 同一 QEMU 中两个命令分别输出 full/minimal 且 exit 0；
8. 第二次 ordinary build 验证增量复用。

2026-07-31 E2E-10 得到 98 分；2026-08-16 tmux-only 复测仍 7/7 PASSED，组合 image
第二次构建 3446/3446 task 不需重跑。

## 反模式

- 为 minimal 复制源码或公共 include；
- 两个包安装同一路径并靠覆盖；
- 用 alternatives 隐藏一个变体；
- 修改既有 full recipe 的公共行为满足 minimal；
- 只看 PACKAGECONFIG，不验证实际 package/guest；
- 只分别构建包，不验证同一 image 共存。

来源：E2E-10 和 2026-07-31、08-16 报告。

