package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	githubAPITimeout = 20 * time.Second
	prCheckoutLimit  = 15 * time.Minute // the first fetch of a large repo can take a while
)

var (
	// Overridden in tests
	githubAPI = "https://api.github.com"
	githubGit = "https://github.com"

	// prRefRe matches PR links and short forms: owner/repo#123, owner/repo/123, owner/repo/pull/123
	prRefRe       = regexp.MustCompile(`^(?:(?:https?://)?github\.com/)?([^/#\s]+)/([^/#\s]+)(?:/pulls?/|#|/)([0-9]+)(?:[/?#].*)?$`)
	githubOwnerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*$`)
	githubRepoRe  = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]*$`)

	errPRNotFound = errors.New("not found")
)

// prRef names a pull request.
type prRef struct {
	Owner, Repo string
	Number      int
}

// prMeta describes a checked-out pull request; it is saved with its project.
type prMeta struct {
	Owner   string `json:"owner"`
	Repo    string `json:"repo"`
	Number  int    `json:"number"`
	Title   string `json:"title"`
	URL     string `json:"url"`
	Author  string `json:"author"`
	State   string `json:"state"`
	HeadRef string `json:"head_ref"`
	HeadSHA string `json:"head_sha"` // as fetched
	BaseRef string `json:"base_ref"`
	BaseSHA string `json:"base_sha"` // the base GitHub reports, else the base branch as fetched; the diff is against its merge-base
}

// handleOpenPR fetches a pull request and checks it out as a project, or updates the checkout if
// it is open already. The body is {"ref": "<PR link or owner/repo#n>"}.
func (s *server) handleOpenPR(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Ref string `json:"ref"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	ref, err := parsePRRef(req.Ref)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	// A reload in the browser must not abort a long first fetch half way
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), prCheckoutLimit)
	defer cancel()
	pc, err := s.openPR(ctx, s.githubToken(r), ref)
	if errors.Is(err, errPRNotFound) {
		httpErr(w, http.StatusNotFound, err)
		return
	} else if err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, pc)
}

// handleGitHubLink turns /gh/<owner>/<repo>/pull/<n> (a github.com PR link with the host swapped)
// into a link the web app opens the PR from.
func (s *server) handleGitHubLink(w http.ResponseWriter, r *http.Request) {
	ref, err := parsePRRef(strings.TrimPrefix(r.URL.Path, "/gh/"))
	if err != nil {
		httpErr(w, http.StatusBadRequest, err)
		return
	}
	http.Redirect(w, r, fmt.Sprintf("/#gh=%s/%s/%d", ref.Owner, ref.Repo, ref.Number), http.StatusFound)
}

// githubToken is the token GitHub requests are made with: the config's github_token, else the
// one the gh CLI is signed in with, else none (public repos only). With GitHub sign-in, this is
// where the signed-in user's token will come from.
func (s *server) githubToken(r *http.Request) string {
	if s.cfg.GitHubToken != "" {
		return s.cfg.GitHubToken
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// openPR fetches and checks out a pull request, and adds it as a project or updates its project.
func (s *server) openPR(ctx context.Context, token string, ref *prRef) (*projectConfig, error) {
	// One at a time, so two opens of the same repo do not fetch into it concurrently
	s.prMu.Lock()
	defer s.prMu.Unlock()
	m, err := fetchPR(ctx, token, ref)
	if err != nil {
		return nil, err
	}
	dir, err := checkoutPR(ctx, token, s.githubDir, m)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.projects {
		if old := p.cfg.PR; old != nil && strings.EqualFold(old.Owner, m.Owner) && strings.EqualFold(old.Repo, m.Repo) && old.Number == m.Number {
			p.cfg.PR, p.cfg.Path = m, dir
			if err := s.cfg.save(); err != nil {
				return nil, err
			}
			p.reindex()
			return p.cfg, nil
		}
	}
	n := strconv.Itoa(m.Number)
	pc := &projectConfig{ID: s.uniqueID(m.Repo + "-pr-" + n), Name: m.Repo + "#" + n, Path: dir, PR: m}
	s.cfg.Projects = append(s.cfg.Projects, pc)
	if err := s.cfg.save(); err != nil {
		return nil, err
	}
	s.projects[pc.ID] = newProject(pc, s)
	slog.Info("opened pull request", "id", pc.ID, "pr", m.URL)
	return pc, nil
}

// removePRCheckout deletes a pull request's checkout and the refs fetched for it. It must be
// called with s.mu held.
func (s *server) removePRCheckout(m *prMeta) {
	bare, dir := prPaths(s.githubDir, m)
	if _, err := runGit(context.Background(), nil, bare, "worktree", "remove", "--force", dir); err != nil {
		_ = os.RemoveAll(dir)
		_, _ = runGit(context.Background(), nil, bare, "worktree", "prune")
	}
	for _, kind := range []string{"head", "base"} {
		_, _ = runGit(context.Background(), nil, bare, "update-ref", "-d", prRefName(m.Number, kind))
	}
}

// parsePRRef parses a pull request link or short form; owner and repo must be valid GitHub names.
func parsePRRef(s string) (*prRef, error) {
	m := prRefRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return nil, fmt.Errorf("not a pull request: %q (use a PR link or owner/repo#123)", s)
	}
	n, err := strconv.Atoi(m[3])
	if err != nil || n <= 0 || !githubOwnerRe.MatchString(m[1]) || !githubRepoRe.MatchString(m[2]) || m[2] == "." || m[2] == ".." {
		return nil, fmt.Errorf("not a pull request: %q", s)
	}
	return &prRef{Owner: m[1], Repo: m[2], Number: n}, nil
}

// fetchPR loads a pull request's details from the GitHub API.
func fetchPR(ctx context.Context, token string, ref *prRef) (*prMeta, error) {
	ctx, cancel := context.WithTimeout(ctx, githubAPITimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/repos/%s/%s/pulls/%d", githubAPI, ref.Owner, ref.Repo, ref.Number), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("%s/%s#%d %w; for a private repo, codebrowse needs a GitHub token (github_token in the config, or gh auth login)", ref.Owner, ref.Repo, ref.Number, errPRNotFound)
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("GitHub: %s", resp.Status)
	}
	var pr struct {
		Title   string `json:"title"`
		State   string `json:"state"`
		HTMLURL string `json:"html_url"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
		Head struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"base"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return nil, err
	}
	return &prMeta{
		Owner: ref.Owner, Repo: ref.Repo, Number: ref.Number,
		Title: pr.Title, URL: pr.HTMLURL, Author: pr.User.Login, State: pr.State,
		HeadRef: pr.Head.Ref, HeadSHA: pr.Head.SHA, BaseRef: pr.Base.Ref, BaseSHA: pr.Base.SHA,
	}, nil
}

