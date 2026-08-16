# Tmux-only agent console E2E

This validation launches three independent Pi agents with the project
extension loaded explicitly and these two flags:

```text
--disable bash --tmux-session <scenario-session>
```

The extension removes native `bash` from the active tool set. Each agent can
operate only pane `0.0` of the pre-created session passed at launch through
`yocto_tmux`.

The scenarios are:

1. `roundtrip`: capture the pane, print a nonce, and wait with
   `exactLine: true`. This proves session binding plus send/capture/wait
   without accepting shell command echo as completion.
2. `project-tests`: run the complete pi-yocto test suite, wait for its success
   marker, and report the TAP pass count.
3. `interrupt-recovery`: start a long foreground command, send `C-c`, recover
   the prompt, and print a completion marker.

Each prepared pane enables tmux `pipe-pane` before the agent starts. The raw
console stream is persisted as `<scenario>.tmux.log` at a path fixed in the
run manifest, then flushed when the agent finishes. This is a continuous tmux
record, not merely an end-of-run `capture-pane` snapshot.

The verifier parses only completed tool calls from each JSONL transcript. It
rejects any native `bash` tool call, requires `yocto_tmux` calls bound to the
manifest session, and validates commands, markers, TAP results, and interrupts
against the tmux-owned record. Agent self-reported PASS is not accepted.

```bash
npm run build
node validation/tmux-console-e2e/prepare-run.mjs <run-id>
node validation/tmux-console-e2e/run-agent.mjs <run-root>
node validation/tmux-console-e2e/verify-run.mjs <run-root>
```

The default model is `deepseek/deepseek-v4-flash`. Set `YOCTO_E2E_API_KEY`
or `OPENROUTER_WALLBREAKER_API_KEY` before running.
