package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	maxFileSize    = 8 << 20
	maxGopls       = 2
	goplsIdleLimit = 45 * time.Minute
	cookieName     = "codebrowse"
)

type server struct {
	cfg       *config
	mu        sync.Mutex
	projects  map[string]*project
	readRoots []string
}

func (s *server) routes(mux *http.ServeMux, static http.Handler) {
	mux.Handle("GET /", static)
	mux.HandleFunc("POST /login", s.handleLogin)
	mux.HandleFunc("GET /api/projects", s.handleProjects)
	mux.HandleFunc("POST /api/projects", s.handleAddProject)
	mux.HandleFunc("DELETE /api/projects", s.handleRemoveProject)
	mux.HandleFunc("POST /api/projects/settings", s.handleProjectSettings)
	mux.HandleFunc("POST /api/projects/reindex", s.handleReindex)
	mux.HandleFunc("GET /api/complete", s.handleComplete)
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /api/tree", s.handleTree)
	mux.HandleFunc("GET /api/find", s.handleFind)
	mux.HandleFunc("GET /api/file", s.handleFile)
	mux.HandleFunc("GET /api/semantic", s.handleSemantic)
	mux.HandleFunc("GET /api/hints", s.handleHints)
	mux.HandleFunc("GET /api/symbols", s.handleSymbols)
	mux.HandleFunc("GET /api/wsymbols", s.handleWorkspaceSymbols)
	mux.HandleFunc("GET /api/definition", s.handleLocations("textDocument/definition"))
	mux.HandleFunc("GET /api/implementation", s.handleLocations("textDocument/implementation"))
	mux.HandleFunc("GET /api/typedefinition", s.handleLocations("textDocument/typeDefinition"))
	mux.HandleFunc("GET /api/references", s.handleReferences)
	mux.HandleFunc("GET /api/hover", s.handleHover)
	mux.HandleFunc("GET /api/tours", s.handleTours)
	mux.HandleFunc("DELETE /api/tours", s.handleDeleteTour)
	mux.HandleFunc("GET /api/highlights", s.handleHighlights)
}

// ---- auth ----

func (s *server) sessionToken() string {
	m := hmac.New(sha256.New, []byte(s.cfg.Secret))
	m.Write([]byte("session:" + s.cfg.Password))
	return hex.EncodeToString(m.Sum(nil))
}

func (s *server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login" || r.URL.Path == "/login.html" || r.URL.Path == "/favicon.svg" {
			next.ServeHTTP(w, r)
			return
		}
		if c, err := r.Cookie(cookieName); err == nil && subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.sessionToken())) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, "/login.html", http.StatusFound)
	})
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.FormValue("password")), []byte(s.cfg.Password)) != 1 {
		time.Sleep(time.Second)
		http.Redirect(w, r, "/login.html?failed=1", http.StatusFound)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: s.sessionToken(), Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 90 * 24 * 3600})
	http.Redirect(w, r, "/", http.StatusFound)
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, code int, err error) {
	if code >= 500 {
		slog.Warn("request failed", "code", code, "error", err)
	}
	http.Error(w, err.Error(), code)
}

func (s *server) project(r *http.Request) (*project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.projects[r.FormValue("project")]
	if p == nil {
		return nil, errors.New("unknown project")
	}
	p.startIndexing()
	return p, nil
}

// allowed resolves path and checks it lies inside a project, GOROOT or the module cache.
func (s *server) allowed(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("path must be absolute")
	}
	clean := filepath.Clean(path)
	real, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", err
	}
	roots := append([]string{}, s.readRoots...)
	s.mu.Lock()
	for _, p := range s.projects {
		roots = append(roots, p.cfg.Path)
	}
	s.mu.Unlock()
	for _, root := range roots {
		if root == "" {
			continue
		}
		rr, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		if real == rr || strings.HasPrefix(real, rr+string(filepath.Separator)) {
			return clean, nil
		}
	}
	return "", errors.New("path outside of projects")
}

