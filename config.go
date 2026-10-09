package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

type projectConfig struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	ShowIgnored bool   `json:"show_ignored,omitempty"`
	Auto        bool   `json:"auto,omitempty"` // discovered, not persisted
}

type config struct {
	Listen    string           `json:"listen"`
	PublicURL string           `json:"public_url,omitempty"` // base URL in printed links, e.g. http://devbox:7878
	Password  string           `json:"password"`
	Secret    string           `json:"secret"`
	Projects  []*projectConfig `json:"projects"`
	Discover  []string         `json:"discover"` // globs; each matching directory becomes a project
	Hidden    []string         `json:"hidden"`   // discovered paths removed by the user

	mu   sync.Mutex
	path string
}

func loadConfig(path string) (*config, error) {
	c := &config{path: path}
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil {
		if err := json.Unmarshal(data, c); err != nil {
			return nil, err
		}
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:7878"
	}
	if c.Password == "" {
		c.Password = randomHex(8)
	}
	if c.Secret == "" {
		c.Secret = randomHex(32)
	}
	if c.Discover == nil {
		c.Discover = defaultDiscover
	}
	if c.Hidden == nil {
		c.Hidden = []string{}
	}
	if c.Projects == nil {
		c.Projects = []*projectConfig{}
	}
	return c, c.save()
}

func (c *config) save() error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if s == "" {
		s = "project"
	}
	return s
}
