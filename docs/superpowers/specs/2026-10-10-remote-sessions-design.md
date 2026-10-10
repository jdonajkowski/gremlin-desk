# Remote sessions: attach to Claude Code sessions on another computer

Status: draft for review. Phase 1 of 2.

## Goal

Open Gremlin on one computer (the client) and see, attach to, and control the Claude Code sessions running in Gremlin on another computer (the host) on the same network. Both computers are the user's own and both run Gremlin.

Phase 1 (this spec): the host's projects appear in the client's rail; the client can attach to running sessions, start new sessions in any host project, restart and close them. Phase 2 (a separate spec): files, markdown popouts, cross-project search, session defaults, worktrees, spend, desktop notifications for remote attention events. The transport is designed so phase 2 only adds request types.

Out of scope for phase 1: internet access without a VPN, a browser or phone client, aux terminals (the `aux:N` shells) on the host, multiple users.

## Decisions made

- Same LAN is the primary path. Tailscale works too (it is just another interface) but is not special-cased.
- Newline-delimited JSON over plain TCP (`net`), no new dependency.
- The channel is encrypted and authenticated with Node `crypto` (HKDF + AES-256-GCM). No certificates.
- Off by default. Never listens on 0.0.0.0 or public addresses.
- The host window and any number of remote clients can be attached to one session at the same time, and all can type. The PTY size follows whoever resized last.
- A session keeps running on the host when a client disconnects.

## Security model

A paired client can type into a Claude session, which is effectively shell access as the host user. The pairing screen says so.

- **Pairing.** In Settings the host turns on "Allow remote control". It generates a random 256-bit secret per device and shows `host:port` plus a pairing code containing the secret and a device label. The client enters them once and stores the secret.
- **Handshake.** The host sends a nonce. The client replies with its own nonce, its device name and HMAC-SHA256(secret, hostNonce || clientNonce || deviceName). The secret never crosses the wire after pairing.
- **Session key.** HKDF-SHA256(secret, hostNonce || clientNonce) gives one key per direction.
- **Frames.** Every frame after the handshake is sealed with AES-256-GCM, with a per-direction counter as the nonce. Tampered, replayed or reordered frames fail to decrypt and close the connection.
- **Rate limit.** After 5 failed handshakes from an address, that address is locked out for a short time. Logged: device name and result only.
- **Revoking.** Settings lists paired devices (name, last seen). Revoke deletes that device's secret.
- **Threat coverage.** Protects against sniffing and injection on the LAN. Does not protect against someone who holds a pairing secret; revoke handles that.
- **Storage.** Secrets are stored in `remote-hosts.json` (client) and the host's device list (host) in the data dir for now. Moving them to the OS keychain (Electron `safeStorage`) is a later hardening step.

## Protocol

One JSON object per frame: `{t, id?, ...}`.

- Requests carry `t` and a numeric `id`; the reply is `{t:'res', id, ok, data | error}`.
  - `projects` returns the project list, the open session ids and git badges (from `pollAllGit`).
  - `open {projectId, cols, rows}` starts the session via the same code path as `project:open`, without changing the host window's active project.
  - `attach {sessionId, cols, rows}` returns the ring-buffer contents, then live `data` events follow.
  - `detach`, `input {sessionId, data}`, `resize {sessionId, cols, rows}`, `restart`, `close`.
- Events are pushed by the host: `data`, `exit`, `status {sessionId, state}`, `git`, `projects`.
- Clients send project ids only. Project ids are the host's normalized folder paths, sent only as opaque keys: the client never uses them as paths, never displays them (rows have an empty `path`), and a paired device already has shell access as the user.

## Host side

New modules (pure or injected so tests can use fakes):

- `src/remote-host.js`: TCP server, handshake, encrypted framing, request routing. Receives `sessions`, the project list and the open, restart and close functions from `main.js`.
- `src/remote-crypto.js`: handshake, HKDF, AES-GCM framing.
- `src/ring-buffer.js`: per-session byte buffer, about 256 KB.
- `src/osc-progress.js`: scans a PTY stream for OSC 9;4 progress sequences across chunk boundaries.