func posParams(r *http.Request) (path string, line, char int, err error) {
	path = r.FormValue("path")
	if line, err = strconv.Atoi(r.FormValue("line")); err != nil {
		return
	}
	char, err = strconv.Atoi(r.FormValue("char"))
	return
}

func textDocPos(path string, line, char int) map[string]any {
	return map[string]any{"textDocument": map[string]any{"uri": pathToURI(path)}, "position": map[string]any{"line": line, "character": char}}
}

func isGoFile(path string) bool {
	return strings.HasSuffix(path, ".go")
}

// lspFor returns the project's gopls and the validated path, or writes an error.
func (s *server) lspFor(w http.ResponseWriter, r *http.Request) (*lspClient, string, bool) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return nil, "", false
	}
	path, err := s.allowed(r.FormValue("path"))
	if err != nil {
		httpErr(w, http.StatusForbidden, err)
		return nil, "", false
	}
	l, err := p.gopls()
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return nil, "", false
	}
	return l, path, true
}

func reqCtx(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

// ---- projects ----

type projectInfo struct {
	*projectConfig
	State string `json:"state"`
	Files int    `json:"files"`
}

func (s *server) handleProjects(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res := []projectInfo{}
	for _, p := range s.projects {
		st, _, n := p.status()
		res = append(res, projectInfo{p.cfg, st, n})
	}
	sort.Slice(res, func(i, j int) bool { return strings.ToLower(res[i].Name) < strings.ToLower(res[j].Name) })
	writeJSON(w, res)
}

func (s *server) handleAddProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	path := req.Path
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(os.Getenv("HOME"), path[2:])
	}
	path, err := filepath.Abs(path)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
		httpErr(w, http.StatusBadRequest, fmt.Errorf("%s is not a directory", path))
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = filepath.Base(path)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg.Hidden = slices.DeleteFunc(s.cfg.Hidden, func(h string) bool { return h == path })
	for _, p := range s.projects {
		if p.cfg.Path == path {
			_ = s.cfg.save()
			writeJSON(w, p.cfg)
			return
		}
	}
	pc := &projectConfig{ID: s.uniqueID(name), Name: name, Path: path}
	s.cfg.Projects = append(s.cfg.Projects, pc)
	if err := s.cfg.save(); err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	s.projects[pc.ID] = newProject(pc, s)
	slog.Info("added project", "id", pc.ID, "path", path)
	writeJSON(w, pc)
}

func (s *server) handleRemoveProject(w http.ResponseWriter, r *http.Request) {
	id := r.FormValue("project")
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.projects[id]
	if p == nil {
		httpErr(w, http.StatusNotFound, errors.New("unknown project"))
		return
	}
	p.stop()
	delete(s.projects, id)
	if p.cfg.Auto {
		s.cfg.Hidden = append(s.cfg.Hidden, p.cfg.Path)
	}
	for i, pc := range s.cfg.Projects {
		if pc.ID == id {
			s.cfg.Projects = append(s.cfg.Projects[:i], s.cfg.Projects[i+1:]...)
			break
		}
	}
	if err := s.cfg.save(); err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *server) handleProjectSettings(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if v := r.FormValue("show_ignored"); v != "" {
		p.cfg.ShowIgnored = v == "1"
	}
	if p.cfg.Auto {
		// Persist the discovered project so its settings survive restarts.
		p.cfg.Auto = false
		s.cfg.Projects = append(s.cfg.Projects, p.cfg)
	}
	if err := s.cfg.save(); err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, p.cfg)
}

