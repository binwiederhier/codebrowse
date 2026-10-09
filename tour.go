package main

import (
	"bytes"
	"compress/flate"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type tourStep struct {
	Title string `json:"title,omitempty"`
	File  string `json:"file"`
	Lines string `json:"lines,omitempty"`
	Note  string `json:"note,omitempty"`
}

type tour struct {
	Title   string     `json:"title"`
	Project string     `json:"project,omitempty"`
	Steps   []tourStep `json:"steps"`
}

var rangeRe = regexp.MustCompile(`^L?(\d+)(?:-L?(\d+))?$`)

// runTour implements `codebrowse tour`: it reads a walkthrough as JSON on stdin, checks that every
// file and line range exists, and prints a link that opens it.
func runTour(args []string) error {
	fs := flag.NewFlagSet("tour", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfigPath(), "config file")
	noSave := fs.Bool("no-save", false, "don't add the tour to the Walkthroughs list in the UI")
	base := fs.String("base", "", "base URL of the codebrowse server (default: public_url from the config)")
	projectFlag := fs.String("project", "", "project id, name or path (default: the \"project\" field, or inferred from the file paths)")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "Usage: codebrowse tour [flags] < tour.json\n\nPrints a link that opens the walkthrough in codebrowse.\n\n")
		fs.PrintDefaults()
	}
	_ = fs.Parse(args)
	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		return err
	}
	var t tour
	dec := json.NewDecoder(os.Stdin)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil {
		return fmt.Errorf("invalid tour JSON: %w", err)
	}
	if *projectFlag != "" {
		t.Project = *projectFlag
	}
	if len(t.Steps) == 0 {
		return errors.New("tour has no steps")
	}
	s := &server{cfg: cfg, projects: map[string]*project{}}
	for _, p := range cfg.Projects {
		s.projects[p.ID] = newProject(p, s)
	}
	s.discover()
	p := s.tourProject(&t)
	if p == nil {
		return errors.New("cannot determine the project: set \"project\" (id, name or path) or use absolute file paths inside a project")
	}
	t.Project = p.ID
	var problems []string
	for i := range t.Steps {
		st := &t.Steps[i]
		if msg := checkStep(p.Path, st); msg != "" {
			problems = append(problems, fmt.Sprintf("step %d (%s): %s", i+1, st.Title, msg))
		}
	}
	if len(problems) > 0 {
		return errors.New("invalid tour:\n  " + strings.Join(problems, "\n  "))
	}
	data, _ := json.Marshal(t)
	var buf bytes.Buffer
	w, _ := flate.NewWriter(&buf, flate.BestCompression)
	_, _ = w.Write(data)
	_ = w.Close()
	baseURL := strings.TrimRight(*base, "/")
	if baseURL == "" {
		baseURL = cfg.baseURL()
	}
	encoded := base64.RawURLEncoding.EncodeToString(buf.Bytes())
	if !*noSave {
		if _, err := saveTour(cfg, &t, encoded); err != nil {
			fmt.Fprintf(os.Stderr, "warning: cannot save tour: %v\n", err)
		}
	}
	fmt.Printf("%s/#tour=%s\n", baseURL, encoded)
	fmt.Fprintf(os.Stderr, "%q: %d steps in project %s\n", t.Title, len(t.Steps), p.ID)
	return nil
}

// tourProject finds the project by id, name or path, else by the absolute file paths.
func (s *server) tourProject(t *tour) *projectConfig {
	if t.Project != "" {
		want := strings.TrimRight(expandHome(t.Project), "/")
		for _, p := range s.projects {
			if p.cfg.ID == want || p.cfg.Name == want || p.cfg.Path == want {
				return p.cfg
			}
		}
		return nil
	}
	var best *projectConfig
	for _, st := range t.Steps {
		if !filepath.IsAbs(st.File) {
			continue
		}
		for _, p := range s.projects {
			if strings.HasPrefix(st.File, p.cfg.Path+"/") && (best == nil || len(p.cfg.Path) > len(best.Path)) {
				best = p.cfg
			}
		}
	}
	return best
}

// checkStep validates the file and line ranges of a step, and rewrites the file
// relative to the project root when possible (shorter links).
func checkStep(root string, st *tourStep) string {
	if st.File == "" {
		return "missing \"file\""
	}
	path := st.File
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Sprintf("cannot read %s", path)
	}
	if rel, err := filepath.Rel(root, path); err == nil && !strings.HasPrefix(rel, "..") {
		st.File = rel
	}
	n := bytes.Count(data, []byte("\n"))
	if len(data) > 0 && data[len(data)-1] != '\n' {
		n++
	}
	if st.Lines == "" {
		return ""
	}
	for _, part := range strings.Split(st.Lines, ",") {
		m := rangeRe.FindStringSubmatch(strings.TrimSpace(part))
		if m == nil {
			return fmt.Sprintf("bad lines %q, want e.g. \"42\", \"10-20\" or \"10-20,31\"", st.Lines)
		}
		a, _ := strconv.Atoi(m[1])
		b := a
		if m[2] != "" {
			b, _ = strconv.Atoi(m[2])
		}
		if a < 1 || b < a || b > n {
			return fmt.Sprintf("lines %q out of range, %s has %d lines", part, filepath.Base(path), n)
		}
	}
	return ""
}

func (c *config) baseURL() string {
	if c.PublicURL != "" {
		return strings.TrimRight(c.PublicURL, "/")
	}
	host, port, found := strings.Cut(c.Listen, ":")
	if !found {
		return "http://" + c.Listen
	}
	if host == "" || host == "0.0.0.0" {
		if h, err := os.Hostname(); err == nil {
			host = h
		}
	}
	return "http://" + host + ":" + port
}
