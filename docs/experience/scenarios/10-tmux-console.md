# 禁用原生 shell 后的 tmux 控制

适用：Pi 禁用 native bash，只允许 agent 操作启动时绑定的一个 tmux session。

## 安全模型

启动时用 `--tmux-session <exact-session>` 固定会话，单次工具调用不能重定向到其他
session。允许能力包括 capture pane、输入 literal text、等待 literal/regex 输出，
以及发送少量交互键（如 `C-c`）。

绑定能防止 agent 任意选择另一个终端，但 tmux 本身仍是强能力：发送的文本会在 pane
内执行。因此应固定 pane、记录连续 stream，并由 verifier 审计完成的工具调用。

## 三类基础验证

1. roundtrip：打印 nonce，用 exact-line 等待，避免把命令 echo 当完成；
2. project-tests：运行完整测试，等待 success marker，并核对 TAP pass count；
3. interrupt-recovery：启动长前台命令，发送 `C-c`，恢复 prompt 后打印 completion marker。

```text
bind(agent, manifest.tmux_session, pane="0.0")
enable_pipe_pane(raw_log_path)

send_literal(command_with_unique_marker)
wait(exact_line=unique_marker)
verify(marker_in_tmux_owned_continuous_log)
```

只用最后一次 `capture-pane` 不足以证明过程；准备阶段应启用 `pipe-pane`，把原始连续流
写到 manifest 固定路径，结束时 flush。

## Oracle 设计

- transcript 中不得有 native bash 的完成或尝试调用；
- 每次 tmux 调用必须绑定 manifest session；
- 命令、marker、TAP 和中断结果从 tmux-owned record 验证；
- shell command echo 不能被当作命令完成；
- agent 自报 PASS 不被接受。

## 业务场景经验

2026-08-16 在 native bash 禁用时，E2E-02 和 E2E-10 分别以 6/6、7/7 合同通过。
所有 BitBake job 仍为 offline，QEMU 最终 STOPPED。E2E-10 的 idle tmux log 是合理
结果：业务工作全部通过受限 pi-yocto 工具完成，没有隐藏终端活动。

E2E-02 中第一次 guest 命令功能输出正确，但 Evidence claim type 不匹配合同；agent
停止该 QEMU 后用结构化 guest 工具重新取证。这说明拥有 tmux 并不会放宽证据类型。

## 反模式

- 在工具参数中允许任意 session/pane；
- 用 command echo 当 completion marker；
- 只保存末尾 pane 快照；
- verifier 接受 agent 的 PASS 文本；
- 用 tmux 绕过 ChangeSet、job、offline 或 stop approval；
- 无界等待，或前台任务中断后不确认 prompt 恢复。

来源：E2E-12 README、2026-08-16 tmux-only 业务场景报告和 tmux tests。

