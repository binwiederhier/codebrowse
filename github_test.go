package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParsePRRef(t *testing.T) {
	want := &prRef{Owner: "binwiederhier", Repo: "ntfy", Number: 123}
	for _, s := range []string{
		"https://github.com/binwiederhier/ntfy/pull/123",
		"https://github.com/binwiederhier/ntfy/pull/123/files",
		"https://github.com/binwiederhier/ntfy/pull/123#discussion_r1",
		"github.com/binwiederhier/ntfy/pull/123",
		"binwiederhier/ntfy#123",
		"binwiederhier/ntfy/123",
		"binwiederhier/ntfy/pull/123",
		"  binwiederhier/ntfy#123\n",
	} {
		got, err := parsePRRef(s)
		if err != nil || *got != *want {
			t.Errorf("%q: got %+v, %v", s, got, err)
		}
	}
	for _, s := range []string{"", "ntfy#123", "binwiederhier/ntfy", "binwiederhier/ntfy#0", "../x/y#1", "a/../b#1", "-x/y#1", "a/b#12x", "https://evil.com/a/b/pull/1"} {
		if got, err := parsePRRef(s); err == nil {
			t.Errorf("%q: got %+v, want an error", s, got)
		}
	}
}

// gitOut runs git in dir and returns its trimmed output.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// newPRRemote stands in for github.com: <root>/owner/repo.git has main and refs/pull/7/head,
// a feature branch that changed line 2 of a.go, while main moved on after the branch point.
func newPRRemote(t *testing.T) (root, work string) {
	t.Helper()
	work = newRepo(t, map[string]string{"a.go": "1\n2\n3\n"})
	git(t, work, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(work, "a.go"), "1\nTWO\n3\n")
	git(t, work, "commit", "-q", "-am", "feature")
	git(t, work, "checkout", "-q", "main")
	writeFile(t, filepath.Join(work, "b.go"), "later\n")
	git(t, work, "add", "b.go")
	git(t, work, "commit", "-q", "-m", "main moves on")
	root = t.TempDir()
	git(t, root, "init", "-q", "--bare", filepath.Join(root, "owner", "repo.git"))
	git(t, work, "push", "-q", filepath.Join(root, "owner", "repo.git"), "main", "feature:refs/pull/7/head")
	return root, work
}

// newGitHubAPI serves the PR endpoint like api.github.com, for PR 7 of owner/repo.
func newGitHubAPI(t *testing.T, work string) *httptest.Server {
	t.Helper()
	head, base := gitOut(t, work, "rev-parse", "feature"), gitOut(t, work, "rev-parse", "main")
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/owner/repo/pulls/7" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "bad token", http.StatusUnauthorized)
			return
		}
		fmt.Fprintf(w, `{"number":7,"title":"Fix it","state":"open","html_url":"https://github.com/owner/repo/pull/7","user":{"login":"phil"},"head":{"ref":"feature","sha":%q},"base":{"ref":"main","sha":%q}}`, head, base)
	}))
	t.Cleanup(api.Close)
	return api
}

func useGitHub(t *testing.T, api, gitRoot string) {
	t.Helper()
	oldAPI, oldGit := githubAPI, githubGit
	githubAPI, githubGit = api, "file://"+gitRoot
	t.Cleanup(func() { githubAPI, githubGit = oldAPI, oldGit })
}

func TestFetchPR(t *testing.T) {
	gitEnv(t)
	_, work := newPRRemote(t)
	api := newGitHubAPI(t, work)
	useGitHub(t, api.URL, "")
	m, err := fetchPR(context.Background(), "tok", &prRef{Owner: "owner", Repo: "repo", Number: 7})
	if err != nil || m.Title != "Fix it" || m.Author != "phil" || m.HeadRef != "feature" || m.BaseRef != "main" || m.URL != "https://github.com/owner/repo/pull/7" {
		t.Fatalf("got %+v, %v", m, err)
	}
	if _, err := fetchPR(context.Background(), "tok", &prRef{Owner: "owner", Repo: "repo", Number: 8}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing PR: %v", err)
	}
	if _, err := fetchPR(context.Background(), "wrong", &prRef{Owner: "owner", Repo: "repo", Number: 7}); err == nil {
		t.Fatal("a bad token passed")
	}
}

func TestCheckoutPR(t *testing.T) {
	gitEnv(t)
	gitRoot, work := newPRRemote(t)
	useGitHub(t, "", gitRoot)
	cache := t.TempDir()
	m := &prMeta{Owner: "owner", Repo: "repo", Number: 7, BaseRef: "main"}
	dir, err := checkoutPR(context.Background(), "", cache, m)
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(cache, "owner", "repo", "pr-7") || gitOut(t, dir, "rev-parse", "HEAD") != gitOut(t, work, "rev-parse", "feature") {
		t.Fatalf("dir %s at %s", dir, gitOut(t, dir, "rev-parse", "HEAD"))
	}
	if m.HeadSHA != gitOut(t, work, "rev-parse", "feature") || m.BaseSHA != gitOut(t, work, "rev-parse", "main") {
		t.Fatalf("got %+v", m)
	}

	// A new push to the PR moves the checkout along
	git(t, work, "checkout", "-q", "feature")
	writeFile(t, filepath.Join(work, "a.go"), "1\nTWO\nTHREE\n")
	git(t, work, "commit", "-q", "-am", "more")
	git(t, work, "push", "-q", "-f", filepath.Join(gitRoot, "owner", "repo.git"), "feature:refs/pull/7/head")
	if _, err := checkoutPR(context.Background(), "", cache, m); err != nil {
		t.Fatal(err)
	}
	if got := gitOut(t, dir, "rev-parse", "HEAD"); got != gitOut(t, work, "rev-parse", "feature") || m.HeadSHA != got {
		t.Fatalf("checkout at %s, meta %s", got, m.HeadSHA)
	}
}

