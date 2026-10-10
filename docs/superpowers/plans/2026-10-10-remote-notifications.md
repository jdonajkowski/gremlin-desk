# Remote notifications (phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show a desktop notification on the client when a session on another computer needs the user or finishes, naming the host.

**Architecture:** The events already reach the client (`workers:events` with an `attention` event, and turn progress through `applyProgress`). The renderer's `notify()` returns early for remote ids (a phase 1 decision). Remove that, add the host name to the message, and add a setting so remote notifications can be switched off separately.

**Tech Stack:** Electron renderer (plain scripts), `src/notify-rules.js` (UMD, tested with node:test), `src/settings.js`, Settings window.

**Roadmap:** `docs/superpowers/specs/2026-10-10-remote-phase-2-roadmap.md` (sub-project 2a).

## Global Constraints

- The existing rule stays: a notification is raised only when Gremlin is not the focused window or that session is not one of the terminals on screen (`shouldNotify`).
- The main switch `notifications` (config) still turns every notification off (checked in main's `notify:show`). The new setting `notifyRemote` (default `true`) only controls sessions on other computers.
- Clicking a notification focuses Gremlin and selects the session (`projects:select`), which already works for a remote id (it attaches). Do not change main's `notify:show`.
- Local notification text is unchanged. Only remote ones add the host name.
- Events that happen while the client is disconnected are not replayed (accepted; note it in docs).
- No new dependency. Match the surrounding code style. Commits: Conventional Commits with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never touch anything under `docs/manual/` or `docs/remote-sessions-guide.md` (another agent's untracked files).

## Review Focus

1. A remote session whose host is offline or never connected must not raise notifications (no events arrive; check no stale path).
2. A remote project with no host name in the row must still produce a sensible message (no "on undefined").
3. Turning `notifyRemote` off must silence remote notifications only, and live (no restart), like the other renderer toggles.
4. The "finished" notification for an UNATTACHED remote session comes from the host's progress events (`remote:sevent`), for an attached one from the terminal itself; neither path may fire twice for one turn.
5. A notification for a remote session must not fire while its replay is being written (replayed old progress is ignored by `replaying`): verify no notification on attach/reconnect.

---

### Task 1: message wording, setting, config plumbing

**Files:**
- Modify: `src/notify-rules.js`, `test/notify-rules.test.js`
- Modify: `src/main.js` (DEFAULT_CONFIG, `rendererToggles`), `src/settings.js`, `test/settings.test.js`
- Modify: `src/settings/settings.html`

**Interfaces:**
- Produces: `WidgetNotify.message(kind, project, reason, host)` where `host` is an optional string. Without `host` the output is byte-for-byte what it is today. With `host`: finished body `<project> on <host>`; attention body `<project> on <host>\n<why>`; titles unchanged.
- Produces: config key `notifyRemote` (boolean, default true) in `DEFAULT_CONFIG`; `settings.js` normalize/toForm round-trips it like `notifications`; `rendererToggles()` returns `notifyRemote: config.notifyRemote !== false`; the Settings form has a checkbox named `notifyRemote`.

- [ ] **Step 1: Write failing tests**

In `test/notify-rules.test.js` add:

```js
test('message names the host for sessions on other computers', () => {
  assert.deepEqual(message('finished', 'G-Icons', undefined, 'Desk PC'), { title: 'Claude finished', body: 'G-Icons on Desk PC' });
  assert.deepEqual(message('attention', 'G-Icons', 'permission_prompt', 'Desk PC'), { title: 'Claude needs your input', body: 'G-Icons on Desk PC\nWaiting for your permission' });
  assert.deepEqual(message('attention', 'App', undefined, 'Desk PC'), { title: 'Claude needs your input', body: 'App on Desk PC\nWaiting for you' });
});

test('message ignores an empty or non-string host', () => {
  for (const host of [undefined, null, '', '   ', 5, {}]) {
    assert.deepEqual(message('finished', 'App', undefined, host), { title: 'Claude finished', body: 'App' });
  }
});
```

In `test/settings.test.js`, find the existing test that round-trips `notifications` (grep `notifications`; if there is none, find the test for `showMascot`) and add an analogous one proving `notifyRemote` is normalized to a boolean, kept in `values`, and appears in the form (`toForm`), with the default true when absent from the config.

- [ ] **Step 2: Run them, see them fail**

Run: `node --test --test-timeout=60000 test/notify-rules.test.js test/settings.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`src/notify-rules.js`: change `message(kind, project, reason)` to `message(kind, project, reason, host)`. Compute `const where = typeof host === 'string' && host.trim() ? `${name} on ${host.trim()}` : name;` and use `where` in place of `name` in both bodies. Keep everything else.

`src/main.js`: add `notifyRemote: true,` to `DEFAULT_CONFIG` next to `notifications: true,`; in `rendererToggles()` add `notifyRemote: config.notifyRemote !== false`.

`src/settings.js`: next to the `notifications` lines add the same handling for `notifyRemote` in `normalize` (and `toForm` if the function lists keys explicitly; read the file).

`src/settings/settings.html`: after the `notifications` checkbox add
`<label class="check"><input type="checkbox" name="notifyRemote"> Also notify for sessions on other computers (needs the setting above)</label>`.

- [ ] **Step 4: Run tests, then the whole suite**

Run: `node --test --test-timeout=60000 test/notify-rules.test.js test/settings.test.js` then `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/notify-rules.js test/notify-rules.test.js src/main.js src/settings.js test/settings.test.js src/settings/settings.html
git commit -m "feat: notification text can name the host, and a notifyRemote setting" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: renderer wiring and a real two-instance check

**Files:**
- Modify: `src/renderer/renderer.js`
- Modify: `README.md` (one line in the notifications description), `docs/superpowers/plans/2026-10-10-remote-notifications.md` is not edited.

**Interfaces:**
- Consumes: `WidgetNotify.message(kind, project, reason, host)`; `cfg.notifyRemote` from `widget.getConfig()` and the live `widget.onConfigChanged` payload (`notifyRemote`).

- [ ] **Step 1: Wire it**

In `src/renderer/renderer.js`:
1. `notify(id, kind, reason)`: delete the early `if (isRemote(id)) return;`. Add `const remote = isRemote(id); if (remote && cfg.notifyRemote === false) return;`. When building the message pass the host: `const p = projects.find(...)`, `const host = remote && p && p.remote ? p.remote.hostName : undefined;`, `WidgetNotify.message(kind, p && p.name, reason, host)`.
2. `widget.onConfigChanged(...)`: accept `notifyRemote` and apply it live (`cfg.notifyRemote = notifyRemote` when it is not undefined; check how `cfg` is declared and use the existing pattern for the other toggles).
3. README: in the sentence that describes the desktop notification, add that it also covers sessions on other computers (with the host name) and can be switched off separately.

- [ ] **Step 2: Syntax and suite**

Run: `node --check src/renderer/renderer.js` and `npm test`. Expected: pass.

- [ ] **Step 3: Check with a real host and client**

Use throwaway instances only (user data dirs under `$TEMP`, ports 9360 for the host and 9361 for the client; kill ONLY the processes you start; delete the temp dirs; never touch the user's real Gremlin or data). Pair them over loopback as in the earlier remote tests (host: Settings → Remote, 'This computer only', pair a device; client: add the computer). On the host set `claudeCommand` (in the host instance's own config.json) to a harmless Node one-liner session that, on a timer or on typed input, (a) writes an `attention` event line to the file named by the `GREMLIN_WORKERS` environment variable (read `hooks/workers-hook.js` for the exact event shape the real hook writes for the Notification hook, including `sid` and `ts`), and (b) prints the OSC progress sequences `ESC ] 9 ; 4 ; 3 BEL` then, a few seconds later, `ESC ] 9 ; 4 ; 0 BEL` to simulate a turn. To observe notifications deterministically, TEMPORARILY add a `console.log('NOTIFY', JSON.stringify({id,title,body}))` as the first line of the `ipcMain.on('notify:show', ...)` handler in the CLIENT run only, and REVERT it before committing (`git diff src/main.js` must be empty). Verify and record, with the values read from the client's stdout:
   1. With the client window NOT focused (minimize it or focus another window; the focus rule needs `document.hasFocus()` false), an attention event from a remote session yields exactly one `NOTIFY` with title 'Claude needs your input' and a body 'PROJECT on HOSTNAME' plus the reason line; a finished turn yields one 'Claude finished' with 'PROJECT on HOSTNAME'.
   2. Both for an ATTACHED session (terminal open) and an UNATTACHED one (listed in the rail, never opened): exactly one notification per event, none duplicated.
   3. With the client window focused and that session on screen: no notification.
   4. Unticking 'Also notify for sessions on other computers' (Settings) silences remote notifications immediately (no restart) while a LOCAL session still notifies; unticking the main notifications setting silences both.
   5. Attaching or reconnecting (kill the host and start it again) produces NO notification from the replay.
   6. Clicking is a Windows UI action you cannot drive: instead call the same path the click uses, `send('projects:select', {id})`, by evaluating `window.widget`? (not reachable): so state plainly that click-through was verified by reading main.js `notify:show` (it sends `projects:select` with the id and the renderer's `onSelect` calls `activate(id)`), not by a run.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/renderer.js README.md
git commit -m "feat: desktop notifications for sessions on other computers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