func (s *server) handleReindex(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	p.reindex()
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *server) handleComplete(w http.ResponseWriter, r *http.Request) {
	in := r.FormValue("path")
	if in == "" {
		in = "~/"
	}
	home := os.Getenv("HOME")
	expanded := in
	if strings.HasPrefix(in, "~/") {
		expanded = filepath.Join(home, in[2:])
		if strings.HasSuffix(in, "/") {
			expanded += "/"
		}
	}
	dir, prefix := filepath.Dir(expanded), filepath.Base(expanded)
	if strings.HasSuffix(expanded, "/") {
		dir, prefix = expanded, ""
	}
	ents, _ := os.ReadDir(dir)
	res := []string{}
	for _, e := range ents {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), prefix) || (strings.HasPrefix(e.Name(), ".") && !strings.HasPrefix(prefix, ".")) {
			continue
		}
		full := filepath.Join(dir, e.Name())
		if strings.HasPrefix(in, "~/") {
			full = "~/" + strings.TrimPrefix(strings.TrimPrefix(full, home), "/")
		}
		res = append(res, full+"/")
		if len(res) >= 50 {
			break
		}
	}
	writeJSON(w, res)
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	st, ver, n := p.status()
	gs := "stopped"
	if l := p.goplsIfRunning(); l != nil {
		gs = l.status()
	}
	g := p.rootGit()
	writeJSON(w, map[string]any{"index": st, "version": ver, "files": n, "gopls": gs, "branch": g.Branch, "dirty": g.Dirty})
}

func (s *server) handleTree(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	dir := filepath.Clean(r.FormValue("dir"))
	if dir == "." || dir == "/" {
		dir = ""
	}
	if strings.HasPrefix(dir, "..") || filepath.IsAbs(dir) {
		httpErr(w, http.StatusBadRequest, errors.New("bad dir"))
		return
	}
	ents, _ := p.children(dir, p.cfg.ShowIgnored)
	if ents == nil {
		ents = []entry{}
	}
	writeJSON(w, ents)
}

func (s *server) handleFind(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	res := p.find(r.FormValue("q"), 80)
	if res == nil {
		res = []findResult{}
	}
	writeJSON(w, res)
}

// ---- files ----

type fileResp struct {
	Path    string `json:"path"`
	Rel     string `json:"rel"`
	Content string `json:"content"`
	Branch  string `json:"branch,omitempty"`
	Size    int64  `json:"size"`
	Binary  bool   `json:"binary,omitempty"`
	Mtime   int64  `json:"mtime"`
}

func (s *server) handleFile(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	path, err := s.allowed(r.FormValue("path"))
	if err != nil {
		httpErr(w, http.StatusForbidden, err)
		return
	}
	fi, err := os.Stat(path)
	if err != nil {
		httpErr(w, http.StatusNotFound, err)
		return
	}
	resp := fileResp{Path: path, Size: fi.Size(), Mtime: fi.ModTime().UnixMilli(), Rel: s.displayPath(p, path), Branch: gitBranch(filepath.Dir(path))}
	if fi.IsDir() {
		httpErr(w, http.StatusBadRequest, errors.New("is a directory"))
		return
	}
	if fi.Size() > maxFileSize {
		resp.Binary = true
		resp.Content = fmt.Sprintf("File too large to display (%d bytes)", fi.Size())
		writeJSON(w, resp)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data[:min(len(data), 8000)]), 0) {
		resp.Binary = true
		resp.Content = fmt.Sprintf("Binary file (%d bytes)", fi.Size())
	} else {
		resp.Content = string(data)
	}
	writeJSON(w, resp)
}

// displayPath gives a project-relative path, or a GOROOT/module-cache relative one.
func (s *server) displayPath(p *project, path string) string {
	if rel, err := filepath.Rel(p.cfg.Path, path); err == nil && !strings.HasPrefix(rel, "..") {
		return rel
	}
	if len(s.readRoots) > 0 && s.readRoots[0] != "" {
		if rel, err := filepath.Rel(filepath.Join(s.readRoots[0], "src"), path); err == nil && !strings.HasPrefix(rel, "..") {
			return "<GOROOT>/" + rel
		}
	}
	if len(s.readRoots) > 1 && s.readRoots[1] != "" {
		if rel, err := filepath.Rel(s.readRoots[1], path); err == nil && !strings.HasPrefix(rel, "..") {
			return "<GOMODCACHE>/" + rel
		}
	}
	return path
}