func TestCheckoutPR_MergedKeepsItsBase(t *testing.T) {
	gitEnv(t)
	gitRoot, work := newPRRemote(t)
	useGitHub(t, "", gitRoot)
	oldBase := gitOut(t, work, "rev-parse", "main")

	// Once merged, main contains the PR; GitHub keeps reporting the base it had
	git(t, work, "merge", "-q", "--no-edit", "feature")
	git(t, work, "push", "-q", filepath.Join(gitRoot, "owner", "repo.git"), "main")
	m := &prMeta{Owner: "owner", Repo: "repo", Number: 7, BaseRef: "main", BaseSHA: oldBase}
	if _, err := checkoutPR(context.Background(), "", t.TempDir(), m); err != nil {
		t.Fatal(err)
	}
	if m.BaseSHA != oldBase {
		t.Fatalf("base %s, want the PR's %s", m.BaseSHA, oldBase)
	}
}

func TestCheckoutPR_RejectsOddBaseRef(t *testing.T) {
	gitEnv(t)
	gitRoot, _ := newPRRemote(t)
	useGitHub(t, "", gitRoot)
	for _, ref := range []string{"-x", "a:b", "main..x", ""} {
		if _, err := checkoutPR(context.Background(), "", t.TempDir(), &prMeta{Owner: "owner", Repo: "repo", Number: 7, BaseRef: ref}); err == nil {
			t.Errorf("base ref %q: no error", ref)
		}
	}
}

func TestGitAuthEnv(t *testing.T) {
	if env := gitAuthEnv(""); len(env) != 1 || env[0] != "GIT_TERMINAL_PROMPT=0" {
		t.Fatalf("no token: %v", env)
	}
	env := strings.Join(gitAuthEnv("tok"), "\n")
	// base64("x-access-token:tok")
	if !strings.Contains(env, "GIT_CONFIG_VALUE_0=Authorization: Basic eC1hY2Nlc3MtdG9rZW46dG9r") || !strings.Contains(env, "GIT_CONFIG_KEY_0=http.https://github.com/.extraheader") {
		t.Fatalf("got %s", env)
	}
}

func newPRServer(t *testing.T) (*server, *http.ServeMux, string) {
	t.Helper()
	gitEnv(t)
	gitRoot, work := newPRRemote(t)
	useGitHub(t, newGitHubAPI(t, work).URL, gitRoot)
	s := &server{cfg: &config{GitHubToken: "tok", path: filepath.Join(t.TempDir(), "config.json")}, projects: map[string]*project{}, githubDir: t.TempDir()}
	mux := http.NewServeMux()
	s.routes(mux, http.NotFoundHandler())
	return s, mux, work
}

func openPRRequest(t *testing.T, mux *http.ServeMux, ref string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/api/github/pr", strings.NewReader(`{"ref":`+fmt.Sprintf("%q", ref)+`}`)))
	return rec
}

func TestHandleOpenPR(t *testing.T) {
	s, mux, _ := newPRServer(t)
	rec := openPRRequest(t, mux, "https://github.com/owner/repo/pull/7")
	if rec.Code != http.StatusOK {
		t.Fatalf("code %d: %s", rec.Code, rec.Body)
	}
	var pc projectConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &pc); err != nil || pc.PR == nil || pc.PR.Number != 7 || pc.Name != "repo#7" {
		t.Fatalf("got %+v, %v", pc, err)
	}

	// The diff is the PR's: only the feature change, labelled with the base branch
	p := s.projects[pc.ID]
	p.index() // finds the repo, as opening the project would
	ch := p.changes("whatever", true)
	if ch.Base != "main" || len(ch.Files) != 1 || ch.Files[0].Rel != "a.go" || runsString(ch.Files[0].Changes) != "[{mod 1 1}]" {
		t.Fatalf("changes %+v", ch)
	}
	if b := p.branches(); len(b) != 0 {
		t.Fatalf("branches %v", b)
	}

	// Saved in the config; opening it again reuses the project
	if len(s.cfg.Projects) != 1 || s.cfg.Projects[0].PR == nil {
		t.Fatalf("config projects %+v", s.cfg.Projects)
	}
	if rec := openPRRequest(t, mux, "owner/repo#7"); rec.Code != http.StatusOK || len(s.projects) != 1 {
		t.Fatalf("reopen: code %d, %d projects", rec.Code, len(s.projects))
	}

	// Removing it deletes the checkout
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/projects?project="+pc.ID, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(pc.Path); !os.IsNotExist(err) {
		t.Fatalf("checkout still there: %v", err)
	}
}

func TestHandleOpenPR_Errors(t *testing.T) {
	_, mux, _ := newPRServer(t)
	if rec := openPRRequest(t, mux, "nonsense"); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad ref: code %d", rec.Code)
	}
	if rec := openPRRequest(t, mux, "owner/repo#8"); rec.Code != http.StatusNotFound {
		t.Fatalf("missing PR: code %d", rec.Code)
	}
}

func TestHandleGitHubLink(t *testing.T) {
	_, mux, _ := newTestServer(t)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/gh/binwiederhier/ntfy/pull/123/files", nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/#gh=binwiederhier/ntfy/123" {
		t.Fatalf("code %d, location %q", rec.Code, rec.Header().Get("Location"))
	}
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/gh/nonsense", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad link: code %d", rec.Code)
	}
}

func TestGitHubToken(t *testing.T) {
	s := &server{cfg: &config{GitHubToken: "from-config"}}
	if got := s.githubToken(httptest.NewRequest("GET", "/", nil)); got != "from-config" {
		t.Fatalf("got %q", got)
	}
}
