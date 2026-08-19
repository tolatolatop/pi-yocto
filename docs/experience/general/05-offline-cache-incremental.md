# 离线、缓存与增量构建

## 核心经验

离线失败是可诊断输入，不是绕过策略的理由。pi-yocto 为 BitBake 设置
`BB_NO_NETWORK=1` 和 `PATCHRESOLVE=noop`。普通 `bitbake target` 是首选增量操作；
不要把 clean、force 或删除 cache 当作通用排障步骤。

## 三类目录不要混淆

| 目录 | 内容 | 经验 |
| --- | --- | --- |
| `DL_DIR` | 固定源码下载对象 | 可跨 build 共享，但必须保持 checksum 语义 |
| `SSTATE_DIR` | 可复用任务输出 | 用 signature 判断命中，可能是共享写入或只读 mirror |
| `TMPDIR` | 当前 build 的工作、stamps、deploy | 应 build-local，不能当共享 cache |

清理任一目录都是高影响动作。若确有必要，必须先证明普通签名失效不能解决，并明确路径、
恢复方案和审批；项目默认不建议该动作。

## 离线 fetch 处理

1. 从当前 `do_fetch` 日志取得 recipe、URI、basename 和失败原因；
2. 确认日志中 offline 生效，没有真实网络回退；
3. 对比 recipe 声明 checksum 与管理员提供的本地对象；
4. 仅为当前 build 生成 canonical file PREMIRRORS；
5. 查询最终 mirror/offline 变量值和来源；
6. 普通增量重试，保留首次失败证据。

```text
if local_archive.sha256 != recipe.expected_sha256:
  pause("mirror input mismatch")
else:
  rule = canonical_file_premirror(uri, local_mirror)
  apply_to_run_local_conf(rule)
  verify_effective_metadata()
  start_or_reuse_detached_build()
```

历史 E2E 曾因 PREMIRRORS 双重转义、分隔符错误和丢失 basename 失败。应使用确定性
preflight，避免模型手工拼接 `\n`。另一次 baseline 被共享 DL_DIR 的历史同名链接绕过；
验证夹具应使用每 run 唯一 basename，而不是删除共享 cache。

## 正确解释 sstate 摘要

- `Current`：当前 TMPDIR/stamps 已满足任务；
- `Local`：从配置的本地 SSTATE_DIR 恢复；
- `Mirrors`：从 SSTATE_MIRRORS 恢复；
- `Missed`：没有可复用对象。

`Current 1428` 只能说明本 TMPDIR 当前有效，不能证明跨 build 的 Local/Mirror 复用。
要证明共享 cache，使用新 TMPDIR、相同输入，观察非零 Local/Mirrors 和零 Missed，并
结合 sigdata 或 stamp。

## 增量确认

第一次功能验证成功后，再执行一次完全相同的普通构建。记录 Attempted/不需重跑、
Sstate summary 和关键 task 状态。不要 clean 后制造“基线”，也不要用 `-f` 强迫变化。

## 缓存异常诊断

- 比较相同 MACHINE/DISTRO/target/concurrency；
- 检查最终 SSTATE_DIR/SSTATE_MIRRORS 与 uninative/hash server；
- 用 sigdata 和 `bitbake-diffsigs` 找第一个意外输入；
- 区分变量在 datastore 中存在与进入 task dependency；
- 修复第一个污染源，不要直接加入全局 hash ignore。

## 反模式

- 临时取消 `BB_NO_NETWORK`；
- 修改 URI/checksum 迁就本地对象；
- `curl/wget/git clone` 补齐输入；
- 删除 DL_DIR/SSTATE_DIR/TMPDIR 证明“不是缓存”；
- 把 Current 当作跨 MACHINE cache 命中；
- 修改全局 proxy 或共享 cache 策略解决单 run 问题。

对应来源：E2E-05、11，`knowledge/scarthgap/build-cache.md` 和 mirror/native-cache 测试。