func gitBranch(dir string) string {
	for d := dir; ; d = filepath.Dir(d) {
		g := filepath.Join(d, ".git")
		fi, err := os.Stat(g)
		if err == nil {
			gitDir := g
			if !fi.IsDir() {
				data, err := os.ReadFile(g)
				if err != nil {
					return ""
				}
				gitDir = strings.TrimSpace(strings.TrimPrefix(string(data), "gitdir:"))
				if !filepath.IsAbs(gitDir) {
					gitDir = filepath.Join(d, gitDir)
				}
			}
			head, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
			if err != nil {
				return ""
			}
			h := strings.TrimSpace(string(head))
			if ref, ok := strings.CutPrefix(h, "ref: refs/heads/"); ok {
				return ref
			}
			if len(h) > 8 {
				return h[:8]
			}
			return h
		}
		if d == filepath.Dir(d) {
			return ""
		}
	}
}

// ---- gopls-backed endpoints ----

func (s *server) handleSemantic(w http.ResponseWriter, r *http.Request) {
	if !isGoFile(r.FormValue("path")) {
		writeJSON(w, map[string]any{})
		return
	}
	l, path, ok := s.lspFor(w, r)
	if !ok {
		return
	}
	ctx, cancel := reqCtx(r, 90*time.Second)
	defer cancel()
	var res struct {
		Data []int `json:"data"`
	}
	if err := l.call(ctx, path, "textDocument/semanticTokens/full", map[string]any{"textDocument": map[string]any{"uri": pathToURI(path)}}, &res); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"legend": l.legend, "data": res.Data})
}

func (s *server) handleHints(w http.ResponseWriter, r *http.Request) {
	if !isGoFile(r.FormValue("path")) {
		writeJSON(w, []any{})
		return
	}
	l, path, ok := s.lspFor(w, r)
	if !ok {
		return
	}
	ctx, cancel := reqCtx(r, 90*time.Second)
	defer cancel()
	var raw []struct {
		Position     lspPos          `json:"position"`
		Label        json.RawMessage `json:"label"`
		Kind         int             `json:"kind"`
		PaddingLeft  bool            `json:"paddingLeft"`
		PaddingRight bool            `json:"paddingRight"`
	}
	data, err := os.ReadFile(path)
	if err != nil {
		httpErr(w, http.StatusNotFound, err)
		return
	}
	params := map[string]any{"textDocument": map[string]any{"uri": pathToURI(path)}, "range": map[string]any{"start": lspPos{0, 0}, "end": lspPos{strings.Count(string(data), "\n") + 1, 0}}}
	if err := l.call(ctx, path, "textDocument/inlayHint", params, &raw); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	type hint struct {
		Line  int    `json:"line"`
		Char  int    `json:"char"`
		Label string `json:"label"`
	}
	res := []hint{}
	for _, h := range raw {
		var label string
		if json.Unmarshal(h.Label, &label) != nil {
			var parts []struct {
				Value string `json:"value"`
			}
			_ = json.Unmarshal(h.Label, &parts)
			for _, p := range parts {
				label += p.Value
			}
		}
		res = append(res, hint{h.Position.Line, h.Position.Character, strings.TrimSpace(label)})
	}
	writeJSON(w, res)
}

type lspPos struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

type lspRange struct {
	Start lspPos `json:"start"`
	End   lspPos `json:"end"`
}

