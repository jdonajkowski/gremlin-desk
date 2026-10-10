# Remote sessions, phase 2: roadmap

Phase 1 (0.15.x) lets one Gremlin attach to, start, restart and close Claude sessions on another Gremlin over the LAN (spec: `2026-10-10-remote-sessions-design.md`). Phase 2 closes the gaps that make a remote project feel second-class. Each sub-project gets its own short spec and plan, and ships on its own.

## Order

| # | Sub-project | What the user gets | Size | Status |
|---|---|---|---|---|
| 2a | Notifications for remote sessions | A desktop notification on the client when a remote Claude needs you or finishes, naming the host | Small | Planned: `plans/2026-10-10-remote-notifications.md` |
| 2b | Files, Markdown and search on the remote | Browse and open the host's project files, follow Markdown links, search across projects | Large | Not started |
| 2c | Install tools on the remote | A remote Setup tab: see what the host has, install Claude, git or gh there, output streamed back | Medium; security sensitive | Not started |
| 2d | Project settings on the remote | Session defaults, worktrees, spend and saved layouts for remote projects | Medium; many small requests | Not started |
| 2e | Hardening | Pairing secrets in the OS keychain (Electron `safeStorage`); Tailscale guidance and a real test of pairing over a Tailscale address; the small deferred items from the phase 1 reviews | Medium | Not started |
| 2f | Mobile access | A phone client (see "Mobile" below) | Medium to large | Decision pending |

## Why this order

- 2a is the biggest daily gap and the smallest build: the events already arrive at the client and are only suppressed.
- 2b is what "full remote" means to most people. It needs new request types (list, read, write, search) and strict path rules on the host (never outside the project folder, same rules as the local files panel).
- 2c runs installers as the user on the host. It needs explicit per-action confirmation on the host side, and streamed output.
- 2d and 2e can slot in earlier if a need appears.

## Mobile (2f): Tailscale first, relay only if needed

Decided 2026-10-10: the user wants a phone client in the future (Android). The plan is **Tailscale on the phone and the host**, not a relay.

- Tailscale gives the phone a private, encrypted path to the host's Tailscale address (the host already accepts 100.64.0.0/10 as a listen address). No router port, no server to run, no store account needed on Android.
- The phone still needs a client for the Gremlin protocol. Cheapest first: a **phone web page served by the host** (needs a browser-friendly connection type, such as WebSocket, added next to the TCP one, with the same encrypted frames done in WebCrypto). A native Android app is the bigger alternative.
- Before building either, test the Claude mobile app's own Remote Control for the same need; Gremlin's extra value would be the multi-project rail and the dots.
- A **relay** (the host connects out to a server; the channel is already end to end encrypted so the server can be a dumb pipe) is deferred until Tailscale proves insufficient. If it is ever built, per-device lockouts (not per-address), a push service for phone notifications, and QR pairing are required parts.
- Open decision: web page versus native app; to be taken after 2b to 2e.

## Rules every sub-project keeps

- The transport stays the encrypted channel from phase 1. New features are new request types, not a new protocol.
- The host decides what a client may do. A paired client is treated as the user, but requests are validated like untrusted input (types, sizes, paths).
- Host folder paths are used only as opaque keys on the client (phase 1 ruling). New features must not show them.
- Every sub-project is tested with real instances (host plus client) as well as unit tests, and states plainly what was not tested.
