# Architecture

codebrowse is one Go binary (stdlib only) that serves an embedded single-page UI and a small JSON API. All code intelligence comes from [gopls](https://pkg.go.dev/golang.org/x/tools/gopls), which codebrowse runs as a child process per project and talks to over LSP (JSON-RPC on stdin/stdout).

```mermaid
flowchart TB
  B["Browser<br/>web/app.js"] -- "HTTP + session cookie" --> S

  subgraph S [codebrowse server]
    A["auth middleware"] --> M["API handlers<br/>server.go"]
    M --> P["projects<br/>project.go"]
    M --> T["walkthroughs<br/>tour.go, tourstore.go"]
    D["discovery<br/>discover.go"] --> P
    P --> L["LSP client<br/>lsp.go"]
  end

  L -- "JSON-RPC over stdio" --> G1["gopls (project A)"]
  L -- "JSON-RPC over stdio" --> G2["gopls (project B)"]
  P -- "WalkDir, git status" --> FS[("project files")]
  M -- "read files" --> FS
```

## Source files

| File | Responsibility |
| --- | --- |
| `main.go` | Flags, `codebrowse tour` subcommand dispatch, starts discovery, the gopls reaper and the HTTP server. |
| `config.go` | `~/.config/codebrowse/config.json`: load, generate the password/secret on first start, save. |
| `server.go` | Routes, auth, path checks, and every `/api/*` handler. |
| `project.go` | Indexing (file tree, ignore rules, git status), fuzzy file search, gopls lifecycle per project. |
| `lsp.go` | A minimal LSP client: process start, request/response matching, document sync. |
| `discover.go` | Turns directories matching the `discover` globs into projects, every 30s. |
| `github.go` | GitHub pull requests. `parsePRRef` reads links and `owner/repo#n`; `fetchPR` calls the API; `checkoutPR` fetches `refs/pull/<n>/head` and the base branch into a bare cache repo per GitHub repo (`~/.cache/codebrowse/github/<owner>/<repo>.git`) and checks the head out, detached, into a worktree per PR (`.../<repo>/pr-<n>`). The PR becomes a project with `projectConfig.PR` set, saved in the config. `githubToken(r)` is the one place GitHub credentials come from (config `github_token`, else `gh auth token`), and the seam for per-user GitHub sign-in later (plan: `~/Code/plans/261015-codebrowse-github-prs.md`). |
| `gitdiff.go` | Changes against a base branch (one `git diff -U0` per repo) and the branch list. A chosen base that a repo lacks, or that starts with `-`, falls back to the default. |
| `gowork.go` | Generates a `go.work` for a root that holds several modules but no `go.work`. |
| `tour.go`, `tourstore.go` | `codebrowse tour` (validate a walkthrough, print its link) and the saved-tour list. |
| `web/` | The embedded UI. See [frontend.md](frontend.md). |

## Projects and indexing

A project is a directory, either listed in the config or found by a `discover` glob. Discovered projects cost nothing until someone opens them: the first API call that names a project starts its index loop (`startIndexing`, guarded by a `sync.Once`).

```mermaid
stateDiagram-v2
  [*] --> NotIndexed: added or discovered
  NotIndexed --> Indexing: first API call (startIndexing)
  Indexing --> Ready: walk finished
  Ready --> Indexing: timer, or "Reindex" (kick)
  Ready --> Idle: unused for 30 min
  Idle --> Indexing: touched again
  Ready --> [*]: removed, or discovered dir vanished
```

One index pass (`project.index`) walks the tree with `filepath.WalkDir` and builds:

- `dirs`: the children of every directory, for the project tree.
- `files`: every non-ignored file, for fuzzy search (`find`).
- `git`: branch and dirty flag of every repo or worktree root (`git status --porcelain=v2`).
- `stats` and `gen`: size/mtime of Go files, and whether each is generated (cached by stat, so a re-index only re-reads changed files).

Entries are hidden (but kept, so the UI can show them on request) when they are `.git`, `node_modules` or `.cache`, gitignored (`git ls-files -o -i --exclude-standard`), or generated Go files (`// Code generated ... DO NOT EDIT.`).

The loop waits at least 60s between passes, or 10x the time the last pass took, so huge trees don't spin. After the first pass, every re-index diffs the Go file stats and sends `workspace/didChangeWatchedFiles` to gopls, so gopls notices edits made outside codebrowse.

## gopls

gopls is started lazily, by the first request that needs it (`project.gopls()`), with `GOMEMLIMIT=2GiB` and the project root as working directory.

```mermaid
sequenceDiagram
  participant UI as Browser
  participant H as handler (server.go)
  participant P as project
  participant L as lspClient
  participant G as gopls

  UI->>H: GET /api/definition?project&path&line&char
  H->>P: gopls()
  alt not running
    P->>L: startGopls(root, GOWORK=...)
    L->>G: spawn, initialize / initialized
    P->>P: limitGopls: stop least recently used beyond 2
  end
  H->>L: call(path, "textDocument/definition")
  L->>L: wait for initialize
  L->>G: didOpen, or didChange if the file changed on disk
  L->>G: textDocument/definition
  G-->>L: locations
  L-->>H: result
  H-->>UI: JSON locations (path, rel, line, char, text)
```

Limits that keep memory in check:

- At most **2** gopls processes run at once (`maxGopls`). Starting a third stops the least recently used one.
- The reaper stops a gopls that has been idle for **45 minutes** (`goplsIdleLimit`).
- The LSP client keeps at most **40** documents open in gopls (`maxOpenDocs`) and closes the oldest.

Documents are synced by stat: before each request, `sync` compares the file's size and mtime with what gopls last saw, and re-sends the full content if it changed. codebrowse never edits files, so full-content sync is enough.

### Generated go.work

A directory of checked-out repos has several `go.mod` files and no `go.work`. gopls would treat each module separately, so cross-repo navigation and usages would not work. `syntheticGoWork` handles this:

```mermaid
flowchart TD
  A{"root has go.work or go.mod?"} -- yes --> N["use it as is"]
  A -- no --> W["walk up to depth 4, skipping dot dirs, vendor, testdata"]
  W --> C{"2 or more go.mod files<br/>inside git checkouts?"}
  C -- no --> N
  C -- yes --> D["drop duplicate module paths<br/>(keep the shallowest copy)"]
  D --> F["write ~/.cache/codebrowse/gowork/&lt;id&gt;/go.work"]
  F --> E["start gopls with GOWORK=that file"]
```

## Auth and file access

```mermaid
sequenceDiagram
  participant UI as Browser
  participant S as codebrowse
  UI->>S: GET /
  S-->>UI: 302 /login.html (no valid cookie)
  UI->>S: POST /login password=...
  S-->>UI: Set-Cookie codebrowse=HMAC(secret, "session:"+password), 90 days
  UI->>S: GET /api/file (cookie)
  S->>S: constant-time cookie check
  S->>S: allowed(path): resolve symlinks, must be inside a project, GOROOT or GOMODCACHE
  S-->>UI: file content
```

- The session token is derived from the password, so changing the password logs everyone out.
- Every file path from the client must be absolute and is checked by `allowed` after resolving symlinks.
- `/api/raw` (images for the Markdown preview) additionally only serves image types, with `Content-Security-Policy: sandbox` and `nosniff`, so an SVG or HTML file in a repo can't run script in codebrowse's origin.
- There is no TLS; see Security in the main README.

## HTTP API

All endpoints need the session cookie. Paths are absolute; `line` and `char` are 0-based LSP positions, passed through to gopls unchanged.

| Route | Parameters | Returns |
| --- | --- | --- |
| `GET /api/projects` | | Projects with id, name, path, index state and file count. |
| `POST /api/projects` | JSON body `{path, name}` | Adds a project to the config (`~/` is expanded). |
| `DELETE /api/projects` | `project` | Removes it; a discovered one is added to `hidden` so it stays gone. |
| `POST /api/projects/settings` | `project`, `show_ignored` | Toggles showing ignored files (persists a discovered project to the config). |
| `POST /api/projects/reindex` | `project` | Kicks a re-index now. |
| `GET /api/complete` | `path` | Directory completions for the Add Project dialog. |
| `GET /api/status` | `project` | Index state, version, file count, gopls status, root branch and dirty flag. |
| `GET /api/tree` | `project`, `dir` | Children of a directory. |
| `GET /api/find` | `project`, `q` | Fuzzy file matches. |
| `GET /api/file` | `project`, `path` | Content, display path, branch, mtime; `binary` for non-text or files over 8 MB. |
| `GET /api/raw` | `project`, `path` | Image bytes, for the Markdown preview. |
| `GET /api/changes` | `project`, `base`, `whitespace` | Every changed file of every repo in the project, with status (`A`/`M`) and line runs (`add`, `mod`, `del`, each with a content `id` and the removed lines), against where HEAD forked from `base` (default: `main`, `master`, `origin/main` or `origin/master`). Untracked files count as added. Whitespace changes are ignored unless `whitespace=1`. |
| `GET /api/branches` | `project` | Local, then remote branches of all repos in the project, for picking `base`. Empty for a pull request, whose base is fixed. |
| `POST /api/github/pr` | JSON `{"ref"}`: a PR link or `owner/repo#n` | Fetches the PR and checks it out as a project (or updates the checkout), returns the project. 404 if GitHub does not know the PR or the token cannot read it. |
| `GET /gh/<owner>/<repo>/pull/<n>` | | Redirects to `/#gh=<owner>/<repo>/<n>`, which the web app opens. Signed out, the login page brings you back to it. |
| `GET /api/semantic` | `project`, `path` | gopls semantic tokens (+ legend). |
| `GET /api/hints` | `project`, `path` | Parameter-name inlay hints. |
| `GET /api/symbols` | `project`, `path` | Document symbols (structure, sticky header, breadcrumbs). |
| `GET /api/wsymbols` | `project`, `q` | Workspace symbol search. |
| `GET /api/definition`, `/implementation`, `/typedefinition` | `project`, `path`, `line`, `char` | Locations. |
| `GET /api/references` | `project`, `path`, `line`, `char`, `decl` | Usages sorted by path and line, each with its line text. |
| `GET /api/hover` | `project`, `path`, `line`, `char` | Hover docs as Markdown. |
| `GET /api/highlights` | `project`, `path`, `line`, `char` | Occurrences of the symbol at the caret. |
| `GET /api/tours`, `DELETE /api/tours` | `id` (delete) | Saved walkthroughs. |
