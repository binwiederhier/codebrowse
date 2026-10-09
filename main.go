// Command codebrowse is a small, read-only, IntelliJ-flavoured Go code browser.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed web
var webFS embed.FS

func main() {
	if len(os.Args) > 1 && os.Args[1] == "tour" {
		if err := runTour(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	cfgPath := flag.String("config", defaultConfigPath(), "config file")
	printPassword := flag.Bool("print-password", false, "print the login password and exit")
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		slog.Error("cannot load config", "error", err)
		os.Exit(1)
	}
	if *printPassword {
		fmt.Println(cfg.Password)
		return
	}
	goroot, modcache := goEnv()
	s := &server{cfg: cfg, projects: map[string]*project{}, readRoots: []string{goroot, modcache}}
	for _, p := range cfg.Projects {
		s.projects[p.ID] = newProject(p, s)
	}
	s.discover()
	go s.discoverLoop()
	go s.reaper()
	static, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	s.routes(mux, http.FileServerFS(static))
	slog.Info("listening", "addr", cfg.Listen, "config", *cfgPath)
	if err := http.ListenAndServe(cfg.Listen, s.auth(mux)); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func goEnv() (goroot, modcache string) {
	out, err := exec.Command("go", "env", "GOROOT", "GOMODCACHE").Output()
	if err != nil {
		slog.Warn("go env failed, stdlib navigation disabled", "error", err)
		return "", ""
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(parts) < 2 {
		return "", ""
	}
	return parts[0], parts[1]
}

func defaultConfigPath() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "codebrowse", "config.json")
}
