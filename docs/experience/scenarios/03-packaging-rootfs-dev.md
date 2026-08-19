# Package split、rootfs 与开发包

适用：recipe 能构建，但 image `do_rootfs` 找不到包；或需要在指定 image 中同时集成
runtime 和 `-dev` 包。

## 四个名字必须分清

- recipe 名/BPN：构建 metadata 的入口；
- `${PN}`：默认主 output package 名；
- `${PN}-cli`、`${PN}-dev` 等：实际 output packages；
- `IMAGE_INSTALL` token：rootfs package manager 要解析的 package 名。

recipe 构建成功只说明 packaging task 可以完成，不说明 `${PN}` 一定存在，也不说明
image 中安装了持有目标文件的 package。

## 诊断 package split

1. 从当前 image `do_rootfs` solver 日志取得第一个 no-match/依赖错误；
2. 查询 `PACKAGES`、`FILES:*`、`RDEPENDS:*` 的最终值和来源；
3. 用 pkgdata 证明 `/usr/bin/...`、header、`.pc`、symlink 的实际 ownership；
4. 对照 image token，找出 recipe/package 命名断层；
5. 区分主包为空、依赖缺失和 image 安装名错误。

```text
requested = image.IMAGE_INSTALL
produced = pkgdata.packages(recipe)
owner = pkgdata.owner(required_path)

if requested not in produced:
  choose(image_token_fix, stable_metapackage_fix, based_on_product_contract)
```

## 修复选择

E2E-03 的夹具允许两种合理方向：image 直接安装 `field-console-cli`，或保持稳定产品
token，让空主包成为显式 meta-package 并依赖 cli。最终复测选择后者：
`ALLOW_EMPTY:${PN}` 加 `RDEPENDS:${PN} = "${PN}-cli"`。这不是通用答案；只有产品
接口确实要求稳定 token 时才合理，不能无依据制造空包。

对于 E2E-09，默认 split 已正确。最低影响修复是只向目标 image 显式加入
`libwidget-dev`，而不是开启全局 `dev-pkgs`，也不应把开发文件塞回 runtime。

## 验证闭环

- review、parse 和 standalone recipe build；
- 输出 package 列表、架构、文件 ownership；
- image build 的 solver 无未解决依赖；
- manifest 包含正确 runtime/cli/dev package；
- rootfs 路径、权限和 symlink 正确；
- guest 中版本/self-test 成功；开发场景还要检查 header、`.pc`、unversioned symlink；
- 第二次普通 image build 不重跑已完成 task。

## 反模式

- 删除 image 应用需求；
- 无产品理由设置 ALLOW_EMPTY 或 RPROVIDES；
- 关闭 QA 或忽略 solver；
- 手工把 binary/sysroot 文件复制进 rootfs；
- 设置全局 `dev-pkgs` 满足单 image；
- 把 header、`.pc`、开发 symlink 塞进 runtime；
- host pkgdata 取代 guest 行为验证。

来源：E2E-03、09。E2E-03 的最终 r9 强制当前 FAILED baseline、metadata ownership 和
guest exit 0 三类 Evidence；E2E-09 在第二轮修正 image include 路径后完成闭环。