// checkoutPR fetches a pull request's head and base branch into a bare cache repo shared by all
// PRs of the repo, and checks the head out into the PR's own worktree. It updates m's SHAs to
// what was checked out and diffed against, and returns the worktree.
func checkoutPR(ctx context.Context, token, cache string, m *prMeta) (string, error) {
	if m.BaseRef == "" || strings.HasPrefix(m.BaseRef, "-") {
		return "", fmt.Errorf("invalid base branch %q", m.BaseRef)
	}
	if _, err := runGit(ctx, nil, "", "check-ref-format", "refs/heads/"+m.BaseRef); err != nil {
		return "", fmt.Errorf("invalid base branch %q", m.BaseRef)
	}
	bare, dir := prPaths(cache, m)

	// Fetch into the shared bare repo
	if _, err := os.Stat(bare); err != nil {
		if err := os.MkdirAll(filepath.Dir(bare), 0o755); err != nil {
			return "", err
		}
		if _, err := runGit(ctx, nil, "", "init", "--bare", "-q", bare); err != nil {
			return "", err
		}
	}
	headRef, baseRef := prRefName(m.Number, "head"), prRefName(m.Number, "base")
	url := fmt.Sprintf("%s/%s/%s.git", githubGit, m.Owner, m.Repo)
	if _, err := runGit(ctx, gitAuthEnv(token), bare, "fetch", "--no-tags", "--quiet", url, fmt.Sprintf("+refs/pull/%d/head:%s", m.Number, headRef), "+refs/heads/"+m.BaseRef+":"+baseRef); err != nil {
		return "", err
	}
	head, err := runGit(ctx, nil, bare, "rev-parse", "--verify", headRef+"^{commit}")
	if err != nil {
		return "", err
	}
	// The base GitHub reports, if we have it: for a merged PR, the base branch has moved past it
	// and now contains the PR. Else the base branch as fetched.
	base := ""
	if m.BaseSHA != "" {
		base, _ = runGit(ctx, nil, bare, "rev-parse", "--verify", "--quiet", "--end-of-options", m.BaseSHA+"^{commit}")
	}
	if base == "" {
		if base, err = runGit(ctx, nil, bare, "rev-parse", "--verify", baseRef+"^{commit}"); err != nil {
			return "", err
		}
	}

	// Check out the head, detached; the checkout is read-only, so local changes are discarded
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		if _, err := runGit(ctx, nil, dir, "checkout", "--quiet", "--force", "--detach", head); err != nil {
			return "", err
		}
	} else {
		_ = os.RemoveAll(dir) // a leftover of a failed checkout
		_, _ = runGit(ctx, nil, bare, "worktree", "prune")
		if _, err := runGit(ctx, nil, bare, "worktree", "add", "--quiet", "--force", "--detach", dir, head); err != nil {
			return "", err
		}
	}
	m.HeadSHA, m.BaseSHA = head, base
	return dir, nil
}

// gitAuthEnv passes the token to git as an HTTP header for github.com, through the environment
// rather than the command line, where other users could read it.
func gitAuthEnv(token string) []string {
	env := []string{"GIT_TERMINAL_PROMPT=0"}
	if token == "" {
		return env
	}
	cred := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	return append(env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http."+githubGit+"/.extraheader", "GIT_CONFIG_VALUE_0=Authorization: Basic "+cred)
}

// prPaths are the bare cache repo of a PR's repository and the PR's worktree.
func prPaths(cache string, m *prMeta) (bare, dir string) {
	return filepath.Join(cache, m.Owner, m.Repo+".git"), filepath.Join(cache, m.Owner, m.Repo, "pr-"+strconv.Itoa(m.Number))
}

// prRefName is where a PR's head or base is fetched to in the bare repo.
func prRefName(number int, kind string) string {
	return fmt.Sprintf("refs/codebrowse/pr/%d/%s", number, kind)
}

// runGit runs git, in dir unless it is empty, and returns its trimmed output or an error with
// git's message.
func runGit(ctx context.Context, env []string, dir string, args ...string) (string, error) {
	full := args
	if dir != "" {
		full = append([]string{"-C", dir}, args...)
	}
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = append(os.Environ(), env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s: %v: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}
