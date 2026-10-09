package main

import (
	"bufio"
	"bytes"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	reindexInterval  = 60 * time.Second
	projectIdleLimit = 30 * time.Minute
)

// alwaysSkip are directories that are never descended into, ignored-files toggle or not.
var alwaysSkip = map[string]bool{".git": true, "node_modules": true, ".cache": true}

var generatedRe = regexp.MustCompile(`(?m)^// Code generated .* DO NOT EDIT\.$`)

type entry struct {
	Name    string `json:"name"`
	Dir     bool   `json:"dir,omitempty"`
	Ignored bool   `json:"ignored,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Dirty   bool   `json:"dirty,omitempty"`
}

type gitInfo struct {
	Branch string
	Dirty  bool
}

type fileStat struct {
	mtime time.Time
	size  int64
}

type genCache struct {
	stat fileStat
	gen  bool
}

type project struct {
	cfg *projectConfig
	srv *server

	mu       sync.RWMutex
	dirs     map[string][]entry // rel dir ("" = root) -> children
	files    []string           // non-ignored rel file paths
	stats    map[string]fileStat
	gen      map[string]genCache
	state    string // "indexing" | "ready" | "error: ..."
	version  int
	indexing bool
	kick     chan struct{}
	lsp      *lspClient
	lspMu    sync.Mutex
	stopped  chan struct{}
	started  sync.Once
	usedMu   sync.Mutex
	used     time.Time
	git      map[string]gitInfo // rel dir of each repo root ("" = project root)
}

func newProject(cfg *projectConfig, srv *server) *project {
	p := &project{cfg: cfg, srv: srv, dirs: map[string][]entry{}, stats: map[string]fileStat{}, gen: map[string]genCache{}, state: "not indexed", kick: make(chan struct{}, 1), stopped: make(chan struct{})}
	return p
}

// startIndexing starts background indexing the first time the project is used, so
// discovered projects cost nothing until opened.
func (p *project) startIndexing() {
	p.touch()
	p.started.Do(func() { go p.indexLoop() })
}

func (p *project) rootGit() gitInfo {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.git[""]
}

func (p *project) stop() {
	close(p.stopped)
	p.lspMu.Lock()
	if p.lsp != nil {
		p.lsp.shutdown()
		p.lsp = nil
	}
	p.lspMu.Unlock()
}

func (p *project) reindex() {
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

// indexLoop re-indexes periodically while the project is in use. The interval grows
// with index cost (a 30k-file tree takes seconds), and unused projects stop until touched again.
func (p *project) indexLoop() {
	for {
		start := time.Now()
		p.index()
		wait := max(reindexInterval, 10*time.Since(start))
		for {
			select {
			case <-p.stopped:
				return
			case <-p.kick:
			case <-time.After(wait):
				if time.Since(p.lastUsed()) > projectIdleLimit {
					wait = time.Minute
					continue
				}
			}
			break
		}
	}
}

func (p *project) touch() {
	p.usedMu.Lock()
	p.used = time.Now()
	p.usedMu.Unlock()
}

func (p *project) lastUsed() time.Time {
	p.usedMu.Lock()
	defer p.usedMu.Unlock()
	return p.used
}

func (p *project) index() {
	start := time.Now()
	root := p.cfg.Path
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		p.mu.Lock()
		p.state = "error: not a directory"
		p.mu.Unlock()
		return
	}
	p.mu.Lock()
	if p.version == 0 {
		p.state = "indexing"
	}
	oldGen, oldStats := p.gen, p.stats
	p.mu.Unlock()
	p.mu.RLock()
	p.mu.RUnlock()
	dirs := map[string][]entry{}
	stats := map[string]fileStat{}
	gen := map[string]genCache{}
	var files []string
	gitIgnored := map[string]bool{} // rel path (dirs without trailing slash) -> ignored
	gits := map[string]gitInfo{}
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if rel == "." {
			rel = ""
		}
		if !d.IsDir() {
			return nil
		}
		if rel != "" && (alwaysSkip[d.Name()] || gitIgnored[rel]) {
			return filepath.SkipDir
		}
		if _, err := os.Lstat(filepath.Join(path, ".git")); err == nil {
			if _, ok := gits[rel]; !ok {
				gits[rel] = gitStatus(path)
			}
			for _, ig := range gitIgnoredPaths(path) {
				gitIgnored[filepath.Join(rel, ig)] = true
			}
		}
		ents, err := os.ReadDir(path)
		if err != nil {
			return nil
		}
		var children []entry
		for _, e := range ents {
			crel := filepath.Join(rel, e.Name())
			isDir := e.IsDir()
			if e.Type()&fs.ModeSymlink != 0 {
				if fi, err := os.Stat(filepath.Join(path, e.Name())); err == nil {
					isDir = fi.IsDir()
				}
			}
			en := entry{Name: e.Name(), Dir: isDir}
			if isDir && !alwaysSkip[e.Name()] && !gitIgnored[crel] {
				if _, err := os.Lstat(filepath.Join(path, e.Name(), ".git")); err == nil {
					g := gitStatus(filepath.Join(path, e.Name()))
					gits[crel] = g
					en.Branch, en.Dirty = g.Branch, g.Dirty
				}
			}
			switch {
			case alwaysSkip[e.Name()]:
				en.Ignored, en.Reason = true, "excluded"
			case gitIgnored[crel]:
				en.Ignored, en.Reason = true, "gitignored"
			case !isDir && strings.HasSuffix(e.Name(), ".go"):
				fi, err := e.Info()
				if err == nil {
					st := fileStat{fi.ModTime(), fi.Size()}
					stats[crel] = st
					g, ok := oldGen[crel]
					if !ok || g.stat != st {
						g = genCache{stat: st, gen: isGenerated(filepath.Join(path, e.Name()))}
					}
					gen[crel] = g
					if g.gen {
						en.Ignored, en.Reason = true, "generated"
					}
				}
			case !isDir && (e.Name() == "go.mod" || e.Name() == "go.work" || e.Name() == "go.sum"):
				if fi, err := e.Info(); err == nil {
					stats[crel] = fileStat{fi.ModTime(), fi.Size()}
				}
			}
			if !isDir && !en.Ignored {
				files = append(files, crel)
			}
			children = append(children, en)
		}
		sort.Slice(children, func(i, j int) bool {
			if children[i].Dir != children[j].Dir {
				return children[i].Dir
			}
			return strings.ToLower(children[i].Name) < strings.ToLower(children[j].Name)
		})
		dirs[rel] = children
		return nil
	})
	sort.Strings(files)
	p.mu.Lock()
	first := len(p.dirs) == 0
	p.dirs, p.files, p.stats, p.gen, p.git = dirs, files, stats, gen, gits
	p.state = "ready"
	p.version++
	p.mu.Unlock()
	if first {
		slog.Info("indexed project", "project", p.cfg.ID, "files", len(files), "took", time.Since(start).Round(time.Millisecond))
	}
	if !first {
		p.notifyChanges(oldStats, stats)
	}
}

// notifyChanges tells gopls about Go files that changed on disk since the last index.
func (p *project) notifyChanges(old, cur map[string]fileStat) {
	p.lspMu.Lock()
	l := p.lsp
	p.lspMu.Unlock()
	if l == nil {
		return
	}
	var changes []fileEvent
	for rel, st := range cur {
		o, ok := old[rel]
		if !ok {
			changes = append(changes, fileEvent{URI: pathToURI(filepath.Join(p.cfg.Path, rel)), Type: 1})
		} else if o != st {
			changes = append(changes, fileEvent{URI: pathToURI(filepath.Join(p.cfg.Path, rel)), Type: 2})
		}
	}
	for rel := range old {
		if _, ok := cur[rel]; !ok {
			changes = append(changes, fileEvent{URI: pathToURI(filepath.Join(p.cfg.Path, rel)), Type: 3})
		}
	}
	if len(changes) > 0 {
		l.notify("workspace/didChangeWatchedFiles", map[string]any{"changes": changes})
	}
}

// gitStatus returns the checked-out branch and whether tracked files have changes.
func gitStatus(dir string) gitInfo {
	out, err := exec.Command("git", "-C", dir, "status", "--porcelain=v2", "--branch", "--untracked-files=no").Output()
	if err != nil {
		return gitInfo{Branch: gitBranch(dir)}
	}
	var g gitInfo
	oid := ""
	for _, line := range strings.Split(string(out), "\n") {
		switch {
		case strings.HasPrefix(line, "# branch.head "):
			g.Branch = strings.TrimPrefix(line, "# branch.head ")
		case strings.HasPrefix(line, "# branch.oid "):
			oid = strings.TrimPrefix(line, "# branch.oid ")
		case line != "" && !strings.HasPrefix(line, "#"):
			g.Dirty = true
		}
	}
	if g.Branch == "(detached)" && len(oid) >= 8 {
		g.Branch = oid[:8]
	}
	return g
}

func gitIgnoredPaths(dir string) []string {
	out, err := exec.Command("git", "-C", dir, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z").Output()
	if err != nil {
		return nil
	}
	var res []string
	for _, s := range bytes.Split(out, []byte{0}) {
		if len(s) > 0 {
			res = append(res, strings.TrimSuffix(string(s), "/"))
		}
	}
	return res
}

func isGenerated(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for i := 0; i < 40 && sc.Scan(); i++ {
		line := sc.Text()
		if generatedRe.MatchString(line) {
			return true
		}
		if strings.HasPrefix(line, "package ") {
			return false
		}
	}
	return false
}

func (p *project) children(rel string, showIgnored bool) ([]entry, bool) {
	p.mu.RLock()
	ents, ok := p.dirs[rel]
	p.mu.RUnlock()
	if !ok {
		// Not indexed (ignored directory or symlink): read from disk.
		des, err := os.ReadDir(filepath.Join(p.cfg.Path, rel))
		if err != nil {
			return nil, false
		}
		for _, d := range des {
			ents = append(ents, entry{Name: d.Name(), Dir: d.IsDir()})
		}
		sort.Slice(ents, func(i, j int) bool {
			if ents[i].Dir != ents[j].Dir {
				return ents[i].Dir
			}
			return strings.ToLower(ents[i].Name) < strings.ToLower(ents[j].Name)
		})
		return ents, true
	}
	if showIgnored {
		return ents, true
	}
	res := make([]entry, 0, len(ents))
	for _, e := range ents {
		if !e.Ignored {
			res = append(res, e)
		}
	}
	return res, true
}

type findResult struct {
	Rel   string `json:"rel"`
	Score int    `json:"score"`
}

// find does an IntelliJ-ish fuzzy match of query against all indexed file paths.
func (p *project) find(query string, limit int) []findResult {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	p.mu.RLock()
	files := p.files
	p.mu.RUnlock()
	var res []findResult
	for _, f := range files {
		target := strings.ToLower(f)
		if !strings.Contains(q, "/") {
			target = strings.ToLower(filepath.Base(f))
		}
		if s, ok := fuzzyScore(target, q); ok {
			if !strings.Contains(q, "/") {
				s += 1000
			}
			res = append(res, findResult{Rel: f, Score: s - len(f)})
		}
	}
	if len(res) == 0 && !strings.Contains(q, "/") {
		for _, f := range files {
			if s, ok := fuzzyScore(strings.ToLower(f), q); ok {
				res = append(res, findResult{Rel: f, Score: s - len(f)})
			}
		}
	}
	sort.Slice(res, func(i, j int) bool {
		if res[i].Score != res[j].Score {
			return res[i].Score > res[j].Score
		}
		return res[i].Rel < res[j].Rel
	})
	if len(res) > limit {
		res = res[:limit]
	}
	return res
}

func fuzzyScore(target, q string) (int, bool) {
	score, ti, prev := 0, 0, -2
	for _, qc := range q {
		idx := strings.IndexRune(target[ti:], qc)
		if idx < 0 {
			return 0, false
		}
		pos := ti + idx
		switch {
		case pos == prev+1:
			score += 15
		case pos == 0 || strings.ContainsRune("/_-. ", rune(target[pos-1])):
			score += 10
		default:
			score++
		}
		prev, ti = pos, pos+len(string(qc))
	}
	if strings.HasPrefix(target, q) {
		score += 50
	}
	return score, true
}

func (p *project) status() (state string, version, files int) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.state, p.version, len(p.files)
}

// gopls returns the running gopls for this project, starting it if needed.
func (p *project) gopls() (*lspClient, error) {
	p.lspMu.Lock()
	defer p.lspMu.Unlock()
	if p.lsp != nil && !p.lsp.isDead() {
		p.lsp.touch()
		return p.lsp, nil
	}
	l, err := startGopls(p.cfg.Path)
	if err != nil {
		return nil, err
	}
	p.lsp = l
	go p.srv.limitGopls(p)
	return l, nil
}

func (p *project) goplsIfRunning() *lspClient {
	p.lspMu.Lock()
	defer p.lspMu.Unlock()
	if p.lsp != nil && !p.lsp.isDead() {
		return p.lsp
	}
	return nil
}

func (p *project) stopGopls() {
	p.lspMu.Lock()
	defer p.lspMu.Unlock()
	if p.lsp != nil {
		slog.Info("stopping gopls", "project", p.cfg.ID)
		p.lsp.shutdown()
		p.lsp = nil
	}
}
