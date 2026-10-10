<p align="center"><img src="assets/logo.png" width="420" alt="Gremlin: a coral gremlin with circuit lines on its forehead, scowling over the top of a terminal window"></p>

# Gremlin

*Formerly Claude Widget.*

A borderless, always-on-top desktop workspace that hosts [Claude Code](https://claude.com/claude-code) terminal sessions, one per project, with a file tree, an editor, a browser and a status panel around them. Built with Electron, [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty) and [Monaco](https://microsoft.github.io/monaco-editor/). Runs on Windows and Linux (Arch packages included).

## Install

**Windows:** download and run [**Gremlin-Setup.exe**](https://github.com/jdonajkowski/gremlin-desk/releases/latest/download/Gremlin-Setup.exe) (always the latest release; older versions are on the [releases page](https://github.com/jdonajkowski/gremlin-desk/releases)). It installs per user to `%LOCALAPPDATA%\Programs\gremlin-desk`, needs no admin rights and replaces an existing install. **Coming from Claude Widget** (the old name)? Gremlin installs next to it and copies its settings, project list, benchmarks and change log on first start; then uninstall Claude Widget in Settings → Apps. If you once added its hooks or status line wrapper to `settings.json` by hand, remove those entries (Gremlin passes its own to each session). Everything Gremlin itself needs is inside the installer; Node.js is not required. The installer isn't code-signed, so SmartScreen may ask you to confirm ("More info" → "Run anyway").

**Linux:** installers are published as [GitHub Releases](https://github.com/jdonajkowski/gremlin-desk/releases): an Arch `.pacman` package and an AppImage for other distros. This one-liner picks the right file and installs it (no GitHub account needed):

```sh
curl -fsSL https://raw.githubusercontent.com/jdonajkowski/gremlin-desk/main/scripts/install-linux.sh | bash
```

On Arch and Arch-based distros it installs the package to `/opt/Gremlin` with a menu entry (it asks for your sudo password). Elsewhere it puts the AppImage in `~/.local/bin` with a menu entry; AppImages need FUSE 2 (`libfuse2` / `fuse2`). To update, run it again. Add `-s v0.3.0` after `bash` for a specific release. You can also download the files from the [releases page](https://github.com/jdonajkowski/gremlin-desk/releases) and run `sudo pacman -U claude-desktop-widget-<version>.pacman`.

**First launch** opens **Settings → Setup**, which checks this machine and fixes what's missing:

| Item | What Setup does |
| --- | --- |
| Claude Code | Installs it with the official installer (`irm https://claude.ai/install.ps1 \| iex` on Windows, `curl -fsSL https://claude.ai/install.sh \| bash` on Linux) |
| Git | Installs it (`winget` on Windows; `pacman`, `apt` or `dnf` on Linux) and sets your commit name and email |
| GitHub CLI | Installs it and signs in (`gh auth login`) |
| Claude sign-in | Starts `claude`, which signs you in through your browser |
| Node.js, VS Code | Optional; installs them if you want npx-based tools or "Open in VS Code" |

Install and sign-in steps run in a terminal window you can see. Click **Check again** when one finishes: Gremlin re-reads `PATH`, so new tools work without a restart. Setup is always available from the tray menu or **Settings → Setup**.

## Where things are stored

Everything lives under your projects folder, `~/Projects` (`%USERPROFILE%\Projects` on Windows):

| Folder | Contents |
| --- | --- |
| `~/Projects/<name>` | Your projects. Every subfolder is listed in Gremlin |
| `~/Projects/.claude` | Claude Code's config folder for Gremlin sessions (`CLAUDE_CONFIG_DIR`): plugins, skills, commands, history, `settings.json`, `CLAUDE.md` and the global `AGENTS.md` |
| `~/Projects/.claude/gremlin` | Gremlin's own files: `config.json`, `window-state.json`, `projects.json`, the system change log, per-session logs |

The first run copies what already exists: the settings of Claude Widget (the app's old name, `.claude/widget` or `%APPDATA%\Claude Widget` on Windows) into `.claude/gremlin`, and `~/.claude` plus `~/.claude.json` into `~/Projects/.claude`. Plugin paths are rewritten to the new folder. Your sign-in token is **not** copied, because two copies of one login can sign each other out. Instead, Gremlin sessions sign in once on their own (Setup → Sign in). Claude Code outside Gremlin, including the Claude desktop app, keeps using `~/.claude`. Set **Settings → General → Claude config folder** to empty to share `~/.claude` instead.

Tools that read Claude's folder directly need to be pointed at it, e.g. `CLAUDE_CONFIG_DIR=~/Projects/.claude npx ccusage@latest daily`.

## Features

- **Projects:** a list on the left with one live Claude Code session per project, and a dot showing whether it is working, needs you, finished while you were away, or idle. At the bottom, Glitch the gremlin peeks up over a ledge and acts out what Claude is doing: a thought bubble while it thinks, drumming fingers while a tool or subagent runs, a bubble with an orange ? while a question or permission prompt waits (in any open session), and otherwise it blinks and now and then waves. After 5 minutes with no typing, clicking or Claude activity (`guardMinutes`), Glitch climbs out over the bottom edge of the terminal, pulls his spear up from below it and patrols along the edge, now and then stopping to chew a network cable or type; any activity sends him back to the rail. It ducks if you get close; `showMascot` turns it off
- **Files pane:** the folder button in the title bar shows a file tree of the active project. Markdown opens in the viewer, HTML and SVG in the built-in browser, other text files in the editor, and the rest in their default app (programs are shown in Explorer instead of run)
- **Editor:** text files open in Monaco, VS Code's editor component, with syntax highlighting, multi-cursor and find/replace. `Ctrl+S` saves. Changes Claude makes on disk reload live, or show a Reload / Keep my edits bar if you have unsaved edits
- **Open in VS Code:** in the editor, the Markdown viewer and the files pane's right-click menu
- **Browser:** the globe button opens a Chromium window for mockups, local dev servers and tests. It has back/forward, viewport sizes (desktop 1440, laptop 1280, tablet 768, mobile 390), DevTools, and a screenshot button that saves a PNG next to the project, so Claude can look at it. Local HTML files reload when anything in their folder changes. `localhost` links Claude prints open here, other web links in your default browser. Claude (or you) can open a page here from any Gremlin session or terminal tab with `gremlin-open <file-or-url>`, e.g. `gremlin-open mockups/login.html`.
- **Browser control for Claude:** `gremlin-browser` in Gremlin sessions drives the browser's page: `open`, `screenshot` (prints a PNG path Claude can read; `--full`, `--selector`), `viewport mobile`, `text`/`html`, `click`, `type`, `press`, `wait`, `eval`, `console --errors`, `network --failed`, and `cdp <Domain.method> [json]` for any Chrome DevTools Protocol command. It goes through a local endpoint (127.0.0.1, a random port and a per-run token that only Gremlin sessions get) that only reaches the browser page: Gremlin's own windows aren't exposed, and browser-wide CDP domains (Target, Browser) are refused. Turn it off with `browserControl` Pages run sandboxed, with no permissions (camera, location, …) and their own storage
- **Markdown popouts:** click a `.md` path in the terminal to open it rendered (live-reloads on save). Paths relative to a subfolder, bare file names, a trailing period and OSC 8 links all work. **Edit** opens the file in the editor
- **Settings window:** every setting in a form (gear button), plus **Global instructions**, an editor for the `AGENTS.md` Claude follows in every project
- **Remote sessions:** attach to Claude sessions running on another computer on your network. The host's projects sit in your project list under its name, with their dot and git state (see [Remote sessions](#remote-sessions))
- **Status panel** (right): worker rows for subagents and background shells, then progress bars: Claude's task list (done / total, with the task in progress), a running benchmark, and the project's Run-menu tasks (running, passed, failed; click one to show its tab). Below them CPU, CPU temperature, memory, GPU, VRAM and disk, and at the bottom the model, cost, context use, 5-hour and 7-day limits with a bar for time through the 5-hour window (usage ahead of it means you'll hit the limit before it resets), git branch and changes, and a turn timer. It collapses to a slim strip
- Terminal progress bar under the title bar and on the taskbar icon (Claude Code's OSC 9;4 progress)
- Global hotkey to show/hide (default `Ctrl+Alt+Space`), tray icon, pin on top, adjustable opacity, Windows 11 acrylic/mica backdrop
- The shell stays open after `claude` exits, so quitting Claude drops you at a prompt

### For coding

- **Run button (▶):** a dropdown per toolchain the project uses (npm/pnpm/yarn/bun, SPFx, C# / .NET, Python, Deno, make, just, Cargo, Go, Gradle, Maven, CMake, Composer, Docker Compose), each split into **Run**, **Test**, **Package** and **Setup**. You get the project's own scripts plus the usual commands: `npm pack`/`audit`/`outdated`; SPFx `gulp serve`, `bundle --ship` + `package-solution --ship`, `trust-dev-cert` (or the Heft equivalents from SPFx 1.22); `dotnet run`/`watch`/`test`/`publish`/`pack` (each app project of a solution); Python run, pytest/unittest, `build`, venv and installs (using `.venv` or `uv` when present). A task runs in a **terminal tab** above the terminal. When a dev server prints its URL (`http://localhost:5173`), it opens in the built-in browser. **New terminal** opens a plain shell tab. Tabs close with ×, restart with Enter after they exit
- **Split view:** two zones stacked, each with its own tabs. Drag a tab onto the bottom half (or press `Ctrl+Shift+\` or the ⬓ button at the end of the tabs) to split; drag tabs between the zones, or `Ctrl+Shift+M` to move the focused one across. Drag the bar between them to resize. Closing or moving out the last tab of a zone joins them again. Each project keeps its own split. **Open in tab** (right-click a project) adds that project's Claude session as a tab of the project you are viewing, so you can move it to the lower zone and work in two projects at once; × removes the tab and the session keeps running (not remembered after a restart)
- **Git panel** (Workbench → Git): staged and unstaged files, a side-by-side (or inline) diff of what changed, stage / unstage / discard per file or all, commit (Ctrl+Enter; with nothing staged it commits everything), amend, push, pull, history. **✨ Suggest** asks Claude (`claude -p`) to write the commit message from the diff
- **Git badges** in the files pane: M modified, N new, A added, D deleted, R renamed, U conflict, and a dot on folders with changes
- **Project search:** the box at the top of the files pane (`Ctrl+Shift+F`) searches file names and contents (plain text, `.*` regex, `Aa` match case), skipping `node_modules`, build output and binaries. Click a hit to open the editor at that line
- **Worktree sessions:** right-click a git project → **New worktree session…** makes a second checkout on its own branch in `~/Projects/<project>--<branch>`, which shows up in the list (⑂) with its own Claude session, so two sessions can work on the same repo without colliding. **Remove this worktree…** deletes the folder and keeps the branch
- **Working across projects:** the sidebar and the project switcher show each project's git branch, a ● when it has changes and ↑/↓ for commits ahead/behind (refreshed every 15 s); the switcher also shows what each project has cost (from ccusage, tokens only without it). `Ctrl+Shift+J` jumps to the session that needs you, `Ctrl+Shift+K` pastes a saved prompt (stored in `prompts.json`), `Ctrl+Shift+L` sends selected text to another session, `Ctrl+Shift+H` searches every project, and `Ctrl+Shift+O` brings back a saved layout (a project with other projects' sessions as tabs, some in the lower zone). `Ctrl+Alt+F` searches a terminal's output.
- **Tabs:** double-click a tab to rename it, right-click for Rename, Pin, Move to the other zone and Close, drag a tab onto another to reorder. Pinned tabs come first and have no × until unpinned. The Claude session stays first
- **Session defaults:** right-click a project > **Session defaults…** sets the model, permission mode (`default`, `acceptEdits`, `plan`, `auto`) and environment variables its Claude session starts with, one `model:`, `permission:` or `env: NAME=value` per line. Read at every session start, so ↻ applies a change (`project-defaults.json`)
- **New project** (Workbench): starter projects written straight to disk (empty, Node.js tool, Vite web app, Electron app, Python package, C# console app, C# web API), each with `AGENTS.md` + a `CLAUDE.md` that imports it, `.gitignore`, optionally a git repo with a first commit, dependencies installed in a terminal tab, and a private GitHub repo (`gh`). The C# ones are a solution with an xUnit test project, targeting the newest installed .NET SDK. **SPFx**, **TanStack Start** and **Next.js** come from the framework's own generator (Yeoman generator, TanStack CLI, create-next-app) so they start on the latest release, which the form looks up on npm and shows. For SPFx it also shows which Node.js versions that release supports and whether yours is one (the generator runs on a supported Node through npx, and the project gets an `.nvmrc`); you pick a web part (React, no framework, minimal), an extension or a library
- **Usage** (Workbench): cost and tokens per day (last 30 days) and per session with its project, from [ccusage](https://github.com/ryoppippi/ccusage) (run through `npx` if it isn't installed). Without Node.js it counts tokens from Claude's transcripts, without cost

### For tuning the system

- **Safety net:** a hook (`hooks/guard-hook.js`) looks at every Bash/PowerShell command Claude runs in a Gremlin session. System changes (registry, services, scheduled tasks, boot configuration, power plans, Windows features, Defender, firewall and network, environment variables, files in `C:\Windows`/`Program Files` and the hosts file; on Linux sudo, pacman/apt/dnf, systemctl, sysctl and `/proc/sys`/`/sys`, files in `/etc` and `/boot`, bootloader, kernel modules, disks, CPU/GPU tuning, firewall, users) make Claude **ask first**, even in auto-accept modes. Before asking, the hook reads the old state and records how to undo it. Settings → General or the shield menu switches it to *only log* or *off*
- **Changes and undo** (Workbench → Changes): each change with its command, whether it ran, and its undo steps: registry values put back (or removed if they were new), deleted keys re-imported from an export, service startup types and running state, power plan and power settings, environment variables, execution policy, Defender settings, scheduled tasks, Windows features, winget/choco packages, sysctl and sysfs values, systemd units, pacman/apt/dnf packages, backed-up `/etc` files, GPU power limits and clocks, CPU governor, power profiles. **Undo** runs them in a terminal window, as administrator (UAC) when needed, newest change first; **Copy undo script** copies them. Commands without an automatic undo say so
- **Snapshots** (Workbench → Monitor & snapshots, or the shield menu): a Windows restore point (lifting Windows' one-per-day limit for that one), or a Timeshift/Snapper snapshot on Linux, plus a button to open System Restore / Timeshift
- **System monitor:** CPU (with per-core bars), memory, GPU (nvidia-smi, or amdgpu on Linux: load, temperature, VRAM, power, clock) and disk, live in the side panel and with history graphs in the Workbench. CPU temperature comes from hwmon on Linux; on Windows it needs [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) running, since Windows only shows it to administrators
- **Benchmark:** a 10-second run (single-core and all-core hashing, memory copies, disk writes and flushes). Label runs ("before", "after power plan"), pick a baseline, and see the change in percent
- **Admin terminal** (shield button ⛨): a terminal tab running as administrator after one UAC prompt (Linux: `sudo -s`), or **Claude as administrator** on Windows, with Gremlin's hooks, so the safety net still applies. Admin tabs are red and turn the window frame red while in front
- **Logs** (Workbench): errors and warnings from the Windows Event Log (System, Application) or the systemd journal, for the last hour, day or week, with a filter and auto-refresh. **Ask Claude** pastes an entry into the active session as a question about it; you review it and press Enter

### Remote sessions

Attach to Claude sessions on another computer on your network. On the computer that runs the sessions, open Settings → Remote, tick **Allow other computers**, and click **Pair a new device**. On the other computer, Settings → Remote → **Add a computer**, enter the address, port and pairing code. The host's projects appear in your project list with their state; click one to attach, start a session, restart it (Ctrl+Shift+R) or close it. Traffic is encrypted. A pairing code gives full access to the host's sessions (a shell as you), so pair only your own devices and revoke ones you stop using. Files, search, Markdown links, session defaults and spend are not available on remote projects yet.

## Keyboard and mouse

| Action | Shortcut |
| --- | --- |
| Show / hide Gremlin | `Ctrl+Alt+Space` (configurable) |
| Copy selection | `Ctrl+C` with text selected, or `Ctrl+Shift+C` |
| Paste | `Ctrl+V` / `Ctrl+Shift+V` |
| Newline in Claude's prompt | `Shift+Enter` |
| Restart session | `Ctrl+Shift+R` |
| Open the Nth project in the list | `Ctrl+1` … `Ctrl+9` |
| Next / previous open session | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Collapse / expand the project list | `Ctrl+Shift+B`, or the title-bar ☰ button |
| Go to a project (type to filter; `Enter` opens it, `Ctrl+Enter` opens it as a tab) | `Ctrl+Shift+P` |
| Jump to the next session that needs you (waiting for an answer, then finished) | `Ctrl+Shift+J` |
| Search the terminal output (`Enter` / `Shift+Enter` next / previous, `Esc` closes) | `Ctrl+Alt+F` |
| Saved prompts (`Enter` pastes into the prompt, `Ctrl+Enter` pastes and sends, `Ctrl+N` new, `Ctrl+Shift+N` new for this project, `Ctrl+Delete` remove) | `Ctrl+Shift+K` |
| Send the selected text (else the clipboard) to another session's prompt | `Ctrl+Shift+L` |
| Search file names and contents in every project (`Enter` opens the file at that line) | `Ctrl+Shift+H` |
| Saved layouts: apply one, `Ctrl+N` saves the current tabs and zones as one | `Ctrl+Shift+O` |
| Show / hide the files pane | `Ctrl+Shift+E`, or the title-bar folder button |
| Search the project | `Ctrl+Shift+F` (`Esc` clears) |
| Open the Workbench | `Ctrl+Shift+G`, or the title-bar grid button |
| Next / previous terminal tab (in the focused zone) | `Ctrl+PageDown` / `Ctrl+PageUp` |
| Split into two zones / join them | `Ctrl+Shift+\` |
| Move the focused tab to the other zone | `Ctrl+Shift+M`, or drag the tab |
| Collapse / expand the right panel | `Ctrl+Shift+W`, the › button in its header, or click the collapsed strip |
| Font size | `Ctrl+=` / `Ctrl+-` |
| Maximize / restore | Title-bar □ button, or double-click the title bar |
| Full screen | `F11` |
| Right-click | Copy selection, or paste if nothing is selected |
| Click a `.md` path | Open it rendered in a popout (`Esc` closes the popout) |
| Right-click a file in the files pane | Open, edit, open in browser, open in VS Code, show in Explorer, copy path |
| Save in the editor / settings | `Ctrl+S` |
| Browser: address bar, reload, DevTools, back / forward | `Ctrl+L`, `F5` (`Shift` skips the cache), `F12`, `Alt+←` / `Alt+→` |

Title-bar buttons: project list, files, browser, run (▶), admin and system (shield), Workbench (grid) on the left; restart, more/less transparent, pin on top, settings, maximize, hide to tray, quit on the right.

## Settings

The gear button (or the tray menu) opens the settings window. It edits `~/Projects/.claude/gremlin/config.json`, keeps keys it doesn't know, and says when a change needs a restart (it has a Restart button). Opacity, pin and the hotkey apply right away. **Open config.json** opens the file itself.

| Key | Default | Notes |
| --- | --- | --- |
| `shell` / `shellArgs` | `powershell.exe -NoLogo -NoExit -Command claude` (Linux: `$SHELL -lc …`) | Shell that hosts each session. Its last argument is replaced by the Claude command |
| `claudeCommand` | last `shellArgs` element, else `claude` | Command each project's session runs. ` --continue` is added the first time a project with Claude history is opened |
| `claudeConfigDir` | `~/Projects/.claude` | Claude Code's config folder for Gremlin sessions (`CLAUDE_CONFIG_DIR`). Empty: `~/.claude` |
| `claudeHooks` | `true` | Pass Gremlin's hooks and status line to each session (see below) |
| `guardMode` | `"ask"` | System change safety net: `"ask"` before system changes, `"log"` only records them with their undo, `"off"` |
| `showSysmon` | `true` | CPU, temperature, memory, GPU, VRAM and disk in the side panel |
| `showMascot` | `true` | Glitch, the gremlin peeking up at the bottom of the project list |
| `guardMinutes` | `5` | Minutes with no typing, clicking or Claude activity before Glitch climbs out to guard the terminal. `0` turns it off |
| `autoOpenDevServer` | `true` | Open the URL a Run-menu dev server prints in the built-in browser |
| `browserControl` | `true` | Let sessions drive the built-in browser with `gremlin-browser` (takes effect after a restart) |
| `projectsRoot` | `~/Projects` | Every subfolder (except names starting with `.`) is listed as a project |
| `cwd` | home folder | Project to open at launch when no project was open last time, if it is in the list |
| `env` | `{}` | Extra environment variables for the sessions |
| `alwaysOnTop` | `true` | |
| `opacity` | `0.95` | 0.3–1 |
| `backgroundMaterial` | `"none"` | `"acrylic"`, `"mica"` or `"tabbed"` (Windows 11 22H2+) |
| `showInTaskbar` | `false` | Needs to be `true` for taskbar progress |
| `notifications` | `true` | Desktop notification when Claude needs you (permission prompt or question) or finishes a turn in a session you are not looking at: Gremlin in the background, or that session not on screen. Click it to open the project |
| `restoreSessions` | `true` | At launch, also reopen the projects whose sessions were open when you quit; each continues its last conversation |
| `launchOnStartup` | `false` | Start Gremlin at sign-in (installed app; on Linux an autostart entry) |
| `startMinimized` | `false` | Open hidden in the tray, or minimized when `showInTaskbar` is on |
| `hotkey` | `Control+Alt+Space` | Electron accelerator syntax |
| `fontFamily` / `fontSize` | Cascadia Mono, 13 | |
| `theme` | dark | xterm.js theme colors |

Window position, pin state, opacity, the open/collapsed state of each pane and the active project are saved in `window-state.json` in the same folder.

### Global instructions

**Settings → Global instructions** edits `AGENTS.md` in Claude's config folder (`~/Projects/.claude/AGENTS.md`). Claude Code reads `CLAUDE.md`, not `AGENTS.md`, so saving also adds an `@AGENTS.md` import line to the `CLAUDE.md` next to it (anything already in that file is kept). The same `AGENTS.md` can be shared with other AI tools.

### Hooks and status line

Worker rows, the "needs you" dot and most of the status footer come from Claude Code hooks (`hooks/workers-hook.js`) and a status line wrapper (`hooks/statusline-tee.js`). With `claudeHooks` on, Gremlin hands them to each session it starts with `claude --settings`, so `settings.json` needs nothing added. The wrapper runs your own status line command (from `settings.json`) and passes its output through, so your status line looks the same.

The scripts run on Node.js when it's on `PATH`, otherwise on Gremlin's own runtime (`ELECTRON_RUN_AS_NODE`), through bash on Linux or Git Bash, or PowerShell on Windows without Git Bash. If `settings.json` already has Gremlin's hooks or wrapper (the manual setup of older versions), Gremlin uses those and doesn't add its own. Hooks only act inside Gremlin: they check `GREMLIN_WORKERS` and `GREMLIN_STATUS`, which only Gremlin sessions have.

The same hook also follows Claude's task list (TaskCreate / TaskUpdate, or TodoWrite) for the tasks progress bar. It also logs the start and end of every tool call (PreToolUse, PostToolUse, PostToolUseFailure, paired by `tool_use_id`) so the Gremlin can tell thinking from working. Those three run in the background (`async`), so Claude never waits for them. If `settings.json` has Gremlin hooks from an older manual setup, Gremlin adds only the events missing there.

Only permission prompts and questions turn the dot to "needs you" (`notification_type` `permission_prompt` / `elicitation_dialog`), not the idle reminder after each turn. Subagent rows finish when the subagent stops. A background shell's row is marked done at the end of the next Claude turn after it exits, since Claude Code has no hook for that. Finished rows fade out after 5 seconds.

### Project list

The list shows every subfolder of `projectsRoot` plus folders you pin from anywhere (📌), in alphabetical order. Click a project to switch to it. The session you leave keeps running in the background. A project's session starts the first time you open it after Gremlin starts, with `--continue` if Claude has history for that folder. ↻ restarts only the active session, with a fresh conversation. Right-click a project for Close session, Rename…, Open in Explorer, and Hide (Unpin for pinned folders). **Rename…** renames the project's folder, moves Claude's history and memory for it to the new name, and restarts its session, which picks up the same conversation (`--continue`). The title bar reads `Gremlin - <name>`. Windows won't rename a folder something is still working in: Gremlin stops the project's session and terminals first, but an editor, Explorer window or program started from the folder has to be closed by you. Git worktree links are repaired. Claude may ask once whether you trust the renamed folder. The + button adds a folder or un-hides one.

| Dot | Meaning |
| --- | --- |
| Pulsing orange | Working (OSC 9;4 progress) |
| Amber half | Needs you: a permission prompt or a question |
| Green ✓ | Finished while you were looking at another project |
| Grey ring | Idle or not started |

### Progress bar

Claude Code only emits OSC 9;4 progress for terminals it recognises, and turns progress *off* when `WT_SESSION` is set. Gremlin handles this for every session: it sets `ConEmuTask=gremlin` (Claude recognises ConEmu by it) and leaves `WT_SESSION` out, even when Gremlin itself was started from Windows Terminal. Without progress, the working dot, the progress bar and Glitch's thinking and working animations never start. Setting either variable in `config.json`'s `env` overrides this.

## Building

Requires Node.js 20+ (tested with 24 / npm 11).

```sh
npm install         # Electron downloads on first run
npm start           # run from source
npm test            # unit tests
npm run dist        # Windows installer: dist/Gremlin-Setup.exe
```

**Linux packages** (Arch `.pacman` and an AppImage) have to be built on Linux, because `node-pty` is compiled there. On Linux or in WSL, after the one-time package install listed at the top of the script:

```sh
bash scripts/build-linux.sh     # puts the .pacman and .AppImage in dist/
```

Or let GitHub build both platforms (`.github/workflows/build.yml`): **Build installers** in the repo's Actions tab attaches the installers to the run. To publish a release, bump `version` in `package.json`, commit, and push a matching tag:

```sh
git tag v0.3.1 && git push origin v0.3.1
```

The build checks the tag matches `package.json`, then publishes the Windows `.exe`, the `.pacman` and the AppImage as the release `v0.3.1`.

Notes:

- On Windows, `node-pty` ships N-API prebuilds that load in Electron as-is, so the build skips native rebuilds (`npmRebuild: false`).
- npm 11 blocks dependency install scripts by default; `node-pty`'s is approved in `allowScripts` in `package.json`.
- Gremlin allows one instance, so `npm start` just focuses a running Gremlin. Quit it first, or run with `--user-data-dir=<folder>` for a separate instance.
- `asar` is off, so `node-pty`'s binaries and the hook scripts load from disk. Only Monaco's `min` build is packaged.

## Repo layout

```
src/main.js              Electron main process: windows, tray, hotkey, projects, settings, setup, IPC
src/sessions.js          One PTY + worker log + status file per open project
src/claude-launch.js     --settings for each session: hooks, status line wrapper, runtime choice
src/data-dirs.js         ~/Projects/.claude layout and the one-time copy from older locations
src/setup-checks.js      Setup tab: tools, install and sign-in commands
src/settings.js          Settings form validation, AGENTS.md import
src/files.js             Files pane: folder listing, open actions, Markdown lookup, VS Code links
src/browser-window.js    Built-in browser window; src/browser-url.js turns typed text into URLs
src/browser-control.js   gremlin-browser endpoint: CDP on the browser page, token-protected
src/projects.js          Project list (scan + pinned - hidden) and initials
src/session-state.js     Reducer: per-session signals -> project dot
src/workers.js           Reducer: hook events -> worker rows and the task list progress
src/zones.js             Split view: which tabs are in which zone
src/log-tail.js          Tails the hook event log
src/footer.js            Status footer formatting
src/git-status.js        Git branch and changes for the footer
src/md-links.js          Finds Markdown paths in terminal text
src/system-guard.js      Which commands change the system, and how to undo them; the change log
src/aux-sessions.js      Terminal tabs (tasks, shells, admin); src/admin-shell.js + admin-helper.js elevate them
src/tasks.js             Run menu: a project's tasks, dev server URLs
src/git-ops.js           Git panel, files pane badges and worktrees
src/search.js            Project search
src/sysmon.js            System monitor sampling; src/bench.js + bench-runner.js the benchmark
src/syslogs.js           Event Log / journal reader
src/usage.js             Usage from ccusage or Claude's transcripts
src/templates.js         New project templates written to disk; src/generators.js + src/spfx.js the generator ones (SPFx, TanStack Start, Next.js)
src/workbench-main.js    Workbench window and its IPC
src/preload.js           Bridge exposed to the main window as window.widget (its name from the Claude Widget days)
src/renderer/            Main window UI: terminals, project rail, files pane
src/editor/              Editor window (Monaco)
src/settings/            Settings window
src/browser/             Browser toolbar
src/md/                  Markdown popout window
src/workbench/           Workbench window: Git, New project, Usage, Monitor, Changes, Logs
hooks/                   workers-hook.js, statusline-tee.js and guard-hook.js, run by Claude Code
bin/                     gremlin-open and gremlin-browser (sh, .cmd, .ps1; gremlin-browser.js is the client), on PATH in Gremlin sessions; widget-open and widget-browser are the old names, kept as aliases
scripts/build-linux.sh   Builds the Linux packages
scripts/install-linux.sh Installs the latest release on Linux
scripts/render-icons.js  Builds assets/logo.png, icon.png, icon.ico (from logo-source.png) and peek.png (from peek-source.png): npx electron scripts/render-icons.js
test/                    Unit tests (npm test)
assets/                  The logo artwork (logo-source.png), the trimmed logo and the app and tray icons made from it
backup/                  Source before the progress-bar patch, and a snapshot of a working config
```
