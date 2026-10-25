package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// newRepo creates a git repo on branch main with one commit holding the given files.
func newRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	gitEnv(t)
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	for name, content := range files {
		writeFile(t, filepath.Join(dir, name), content)
	}
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "-m", "init")
	return dir
}

// gitEnv isolates git from the user's config and gives commits an author.
func gitEnv(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@example.com")
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestParseHunks(t *testing.T) {
	diff := "diff --git a/f b/f\n--- a/f\n+++ b/f\n" +
		"@@ -0,0 +1,2 @@\n+a\n+b\n" + // added at the top
		"@@ -5 +7 @@\n-x\n+y\n" + // one line changed
		"@@ -9,3 +10,0 @@\n-p\n-q\n-r\n" + // deleted below line 10
		"@@ -20,2 +21,4 @@\n-m\n-n\n+m\n+n\n+o\n+p\n" // changed block
	want := []lineChange{
		{Kind: "add", Start: 0, End: 1},
		{Kind: "mod", Start: 6, End: 6},
		{Kind: "del", Start: 9, End: 9},
		{Kind: "mod", Start: 20, End: 23},
	}
	if got := noIDs(parseHunks(diff)); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestParseHunks_DeletedAtTop(t *testing.T) {
	// A deletion is reported on the line above it; above the first line, that is -1
	if got := noIDs(parseHunks("@@ -1,2 +0,0 @@\n-a\n-b\n")); !reflect.DeepEqual(got, []lineChange{{Kind: "del", Start: -1, End: -1}}) {
		t.Fatalf("got %+v", got)
	}
}

// fileChanges returns the changes of one file from gitRepoChanges, or nil.
// noIDs drops the review IDs and old lines, for comparing line runs only.
func noIDs(changes []lineChange) []lineChange {
	res := make([]lineChange, len(changes))
	for i, c := range changes {
		res[i] = lineChange{Kind: c.Kind, Start: c.Start, End: c.End}
	}
	return res
}

// runsString formats line runs without their IDs, as "[{kind start end} ...]".
func runsString(changes []lineChange) string {
	runs := []string{}
	for _, c := range changes {
		runs = append(runs, fmt.Sprintf("{%s %d %d}", c.Kind, c.Start, c.End))
	}
	return "[" + strings.Join(runs, " ") + "]"
}

func TestParseHunks_IDs(t *testing.T) {
	// The ID follows the hunk's content, not its position or the function named in the header
	moved := parseHunks("@@ -5 +7 @@ func a()\n-x\n+y\n")[0].ID
	if moved == "" || moved != parseHunks("@@ -50 +90 @@ func b()\n-x\n+y\n")[0].ID {
		t.Fatalf("a moved hunk changed its ID: %q", moved)
	}
	if moved == parseHunks("@@ -5 +7 @@\n-x\n+z\n")[0].ID {
		t.Fatal("an edited hunk kept its ID")
	}
	// Identical hunks in one file still get distinct IDs
	twice := parseHunks("@@ -5 +5 @@\n-x\n+y\n@@ -9 +9 @@\n-x\n+y\n")
	if len(twice) != 2 || twice[0].ID == twice[1].ID {
		t.Fatalf("got %+v", twice)
	}
}

func TestParseHunks_OldLines(t *testing.T) {
	diff := "@@ -0,0 +1 @@\n+new\n" +
		"@@ -5,2 +7 @@ func a()\n-old1\n-old2\n+y\n" +
		"@@ -9 +9,0 @@\n-gone\n\\ No newline at end of file\n"
	got := parseHunks(diff)
	if len(got) != 3 || got[0].Old != nil || got[0].OldStart != 0 ||
		!reflect.DeepEqual(got[1].Old, []string{"old1", "old2"}) || got[1].OldStart != 4 ||
		!reflect.DeepEqual(got[2].Old, []string{"gone"}) || got[2].OldStart != 8 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseHunks_OldLinesCapped(t *testing.T) {
	diff := "@@ -1," + fmt.Sprint(maxOldLines+5) + " +1 @@\n" + strings.Repeat("-x\n", maxOldLines+5) + "+y\n"
	got := parseHunks(diff)
	if len(got[0].Old) != maxOldLines || got[0].OldMore != 5 {
		t.Fatalf("old %d, more %d", len(got[0].Old), got[0].OldMore)
	}
}

func TestGitRepoChanges_IgnoresWhitespace(t *testing.T) {
	dir := newRepo(t, map[string]string{"indent.go": "a\nb\nc\n", "both.go": "x\ny\nz\n"})
	writeFile(t, filepath.Join(dir, "indent.go"), "a\n\tb\nc\n")
	writeFile(t, filepath.Join(dir, "both.go"), "x\n  y\nZ\n")
	summary := func(rc *repoChanges) map[string]string {
		got := map[string]string{}
		for rel, d := range rc.Files {
			got[rel] = runsString(d.Changes)
		}
		return got
	}
	if got := summary(gitRepoChanges(dir, "", true)); !reflect.DeepEqual(got, map[string]string{"both.go": "[{mod 2 2}]"}) {
		t.Fatalf("ignoring whitespace: got %v", got)
	}
	if got := summary(gitRepoChanges(dir, "", false)); !reflect.DeepEqual(got, map[string]string{"indent.go": "[{mod 1 1}]", "both.go": "[{mod 1 2}]"}) {
		t.Fatalf("with whitespace: got %v", got)
	}
}

func TestGitRepoChanges_IDsSurviveUnrelatedEdits(t *testing.T) {
	lines := make([]string, 100)
	for i := range lines {
		lines[i] = fmt.Sprint(i)
	}
	dir := newRepo(t, map[string]string{"a.go": strings.Join(lines, "\n") + "\n"})
	lines[50] = "FIFTY"
	writeFile(t, filepath.Join(dir, "a.go"), strings.Join(lines, "\n")+"\n")
	_, before := fileChanges(t, dir, "", "a.go")

	// A new line at the top moves the change down, but it is still the same change
	writeFile(t, filepath.Join(dir, "a.go"), "top\n"+strings.Join(lines, "\n")+"\n")
	_, after := fileChanges(t, dir, "", "a.go")
	if len(before.Changes) != 1 || len(after.Changes) != 2 || after.Changes[1].Start != 51 || after.Changes[1].ID != before.Changes[0].ID {
		t.Fatalf("before %+v\nafter %+v", before.Changes, after.Changes)
	}

	// Untracked files get an ID that follows their content
	writeFile(t, filepath.Join(dir, "new.go"), "1\n")
	_, n1 := fileChanges(t, dir, "", "new.go")
	writeFile(t, filepath.Join(dir, "new.go"), "2\n")
	_, n2 := fileChanges(t, dir, "", "new.go")
	if n1.Changes[0].ID == "" || n1.Changes[0].ID == n2.Changes[0].ID {
		t.Fatalf("untracked IDs %q, %q", n1.Changes[0].ID, n2.Changes[0].ID)
	}
}

func fileChanges(t *testing.T, dir, base, rel string) (*repoChanges, *fileDiff) {
	t.Helper()
	rc := gitRepoChanges(dir, base, false)
	if rc == nil {
		return nil, nil
	}
	return rc, rc.Files[rel]
}

func TestGitRepoChanges_BranchAgainstMain(t *testing.T) {
	dir := newRepo(t, map[string]string{"a.go": "1\n2\n3\n4\n"})
	git(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "a.go"), "1\nTWO\n3\n4\n")
	git(t, dir, "commit", "-q", "-am", "committed on the branch")

	// main moving on after the branch point must not show up
	git(t, dir, "checkout", "-q", "main")
	writeFile(t, filepath.Join(dir, "b.go"), "other\n")
	git(t, dir, "add", "b.go")
	git(t, dir, "commit", "-q", "-m", "later on main")
	git(t, dir, "checkout", "-q", "feature")
	writeFile(t, filepath.Join(dir, "a.go"), "1\nTWO\n3\n4\n5\n") // and an uncommitted line

	rc, d := fileChanges(t, dir, "", "a.go")
	want := []lineChange{{Kind: "mod", Start: 1, End: 1}, {Kind: "add", Start: 4, End: 4}}
	if rc.Base != "main" || len(rc.Files) != 1 || d.Status != "M" || !reflect.DeepEqual(noIDs(d.Changes), want) {
		t.Fatalf("got %+v, a.go %+v", rc, d)
	}
}

func TestGitRepoChanges_OnMainShowsUncommitted(t *testing.T) {
	dir := newRepo(t, map[string]string{"a.go": "1\n2\n"})
	if rc := gitRepoChanges(dir, "", false); rc == nil || len(rc.Files) != 0 {
		t.Fatalf("clean repo: got %+v", rc)
	}
	writeFile(t, filepath.Join(dir, "a.go"), "1\n")
	_, d := fileChanges(t, dir, "", "a.go")
	if d == nil || d.Status != "M" || !reflect.DeepEqual(noIDs(d.Changes), []lineChange{{Kind: "del", Start: 0, End: 0}}) {
		t.Fatalf("got %+v", d)
	}
}

func TestGitRepoChanges_Statuses(t *testing.T) {
	dir := newRepo(t, map[string]string{"same.go": "1\n", "edit.go": "1\n", "sub/gone.go": "1\n", ".gitignore": "*.log\n"})
	git(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "edit.go"), "2\n")
	writeFile(t, filepath.Join(dir, "sub", "added.go"), "1\n2\n")
	git(t, dir, "add", "sub/added.go")
	git(t, dir, "commit", "-q", "-am", "branch work")
	writeFile(t, filepath.Join(dir, "new dir", "untracked file.go"), "1\n2\n3")
	writeFile(t, filepath.Join(dir, "x.log"), "1\n")
	if err := os.Remove(filepath.Join(dir, "sub", "gone.go")); err != nil {
		t.Fatal(err)
	}
	rc := gitRepoChanges(dir, "", false)
	got := map[string]string{}
	for rel, d := range rc.Files {
		got[rel] = d.Status + runsString(d.Changes)
	}
	want := map[string]string{
		"edit.go":                        "M[{mod 0 0}]",
		filepath.Join("sub", "added.go"): "A[{add 0 1}]",
		filepath.Join("new dir", "untracked file.go"): "A[{add 0 2}]",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestGitRepoChanges_OutsideGit(t *testing.T) {
	if rc := gitRepoChanges(t.TempDir(), "", false); rc != nil {
		t.Fatalf("got %+v", rc)
	}
}

func TestGitRepoChanges_FallsBackToMaster(t *testing.T) {
	dir := newRepo(t, map[string]string{"a.go": "1\n"})
	git(t, dir, "branch", "-m", "main", "master")
	git(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "a.go"), "2\n")
	git(t, dir, "commit", "-q", "-am", "change")
	if rc, d := fileChanges(t, dir, "", "a.go"); rc.Base != "master" || d == nil || d.Status != "M" {
		t.Fatalf("got %+v", rc)
	}
}

func TestGitRepoChanges_ChosenBase(t *testing.T) {
	dir := newRepo(t, map[string]string{"a.go": "1\n2\n3\n"})
	git(t, dir, "checkout", "-q", "-b", "release")
	writeFile(t, filepath.Join(dir, "a.go"), "1\n2\nthree\n")
	git(t, dir, "commit", "-q", "-am", "release fix")
	git(t, dir, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(dir, "a.go"), "ONE\n2\nthree\n")
	git(t, dir, "commit", "-q", "-am", "feature work")

	// Against release, only the feature commit shows; against main, both
	if rc, d := fileChanges(t, dir, "release", "a.go"); rc.Base != "release" || !reflect.DeepEqual(noIDs(d.Changes), []lineChange{{Kind: "mod", Start: 0, End: 0}}) {
		t.Fatalf("release: got %+v %+v", rc, d)
	}
	if rc, d := fileChanges(t, dir, "main", "a.go"); rc.Base != "main" || len(d.Changes) != 2 {
		t.Fatalf("main: got %+v %+v", rc, d)
	}

	// A base the repo does not have, or anything that looks like an option, falls back to the default
	out := filepath.Join(t.TempDir(), "pwned")
	for _, base := range []string{"nope", "--output=" + out, "-h"} {
		if rc := gitRepoChanges(dir, base, false); rc == nil || rc.Base != "main" {
			t.Fatalf("base %q: got %+v", base, rc)
		}
	}
	if _, err := os.Stat(out); err == nil {
		t.Fatal("a base was passed to git as an option")
	}
}

func TestGitBranches(t *testing.T) {
	dir := newRepo(t, map[string]string{"a.go": "1\n"})
	git(t, dir, "branch", "zeta")
	git(t, dir, "branch", "alpha")
	git(t, dir, "update-ref", "refs/remotes/origin/main", "HEAD")
	git(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	got := gitBranches(dir)
	want := []string{"alpha", "main", "zeta", "origin/main"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// newRepoProject makes a project whose root is a repo with a nested repo inside, both with changes.
func newRepoProject(t *testing.T) (*server, *http.ServeMux, string) {
	t.Helper()
	gitEnv(t)
	s, mux, root := newTestServer(t)
	git(t, root, "init", "-q", "-b", "main")
	writeFile(t, filepath.Join(root, "b.go"), "1\n")
	writeFile(t, filepath.Join(root, "a.go"), "1\n")
	git(t, root, "add", "-A")
	git(t, root, "commit", "-q", "-m", "init")
	writeFile(t, filepath.Join(root, "b.go"), "1\n2\n")
	writeFile(t, filepath.Join(root, "a.go"), "one\n")
	nested := filepath.Join(root, "nested")
	git(t, root, "init", "-q", "-b", "main", nested)
	writeFile(t, filepath.Join(nested, "n.go"), "1\n")
	git(t, nested, "add", "-A")
	git(t, nested, "commit", "-q", "-m", "init")
	git(t, nested, "branch", "dev")
	writeFile(t, filepath.Join(nested, "n.go"), "")
	s.projects["p"].index()
	return s, mux, root
}

func TestProjectChanges(t *testing.T) {
	s, _, root := newRepoProject(t)
	pc := s.projects["p"].changes("", false)
	var got []string
	for _, f := range pc.Files {
		got = append(got, f.Rel+" "+f.Status+" "+runsString(f.Changes))
		if f.Path != filepath.Join(root, f.Rel) {
			t.Errorf("path %q for %q", f.Path, f.Rel)
		}
	}
	want := []string{"a.go M [{mod 0 0}]", "b.go M [{add 1 1}]", filepath.Join("nested", "n.go") + " M [{del -1 -1}]"}
	if pc.Base != "main" || !reflect.DeepEqual(got, want) {
		t.Fatalf("base %q, got %v", pc.Base, got)
	}
}

func TestHandleChangesAndBranches(t *testing.T) {
	_, mux, _ := newRepoProject(t)
	get := func(path string, q url.Values) string {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path+"?"+q.Encode(), nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: code = %d, body = %s", path, rec.Code, rec.Body)
		}
		return rec.Body.String()
	}
	body := get("/api/changes", url.Values{"project": {"p"}, "base": {"main"}})
	if !strings.Contains(body, `"base":"main"`) || !strings.Contains(body, `"rel":"b.go","status":"M","changes":[{"kind":"add","start":1,"end":1,"id":"`) {
		t.Fatalf("changes: %s", body)
	}
	if body := get("/api/branches", url.Values{"project": {"p"}}); body != `["main","dev"]`+"\n" {
		t.Fatalf("branches: %s", body)
	}
}