type symbolOut struct {
	Name   string `json:"name"`
	Detail string `json:"detail"`
	Kind   int    `json:"kind"`
	Depth  int    `json:"depth"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Line   int    `json:"line"`
	Char   int    `json:"char"`
}

type docSymbol struct {
	Name           string      `json:"name"`
	Detail         string      `json:"detail"`
	Kind           int         `json:"kind"`
	Range          lspRange    `json:"range"`
	SelectionRange lspRange    `json:"selectionRange"`
	Children       []docSymbol `json:"children"`
}

func (s *server) handleSymbols(w http.ResponseWriter, r *http.Request) {
	if !isGoFile(r.FormValue("path")) {
		writeJSON(w, []any{})
		return
	}
	l, path, ok := s.lspFor(w, r)
	if !ok {
		return
	}
	ctx, cancel := reqCtx(r, 90*time.Second)
	defer cancel()
	var raw []docSymbol
	if err := l.call(ctx, path, "textDocument/documentSymbol", map[string]any{"textDocument": map[string]any{"uri": pathToURI(path)}}, &raw); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	res := []symbolOut{}
	var walk func(syms []docSymbol, depth int)
	walk = func(syms []docSymbol, depth int) {
		for _, d := range syms {
			res = append(res, symbolOut{d.Name, d.Detail, d.Kind, depth, d.Range.Start.Line, d.Range.End.Line, d.SelectionRange.Start.Line, d.SelectionRange.Start.Character})
			walk(d.Children, depth+1)
		}
	}
	walk(raw, 0)
	writeJSON(w, res)
}

type locOut struct {
	Path    string `json:"path"`
	Rel     string `json:"rel"`
	Line    int    `json:"line"`
	Char    int    `json:"char"`
	EndChar int    `json:"endChar"`
	Text    string `json:"text,omitempty"`
}

type rawLocation struct {
	URI                  string    `json:"uri"`
	Range                *lspRange `json:"range"`
	TargetURI            string    `json:"targetUri"`
	TargetSelectionRange *lspRange `json:"targetSelectionRange"`
}

func (s *server) parseLocations(p *project, raw json.RawMessage) []locOut {
	var list []rawLocation
	if json.Unmarshal(raw, &list) != nil {
		var one rawLocation
		if json.Unmarshal(raw, &one) != nil {
			return nil
		}
		list = []rawLocation{one}
	}
	res := []locOut{}
	for _, l := range list {
		uri, rng := l.URI, l.Range
		if l.TargetURI != "" {
			uri, rng = l.TargetURI, l.TargetSelectionRange
		}
		if uri == "" || rng == nil {
			continue
		}
		path := uriToPath(uri)
		end := rng.End.Character
		if rng.End.Line != rng.Start.Line {
			end = rng.Start.Character
		}
		res = append(res, locOut{Path: path, Rel: s.displayPath(p, path), Line: rng.Start.Line, Char: rng.Start.Character, EndChar: end})
	}
	return res
}

func (s *server) handleLocations(method string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := s.project(r)
		if err != nil {
			httpErr(w, http.StatusBadRequest, err)
			return
		}
		l, path, ok := s.lspFor(w, r)
		if !ok {
			return
		}
		_, line, char, err := posParams(r)
		if err != nil {
			httpErr(w, http.StatusBadRequest, err)
			return
		}
		ctx, cancel := reqCtx(r, 90*time.Second)
		defer cancel()
		var raw json.RawMessage
		if err := l.call(ctx, path, method, textDocPos(path, line, char), &raw); err != nil {
			httpErr(w, http.StatusBadGateway, err)
			return
		}
		locs := s.parseLocations(p, raw)
		addLineText(locs)
		writeJSON(w, locs)
	}
}

func (s *server) handleReferences(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	l, path, ok := s.lspFor(w, r)
	if !ok {
		return
	}
	_, line, char, err := posParams(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := reqCtx(r, 3*time.Minute)
	defer cancel()
	params := textDocPos(path, line, char)
	params["context"] = map[string]any{"includeDeclaration": r.FormValue("decl") == "1"}
	var raw json.RawMessage
	if err := l.call(ctx, path, "textDocument/references", params, &raw); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	locs := s.parseLocations(p, raw)
	sort.Slice(locs, func(i, j int) bool {
		if locs[i].Path != locs[j].Path {
			return locs[i].Path < locs[j].Path
		}
		if locs[i].Line != locs[j].Line {
			return locs[i].Line < locs[j].Line
		}
		return locs[i].Char < locs[j].Char
	})
	addLineText(locs)
	writeJSON(w, locs)
}

// addLineText fills in the source line of each location (for the usages pane).
func addLineText(locs []locOut) {
	cache := map[string][]string{}
	for i := range locs {
		lines, ok := cache[locs[i].Path]
		if !ok {
			data, err := os.ReadFile(locs[i].Path)
			if err == nil {
				lines = strings.Split(string(data), "\n")
			}
			cache[locs[i].Path] = lines
		}
		if locs[i].Line < len(lines) {
			t := strings.TrimRight(lines[locs[i].Line], "\r")
			if utf16Len(t) > 400 {
				t = string([]rune(t)[:400])
			}
			locs[i].Text = t
		}
	}
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

func (s *server) handleHover(w http.ResponseWriter, r *http.Request) {
	l, path, ok := s.lspFor(w, r)
	if !ok {
		return
	}
	_, line, char, err := posParams(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	var res struct {
		Contents json.RawMessage `json:"contents"`
	}
	if err := l.call(ctx, path, "textDocument/hover", textDocPos(path, line, char), &res); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	var mc struct {
		Value string `json:"value"`
	}
	_ = json.Unmarshal(res.Contents, &mc)
	writeJSON(w, map[string]string{"markdown": mc.Value})
}

func (s *server) handleWorkspaceSymbols(w http.ResponseWriter, r *http.Request) {
	p, err := s.project(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	l, err := p.gopls()
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	ctx, cancel := reqCtx(r, 30*time.Second)
	defer cancel()
	var raw []struct {
		Name          string      `json:"name"`
		Kind          int         `json:"kind"`
		ContainerName string      `json:"containerName"`
		Location      rawLocation `json:"location"`
	}
	if err := l.call(ctx, "", "workspace/symbol", map[string]any{"query": r.FormValue("q")}, &raw); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	type symOut struct {
		Name      string `json:"name"`
		Kind      int    `json:"kind"`
		Container string `json:"container"`
		locOut
	}
	res := []symOut{}
	for _, sym := range raw {
		if sym.Location.Range == nil {
			continue
		}
		path := uriToPath(sym.Location.URI)
		res = append(res, symOut{sym.Name, sym.Kind, sym.ContainerName, locOut{Path: path, Rel: s.displayPath(p, path), Line: sym.Location.Range.Start.Line, Char: sym.Location.Range.Start.Character}})
		if len(res) >= 100 {
			break
		}
	}
	writeJSON(w, res)
}

// ---- gopls lifecycle ----

// limitGopls stops the least recently used gopls instances beyond maxGopls.
func (s *server) limitGopls(keep *project) {
	s.mu.Lock()
	var running []*project
	for _, p := range s.projects {
		if p != keep && p.goplsIfRunning() != nil {
			running = append(running, p)
		}
	}
	s.mu.Unlock()
	sort.Slice(running, func(i, j int) bool { return running[i].goplsIfRunning().idle() > running[j].goplsIfRunning().idle() })
	for len(running) >= maxGopls {
		running[0].stopGopls()
		running = running[1:]
	}
}

func (s *server) reaper() {
	for range time.Tick(time.Minute) {
		s.mu.Lock()
		var idle []*project
		for _, p := range s.projects {
			if l := p.goplsIfRunning(); l != nil && l.idle() > goplsIdleLimit {
				idle = append(idle, p)
			}
		}
		s.mu.Unlock()
		for _, p := range idle {
			p.stopGopls()
		}
	}
}

func (s *server) handleHighlights(w http.ResponseWriter, r *http.Request) {
	if !isGoFile(r.FormValue("path")) {
		writeJSON(w, []any{})
		return
	}
	l, path, ok := s.lspFor(w, r)
	if !ok {
		return
	}
	_, line, char, err := posParams(r)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	ctx, cancel := reqCtx(r, 15*time.Second)
	defer cancel()
	var raw []struct {
		Range lspRange `json:"range"`
		Kind  int      `json:"kind"`
	}
	if err := l.call(ctx, path, "textDocument/documentHighlight", textDocPos(path, line, char), &raw); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	type hl struct {
		Line    int `json:"line"`
		Char    int `json:"char"`
		EndChar int `json:"endChar"`
		Kind    int `json:"kind"`
	}
	res := []hl{}
	for _, h := range raw {
		if h.Range.Start.Line == h.Range.End.Line {
			res = append(res, hl{h.Range.Start.Line, h.Range.Start.Character, h.Range.End.Character, h.Kind})
		}
	}
	writeJSON(w, res)
}
