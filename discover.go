package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const discoverInterval = 30 * time.Second

// defaultDiscover lists the globs whose matching directories become projects automatically,
// e.g. "~/src/*". Empty by default; set "discover" in the config file.
var defaultDiscover = []string{}

func expandHome(p string) string {
	if p == "~" {
		return os.Getenv("HOME")
	}
	if rest, ok := strings.CutPrefix(p, "~/"); ok {
		return filepath.Join(os.Getenv("HOME"), rest)
	}
	return p
}

func (s *server) discoverLoop() {
	for {
		s.discover()
		time.Sleep(discoverInterval)
	}
}

// discover adds a project for each directory matching the discover globs, and drops
// auto projects whose directory disappeared.
func (s *server) discover() {
	found := map[string]bool{}
	for _, pattern := range s.cfg.Discover {
		matches, _ := filepath.Glob(expandHome(pattern))
		for _, m := range matches {
			if fi, err := os.Stat(m); err == nil && fi.IsDir() && !strings.HasPrefix(filepath.Base(m), ".") {
				found[filepath.Clean(m)] = true
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	known := map[string]bool{}
	for id, p := range s.projects {
		if p.cfg.Auto && (!found[p.cfg.Path] || slices.Contains(s.cfg.Hidden, p.cfg.Path)) {
			slog.Info("dropping discovered project", "id", id, "path", p.cfg.Path)
			p.stop()
			delete(s.projects, id)
			continue
		}
		known[p.cfg.Path] = true
	}
	for path := range found {
		if known[path] || slices.Contains(s.cfg.Hidden, path) {
			continue
		}
		pc := &projectConfig{ID: s.uniqueID(filepath.Base(path)), Name: filepath.Base(path), Path: path, Auto: true}
		s.projects[pc.ID] = newProject(pc, s)
	}
}

// uniqueID must be called with s.mu held.
func (s *server) uniqueID(name string) string {
	id := slugify(name)
	for i := 2; s.projects[id] != nil; i++ {
		id = slugify(name) + "-" + strconv.Itoa(i)
	}
	return id
}
