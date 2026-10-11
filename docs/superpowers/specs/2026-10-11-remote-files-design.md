# Remote files, Markdown and search (phase 2b-1): view-only

Status: approved design, 2026-10-11. Sub-project 2b of `2026-10-10-remote-phase-2-roadmap.md`. Builds on the phase 1 channel (`2026-10-10-remote-sessions-design.md`). Plans: `plans/2026-10-11-remote-files-part-a.md` and `plans/2026-10-11-remote-files-part-b.md`.

## Goal

On the client, a remote project's files panel, file search, cross-project search and Markdown links work like a local project's, **read-only**. Nothing on the host can be changed by this feature. Editing from the client is a later sub-project (2b-2).

## Decisions

- **View-only.** No save, create, rename or delete.
- **Size limit 2 MB** for viewing a file; larger files show "too large to view remotely". Binary files show "binary file". A second bound protects the channel: a text file whose JSON-escaped form exceeds **4 MiB** (a 2 MB file full of control characters escapes to about 12 MB, which would exceed the 16 MiB frame limit once sealed) is also reported as "too large". Normal 2 MB text is unaffected.
- **Folder listing capped at 2,000 entries** (the rest is reported as truncated).
- **Only files inside the project** are reachable. A path Claude printed that points outside the project (for example `~/notes.md`) is not viewable remotely.
- **No live refresh.** A Reload button re-reads the file (the local popout's file watch cannot cross the network).
- **Literal search only** over the channel in this version. The local panel's regex option is hidden for remote projects. Reason: a catastrophic regex runs synchronously in the host's main process and cannot be interrupted; regex search can come back later on a worker thread. (This is a deliberate narrowing of "same search as local", decided while writing the spec.)
- **No absolute host paths in responses.** Files are always identified by project id plus a project-relative path. (Project ids themselves are the host's normalized folder paths, an accepted phase 1 ruling.)
- **No images in rendered Markdown** in this version (relative images cannot load). The popout shows the alt text.

## Protocol: new requests on the encrypted channel

All are requests in the existing `{t, rid, ...args}` form. Replies are `{ok:true, data}`; host-raised errors reach the client as plain messages (`PublicError`), anything unexpected as `The request failed`.

| Request | Arguments | Data |
|---|---|---|
| `files.list` | `id`, `rel` (`''` = project root) | `{ entries: [{name, rel, dir}], truncated }` |
| `files.read` | `id`, `rel` | `{ rel, name, size, mtimeMs, kind: 'md'\|'text'\|'binary'\|'toolarge', text? }` (`text` only for `md`/`text`) |
| `files.git` | `id` | `{ badges: {rel: 'M'\|'A'\|…} \| null }` (as the local `files:git`) |
| `files.search` | `id`, `query`, `caseSensitive` | `{ files: [{rel}], hits: [{rel, matches:[{line, text}]}], truncated }` |
| `files.searchAll` | `query` | `{ rows: [{id, project, rel, line, text}] }` (rows from every non-missing project on the host, at most 200) |
| `md.resolve` | `id`, `candidates` (≤16 strings) | `{ index, rel }` or `null` |

Cancellation: a new `files.search` / `files.searchAll` from the same client cancels that client's previous one.

## Safety rules (the host treats every request as untrusted input)

- `id` must be a known, non-missing project of this host (`projectList`), never an arbitrary path.
- `rel` must be a string of at most 1024 characters, no NUL, not absolute, no drive letter, no `..` segment after normalizing `\` to `/`.
- The resolved path must stay inside the project root **after resolving symlinks** (`realpath` of both); otherwise "That path is not allowed". Symlinks are not listed in folder listings.
- File reads are capped at 2 MB, listings at 2,000 entries, a search at the existing hit and file caps plus a 20 second time budget, `query` at 200 characters, `candidates` at 16.
- At most 4 file requests in flight per client; more are refused with "Too many file requests".
- Searches and reads use the existing async or small synchronous helpers; no request may block the host window for more than a short moment.
- Responses carry project-relative paths only.

## Client behaviour

- **Files panel** (`files-pane.js`) is enabled for remote ids. Listing, git markers and opening a file go through new main-process routes for `files:list`, `files:git`, `files:open`, `files:openAt`, `files:menu`, `files:search`, `files:searchAll`, `md:resolve`, `md:open`, `md:link` when the id is remote.
- **Markdown** opens in the existing popout (`src/md`): the client renders the received text with the same `marked` pipeline. Title `name · HostName`; the path line shows `HostName: rel`; Edit and VS Code buttons are hidden; Reload re-reads. Relative links in the document resolve against the file's folder and open the next file the same way; `http(s)` links open in the client's browser; anchors work as today.
- **Other text** opens in the existing editor window in a **read-only** mode (Monaco `readOnly`, Save disabled, banner "Read-only copy from HostName"). `editor:save` must refuse for these windows in main as well as in the page. `files:openAt` jumps to the line.
- **Context menu** for remote files: Open (read-only), Copy path (project-relative). No Reveal, Edit or VS Code.
- **Search**: the files panel search uses `files.search` (literal, case option). Ctrl+Shift+H includes each online host's projects, labelled with the host name, ordered after local rows; rows carry namespaced ids.
- **Terminal links**: clickable `.md` paths in a remote session's output resolve through `md.resolve` and open the popout; paths outside the project are not links.
- **Errors**: "Host is not connected", "File is too large to view remotely (over 2 MB)", "Binary file", "That path is not allowed", "Not found", "Too many file requests".

## Out of scope

Editing and saving, creating or deleting files, regex search, images in Markdown, live refresh, "Reveal in Explorer", VS Code, opening binary files, git operations beyond status markers, session defaults / worktrees / spend (phase 2d).

## Testing

- **Unit** (real temp folders): path validation (`..`, absolute, drive letters, backslashes, NUL, long, non-string), symlink escape (skipped where the OS refuses to create symlinks), size and binary handling, listing caps and ignored folders, search limits and cancellation, `md.resolve` including absolute paths inside and outside the project.
- **Host and manager** with fake services and sockets: argument validation, concurrency cap, error mapping, offline behaviour.
- **Real run** with two instances: tree, Markdown popout, read-only text window, git markers, file search, search across projects, terminal `.md` link, offline host, and a hostile client (a raw socket sending traversal paths) getting refusals. State plainly what was not tested (second physical computer, real signed-in Claude).

## Risks

- Symlink and junction handling differs by OS; the realpath check is the guard, tested where possible.
- Large searches on a big repository can take long; the time budget and caps bound it.
- The read-only editor mode touches the editor window code shared with local editing: local behaviour must not change.
