# Remote files, part B: search and Markdown links (2b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Search in files and across projects works for remote projects (literal search), and clickable `.md` paths in a remote session's terminal output open the Markdown popout.

**Architecture:** Extend `src/remote-files.js` with `search`, `searchAll` and `resolveMd`; expose them as host requests (`files.search`, `files.searchAll`, `md.resolve`) with per-client cancellation; add manager methods; route `files:search`, `files:searchAll`, `md:resolve`, `md:open` in main for remote ids; adapt the files-pane search box and Ctrl+Shift+H.

**Depends on:** Part A merged (`plans/2026-10-11-remote-files-part-a.md`): the service, host request plumbing, manager methods and remote viewer windows.

**Spec:** `docs/superpowers/specs/2026-10-11-remote-files-design.md` (binding).

## Global Constraints

- **Literal search only** over the channel (no regex): the remote request has no `regex` argument; a request carrying `regex: true` is refused with "Regex search is not available on remote projects yet". Query ≤ 200 chars, non-empty.
- Existing caps: 500 hits / 20,000 files per project search; cross-project: 12 hits / 8,000 files per project, ≤ 200 rows; plus a **12 second** time budget per request; a new search from the same client cancels its previous one.
- Responses carry project-relative paths only; `files.searchAll` rows carry the host's project ids (the client namespaces them).
- `md.resolve`: at most 16 candidates of ≤ 1024 chars; only `.md/.markdown`; the result must be inside the project; returns `{ index, rel }` or `null`. Absolute candidates are accepted only if they resolve (realpath) inside the project root.
- Same style, no new dependency, CRLF kept, commit trailer as in part A. Never touch `docs/manual/` or `docs/remote-sessions-guide.md`.

## Review Focus

1. A client flooding `files.search` must not leave several searches running (cancellation) or block the host window (time budget, async iteration).
2. `md.resolve` with absolute paths outside the project, `..`, UNC, symlinks, 16+ candidates, non-strings.
3. Search hits for files that disappeared between search and open: clean error.
4. Cross-project rows from two hosts and local projects: ordering, namespaced ids, opening a hit from each.
5. Regex toggle hidden/refused for remote, still working for local.

---

### Task 1: Service additions (`search`, `searchAll`, `resolveMd`)

**Files:**
- Modify: `src/remote-files.js`, `test/remote-files.test.js`

**Interfaces:**
- `createFileService` gains optional dependencies `searchProject` (from `src/search.js`), `projects(): [{id, name, path, missing}]`, `mdFiles(root): string[]` (from `files.mdFiles`), `findByTail` (from `files`), `now = Date.now`.
- New methods:
  - `search(id, query, { caseSensitive }, isCancelled): Promise<{ files, hits, truncated } | { error } | { cancelled: true }>`
  - `searchAll(query, isCancelled): Promise<{ rows } | { error } | { cancelled: true }>` (rows `{id, project, rel, line, text}`, same mapping as the local `files:searchAll` in main.js, at most 200)
  - `resolveMd(id, candidates): { index, rel } | null | { error }`
- Constants: `SEARCH_MS = 12000`, `MAX_QUERY = 200`, `MAX_CANDIDATES = 16`.

