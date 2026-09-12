# Compatibility

The adapter baseline is T3 `0.0.40` at revision `efccda9ac9230db22b36990cffabdad218fa41b0`. Runtime parsing is additive-compatible and isolates every raw method in `packages/adapter-t3`.

Runtime capability status is behavior-based. Connection setup verifies shell/search reads and performs deliberately invalid, non-mutating requests to detect the dispatch, diff, and subscription method tags. Read capabilities become `supported` only after those checks. Commands behind the shared dispatch method remain `degraded` until that exact command succeeds in normal use; the gateway never creates a thread, starts a turn, or answers an approval merely as a probe.

Run `pnpm fingerprint:t3 /path/to/t3code` to extract and hash methods, command/event literals, auth endpoints, approval values, and the WebSocket route. CI compares latest upstream fingerprints and then runs fixture tests. A fingerprint change is an early warning, not automatically proof of breakage.

Run `pnpm inspect:t3 -- --url http://host:3773` for discovery/auth metadata. Add `--pairing-token TOKEN` only when intentionally consuming a one-time token for an authenticated safe-read RPC probe.

Run `pnpm smoke:t3` only against a disposable project with `T3_SMOKE_ALLOW_MUTATION=true`. It creates and archives a real T3 thread and can invoke a configured provider.
