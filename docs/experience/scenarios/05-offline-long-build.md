# 离线 mirror 与长构建恢复

适用：源码不在 DL_DIR、只允许本地 mirror，且构建需要跨 Pi 会话继续。

## 第一次失败是验收输入

baseline 应在 `BB_NO_NETWORK=1` 下稳定失败，并明确给出 recipe、`do_fetch`、缺失 URI
和 DL_DIR 对象。没有真实网络请求。不要跳过该证据直接配置 mirror，否则无法证明
原始缺口和修复效果。

## Mirror 修复

1. 取得 recipe 声明的 SHA-256；
2. 计算管理员只读 mirror 文件 SHA-256；
3. 不匹配则暂停，不修改 recipe checksum；
4. 为本次隔离 build 生成 canonical file PREMIRRORS；
5. 用 mirror preflight 和 metadata query 证明规则生效；
6. 通过内容绑定审批应用 run-local conf。

```text
baseline = run_offline_build_once()
assert baseline.first_error.task == "do_fetch"

if sha256(local_file) != recipe_sha256:
  PAUSE

apply(run_local_premirror)
verify(effective_mirror, BB_NO_NETWORK)
job = start_detached_once(target, iteration=1)
checkpoint(job.identity, job.log_offset, resume_action)
```

PREMIRRORS 容易在 JSON、BitBake 和字符串层之间发生双重转义。历史 E2E 先后出现字面
`\\n`、孤立分隔符和 basename 丢失。使用项目的确定性 preflight，不手写多层转义。

## 跨会话恢复

首会话拿到 JobRecord 后立即 checkpoint：task/job ID、PID/PGID、start ticks、boot ID、
heartbeat、offset 和下一动作。退出 Pi 客户端不应停止 worker。

新会话必须：

- 打开同一 TaskRecord；
- status 同一 JobRecord；
- 核对身份后从保存 offset tail；
- 不创建第二个同 fingerprint job；
- 成功后收集该 job 绑定的下载、package 和 image artifacts；
- 完成 ordinary incremental confirmation。

E2E-05 最终 r8 在 offset 262 退出，worker 独立运行到 8472；第二会话从 262 继续，
没有重复 verification job，第二次构建 3432/3432 task 不需重跑。

## 夹具隔离经验

共享 DL_DIR 可能保留历史同名对象或链接，使预期 baseline 不失败。应使用每 run 唯一
archive basename，并保持内容/checksum 不变；不要删除共享 DL_DIR 来制造缺口。

## 反模式

- curl/wget/git 或临时允许联网；
- 修改 URI/checksum 绕过输入校验；
- 把 mirror 文件手工复制成 deploy 产物；
- Pi 退出时连带终止 worker；
- 恢复后重新启动同 target；
- 从 offset 0 反复把大日志塞进上下文；
- 删除 downloads/sstate/TMPDIR。

来源：E2E-05、2026-07-29 初次失败和 2026-07-30 100 分复测。