Changes to existing code:

- In `main.js`, the `send` passed to `createSessions` is wrapped. `pty:data`, `pty:exit` and `status:update` still go to the local window, and also append to the session's ring buffer and push to subscribed remote clients. `sessions.js` itself is unchanged.
- **Replay.** The host keeps no scrollback today (the host window's xterm holds it), so late attach needs the ring buffer. Replay is best effort: a buffer cut mid-escape-sequence can leave the screen slightly off, so the client sends a resize after replay, which makes Claude Code redraw.
- **Dots for unattached sessions.** Working, attention and finished states are computed in the host's renderer today. The host's main process runs `osc-progress.js` on every session's output and combines it with `status:update` and last-activity timing to broadcast `status` events. The implementation plan must check how closely this matches the renderer's rules, including "finished while you were away". This is the main unknown.
- Failure handling: a dropped client only unsubscribes. A bad frame or failed decrypt closes that connection only.

## Client side

- **Namespaced ids.** A remote session has id `r:<hostId>/<projectId>`. `main.js` already routes `pty:input`, `pty:resize`, `pty:restart` and `session:close` on `aux.has(id)`; a `remote.has(id)` branch forwards over the socket. `terminals.js` is keyed by id strings, so remote sessions are ordinary terminals: search, copy and paste, send-to, the prompt palette and OSC 9;4 parsing all work unchanged.
- `src/remote-client.js`: one connection per paired host, request/response map, event stream. Reconnect backoff 2 s up to 30 s; sessions that were attached are re-attached, and the renderer resets that terminal before the replay.
- `src/remote-hosts.js`: pure module for the paired-host list (add, remove, rename, normalize), persisted in `remote-hosts.json`.
- **Rail and switcher.** Each paired host has a rail section with its name and an online, connecting or offline marker; its projects show dots and git badges. Offline hosts collapse to the header. The switcher lists remote projects with the host name as meta. Ctrl+Shift+J includes them.
- **Tabs.** Labelled `name · hostname`. Remote tab ids are never written to `tabPrefs` and not restored on launch (like `aux:` ids). Pairings persist; open remote tabs do not.
- **Settings.** *This computer (host):* allow remote control, interface and port, pairing code with Copy, paired devices with Revoke, and the shell-access warning. *Other computers (client):* add a host (name, `host:port`, pairing code), list, remove.
- **Not available on remote rows in phase 1.** File panel, cross-project search, markdown popouts, session defaults, worktrees, spend, layouts. They are hidden or show "Not available on remote hosts yet". The remote project context menu offers Open, Restart, Close only.
- **Errors.** Plain-language pairing failures: wrong code, host unreachable, remote control off on the host. An unreachable host never blocks startup. While reconnecting, the terminal shows `[connection lost, reconnecting…]` and ignores typing.

## Testing

- Unit tests (`node:test`): `remote-crypto` (round trip, tamper, replay, wrong secret), `ring-buffer` (wrap-around), `osc-progress` (split chunks), `remote-hosts`.
- Integration: `remote-client` against `remote-host` over loopback with fake sessions.
- Manual: two Gremlin processes on one machine (host and client, separate `--user-data-dir`), driven over CDP as in earlier dev-instance runs. Cross-computer behavior (firewall prompts, a real LAN) must be verified by the user; it cannot be tested from a single machine.

## Risks and open items

- Dot accuracy for unattached remote sessions (see Host side).
- Windows Firewall will prompt on first listen; the host UI should say so.
- Host IP changes (DHCP): the client stores `host:port`; users may need to re-enter it. Hostname entry is allowed. mDNS discovery is not in phase 1.
- Secrets are stored in plain JSON in the data dir until the keychain step.
