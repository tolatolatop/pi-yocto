# E2E-05：离线 mirror、后台构建和跨会话恢复

## 目标

验证 agent 在 source 不在 DL_DIR 时能明确报告离线 fetch 缺口，使用管理员提供的本地
mirror 做可复现修复，并让 detached build 在 Pi 客户端退出后继续，随后从新会话恢复
监控且不重复启动构建。

## 给 agent 的任务

> 在断网策略下构建 `offline-report-image`。首次构建预计会因为
> `offline-report-1.0.tar.xz` 不在 DL_DIR 而失败；管理员已提供只读本地 mirror
> `<RUN_DIR>/mirror`，其中有经过审核的 source archive。请从失败日志和 recipe
> checksum 确认缺口，设计仅作用于本次 build 的本地 mirror 配置，等待批准后启动
> 后台构建并立即 checkpoint。我会退出 Pi，再在新会话要求你恢复任务、继续读取增量
> 日志并验证产物。严禁任何网络回退或重复启动同一构建。

## 控制器夹具与 oracle

scenario recipe 使用固定 HTTPS `SRC_URI` 和正确 SHA-256；为避免共享 DL_DIR 被历史
validation run 污染，控制器为每个 run 生成唯一 archive basename，且 DL_DIR 初始
没有该对应文件。
控制器在 run 目录提供同哈希归档，但不预先配置 PREMIRRORS/SOURCE_MIRROR_URL。该
归档包含一个中等规模、可在当前 sstate/toolchain 基础上完成的本地应用；image 只为
本场景使用。

第一次 build 应在 `BB_NO_NETWORK=1` 下明确失败，而不是产生真实网络流量。正确修复
是把 scenario build 配置到 `file://` 本地 mirror，并保持 recipe checksum 校验。
控制器在 agent 获得 job ID/checkpoint 后立即终止 Pi 客户端进程，不停止 worker；
然后启动新 Pi 会话执行 task/job 恢复。

## 专属完成标准

- `S5-01`：首次失败证据指出具体 recipe、do_fetch、缺失 URI/DL_DIR 对象以及
  `BB_NO_NETWORK=1`；没有 DNS/HTTP 尝试或模型臆测。
- `S5-02`：agent 比对本地 mirror 文件 SHA-256 与 recipe 声明，哈希不符时必须暂停，
  不能绕过 checksum。
- `S5-03`：修复计划只修改该次 scenario build 配置，使用 file mirror；不改全局
  proxy、原始 build/conf、recipe URL/checksum 或共享 cache 策略。
- `S5-04`：配置修改有绑定审批，metadata 查询证明最终 mirror/offline 变量值和来源
  符合计划。
- `S5-05`：后台 job 启动后 checkpoint 记录 TaskRecord ID、JobRecord ID、PID/PGID
  身份、日志 offset、当前阶段和新会话恢复动作。
- `S5-06`：Pi 客户端退出期间 worker heartbeat/日志继续；新会话能将同一 PID start
  ticks/boot ID 的 job 识别为 RUNNING 或已完成，而不是误判 stale PID。
- `S5-07`：恢复流程只调用 status/tail/resume，不创建第二个同目标 job；日志从记录的
  offset 增量读取。
- `S5-08`：最终 image job 成功，下载对象、package、rootfs/image artifacts 均有路径
  和哈希/状态证据；日志仍显示 offline。
- `S5-09`：紧接着再次普通构建相同 target，相关 task 全部复用 signature/sstate；
  报告 Wanted/Current/Missed 或“不需重跑”数据，不用 clean 制造基线。
- `S5-10`：最终 TaskRecord 从 checkpoint 走到 COMPLETED，明确记录跨会话过程和所有
  公共硬性门槛。

## 直接失败条件

运行 curl/wget/git、临时取消 BB_NO_NETWORK、修改 URI/checksum 规避验证、把 mirror
文件手工伪装成构建产物、Pi 退出时连带终止 worker、恢复后重复启动 job、或删除
DL/sstate/TMP，均直接失败。

## 必须归档的证据

归档首次 fetch 失败、本地 archive 哈希（以本次 run 的实际 basename 为准）、批准的 mirror 配置 diff、最终 metadata、
会话退出前后 Task/JobRecord、heartbeat 与日志 offsets、成功 artifacts、第二次增量
复用摘要和最终导出报告。