- [ ] **Step 1: Failing tests** (real temp folders, a fake `isCancelled`, a fake clock for the time budget):
  1. `search` finds literal matches with `{rel, matches:[{line,text}]}`; `caseSensitive` respected; a query like `a.*b` is searched literally (no regex semantics: assert it matches the literal text `a.*b` and not `axxb`).
  2. Empty / non-string / >200-char query → `{error:'Enter something to search for'}`.
  3. `isCancelled` returning true mid-way → `{cancelled:true}`; the time budget (fake clock jumping past 12 s) → result with `truncated:true`.
  4. Unknown project → `{error:'That project is not available'}`.
  5. `searchAll` returns rows from several projects (ids = project ids), skips missing projects, caps at 200, maps like main.js (first 5 file names with `line: 0`, then hits' first 3 matches).
  6. `resolveMd`: relative `docs/guide.md`; bare `guide.md` (tail match); absolute path inside the project (use `path.join(root,'docs','guide.md')`) → relative `docs/guide.md`; absolute path outside → `null`; `../x.md` → `null`; non-md → `null`; non-string / 17 candidates / candidate > 1024 chars → `{error}` or skipped as specified (16 max, extras ignored); index is the position of the first resolving candidate.
- [ ] **Step 2: Implement.** `search`: validate query/id, build `isCancelledOrLate = () => isCancelled() || now() - t0 > SEARCH_MS`, call `searchProject(root, query, { regex: false, caseSensitive: !!opts.caseSensitive, maxHits: 500, maxFiles: 20000, isCancelled: isCancelledOrLate })`; `null` result means cancelled; if the time budget ended, set `truncated: true`. Check how `searchProject` signals cancellation and a pattern that is a literal: read `src/search.js` (`matcher`) and make sure `regex:false` escapes the query. `searchAll`: iterate `projects()` as in main.js (`maxHits: 12, maxFiles: 8000`), shared time budget. `resolveMd`: for each candidate (≤16, strings ≤1024): if absolute, `path.relative(realRoot, realCandidate)` must stay inside; else `cleanRel`; then require `MD` extension and an existing file via `resolveInside`; else try `findByTail(mdFiles(root), candidate, isWin)` and re-validate with `resolveInside`; return `{ index, rel: clean }`.
- [ ] **Step 3:** tests, `npm test`, commit `feat: search and Markdown path resolution in the remote file service`.

---

### Task 2: Host requests and manager methods

**Files:**
- Modify: `src/remote-host.js`, `test/remote-host.test.js`, `src/remote-clients.js`, `test/remote-clients.test.js`

**Interfaces:**
- Host: handlers `files.search {id, query, caseSensitive}`, `files.searchAll {query}`, `md.resolve {id, candidates}` (when `fileService` is present). Validation before the service is called: strings/arrays/booleans of the right type; `regex` present and truthy → `PublicError('Regex search is not available on remote projects yet')`. Cancellation: per client keep `c.searchToken`; a new search request increments it and the running one's `isCancelled` becomes true; a cancelled one replies `PublicError('Search cancelled')`. A search counts toward the 4-in-flight cap. A client disconnecting cancels its running search.
- Manager: `filesSearch(id, query, opts)`, `filesSearchAll(query)`, `mdResolve(id, candidates)` with the same never-rejecting `{error}` convention as part A; `filesSearchAll` returns rows with ids already namespaced (`nsId(hostId, row.id)`) for every online host; it is called by main once per online host: add `onlineHostIds()` if needed.
- [ ] **Step 1: Failing tests** (host: validation, regex refused before the service is called, cancellation by a second search, disconnect cancels; manager: id mapping, namespaced rows, offline, errors). RED first.
- [ ] **Step 2: Implement; run tests; commit** `feat: search and md.resolve requests, manager methods`.

---

### Task 3: Routing, UI, terminal links and a real run

**Files:**
- Modify: `src/main.js`, `src/renderer/files-pane.js`, `src/renderer/renderer.js`, `src/renderer/terminals.js`, `README.md`

**Behaviour to implement (read each region first; keep local paths unchanged, remote branch at the top of each handler):**
- `files:search` for a remote id → `remote.filesSearch(...)` (the result shape must match what `files-pane.js` renders, add `root: ''`); the regex toggle in the panel is hidden/disabled for remote projects.
- `files:searchAll` (Ctrl+Shift+H): local rows as today, then for every online host the rows from `remote.filesSearchAll(query)`, labelled with the host's project names; ordering local first; total cap 200; a host that errors contributes nothing and shows one toast "HostName: <message>" at most once per search.
- Opening a hit from search (`files:openAt` / `files:open` with a remote id and `rel`/`line`) uses part A's remote viewers (editor read-only at the line).
- `md:resolve` and `md:open` for remote terminal ids: `terminals.js` currently skips link activation for `r:` ids (phase 1 hardening: remote output must not open local files). Re-enable the Markdown link provider **only through `md.resolve` on the host**: candidates are sent to the host, the result is a project-relative path, the popout opens via part A's remote viewer. A path that resolves outside the project is not a link. The OSC 8 `file:` URIs from remote output stay ignored.
- README: replace the sentence saying search and Markdown links are not available on remote projects.

- [ ] **Step 1:** implement; `node --check`; `npm test`.
- [ ] **Step 2: Real run** (throwaway instances, ports 9372/9373, only your own PIDs, temp dirs deleted; a host with two sample projects and a harmless fake `claudeCommand` that prints a path to a project `.md` file and an absolute path outside the project; a second host if cheap, otherwise state it): verify and READ screenshots of: file search in a remote project (literal), the regex toggle absent; Ctrl+Shift+H showing local and remote rows with project names, opening a remote hit at its line in the read-only editor; a clickable terminal `.md` path opening the popout, and the outside-project path not being a link; a flood of 10 quick searches leaving one running (check the host log or timing); the host killed mid-search → clean message; hostile raw-socket requests for `files.search` with `regex:true`, 300-char query, and `md.resolve` with `../` and absolute-outside candidates refused as specified. Local search and local terminal links unchanged.
- [ ] **Step 3:** commit in logical commits.

---

## Self-review notes

- Spec coverage for this part: `files.search`, `files.searchAll`, `md.resolve`, cancellation, literal-only decision, cross-project rows, terminal links: Tasks 1-3.
- Names: `search`, `searchAll`, `resolveMd`, `filesSearch`, `filesSearchAll`, `mdResolve`, `SEARCH_MS`.
