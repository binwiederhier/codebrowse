package main

import (
	"bytes"
	"fmt"
	"hash/fnv"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	maxDiffSize      = 8 << 20 // larger diffs list the changed files, without line runs
	maxUntrackedRead = 1 << 20 // larger untracked files are not read to count their lines
	maxBranches      = 200
	maxOldLines      = 200 // removed lines sent per change, for showing the old code
)

var (
	// defaultBases are tried in order when no base is chosen, or the chosen one does not exist
	defaultBases = []string{"main", "master", "origin/main", "origin/master"}
	hunkRe       = regexp.MustCompile(`(?m)^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)
)

// lineChange is a run of changed lines in the working file, 0-based and inclusive. For "del",
// Start is the line the deleted lines were below (-1 for the top of the file).
type lineChange struct {
	Kind     string   `json:"kind"` // "add", "mod" or "del"
	Start    int      `json:"start"`
	End      int      `json:"end"`
	ID       string   `json:"id"`                 // follows the change's content, so a review mark survives edits elsewhere
	Old      []string `json:"old,omitempty"`      // the removed lines, for "mod" and "del"
	OldStart int      `json:"oldStart,omitempty"` // 0-based line of Old in the base
	OldMore  int      `json:"oldMore,omitempty"`  // removed lines left out of Old
}

// fileDiff is how one file differs from the base.
type fileDiff struct {
	Path    string       `json:"path"`   // absolute
	Rel     string       `json:"rel"`    // relative to the project
	Status  string       `json:"status"` // "A" (added or untracked) or "M"
	Changes []lineChange `json:"changes"`
}

// repoChanges are the changed files of one repo, by path relative to it.
type repoChanges struct {
	Base  string
	Files map[string]*fileDiff
}

// projectChanges are the changed files of all repos in a project, sorted by path.
type projectChanges struct {
	Base  string      `json:"base"`
	Files []*fileDiff `json:"files"`
}

// changes collects the changes of every repo in the project against base ("" for the default).
func (p *project) changes(base string) *projectChanges {
	p.mu.RLock()
	repos := make([]string, 0, len(p.git))
	for rel := range p.git {
		repos = append(repos, rel)
	}
	p.mu.RUnlock()
	sort.Strings(repos) // the root repo ("") first, so it names the base
	pc := &projectChanges{Files: []*fileDiff{}}
	for _, rel := range repos {
		rc := gitRepoChanges(filepath.Join(p.cfg.Path, rel), base)
		if rc == nil {
			continue
		}
		if pc.Base == "" {
			pc.Base = rc.Base
		}
		for frel, d := range rc.Files {
			d.Rel = filepath.Join(rel, frel)
			d.Path = filepath.Join(p.cfg.Path, d.Rel)
			pc.Files = append(pc.Files, d)
		}
	}
	sort.Slice(pc.Files, func(i, j int) bool { return pc.Files[i].Rel < pc.Files[j].Rel })
	return pc
}

// branches lists the branches of all repos in the project, the root repo's first.
func (p *project) branches() []string {
	p.mu.RLock()
	repos := make([]string, 0, len(p.git))
	for rel := range p.git {
		repos = append(repos, rel)
	}
	p.mu.RUnlock()
	sort.Strings(repos)
	seen := map[string]bool{}
	res := []string{}
	for _, rel := range repos {
		for _, b := range gitBranches(filepath.Join(p.cfg.Path, rel)) {
			if !seen[b] && len(res) < maxBranches {
				seen[b] = true
				res = append(res, b)
			}
		}
	}
	return res
}

// gitRepoChanges diffs the repo at dir against where HEAD forked from base, including uncommitted
// edits and untracked files. It returns nil outside a repo or before the first commit.
func gitRepoChanges(dir, base string) *repoChanges {
	commit, label := gitBase(dir, base)
	if commit == "" {
		return nil
	}
	rc := &repoChanges{Base: label, Files: map[string]*fileDiff{}}

	// Changed files; deleted ones are skipped, there is nothing to show for them
	if out, err := gitOutput(dir, "diff", "--name-status", "-z", "--no-renames", commit); err == nil {
		fields := strings.Split(string(out), "\x00")
		for i := 0; i+1 < len(fields); i += 2 {
			status := ""
			switch fields[i] {
			case "A":
				status = "A"
			case "M", "T":
				status = "M"
			}
			if status != "" {
				rc.Files[filepath.FromSlash(fields[i+1])] = &fileDiff{Status: status, Changes: []lineChange{}}
			}
		}
	}

	// Line runs, from one patch for the whole repo
	if len(rc.Files) > 0 {
		out, err := gitOutput(dir, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", commit)
		if err == nil && len(out) <= maxDiffSize {
			for path, changes := range parsePatch(string(out)) {
				if d, ok := rc.Files[filepath.FromSlash(path)]; ok {
					d.Changes = changes
				}
			}
		}
	}

	// Untracked files are entirely new
	if out, err := gitOutput(dir, "ls-files", "-o", "--exclude-standard", "-z"); err == nil {
		for _, f := range strings.Split(string(out), "\x00") {
			if f == "" || strings.HasSuffix(f, "/") { // a trailing slash is a nested repo
				continue
			}
			rel := filepath.FromSlash(f)
			d := &fileDiff{Status: "A", Changes: []lineChange{}}
			if n, id := untrackedLines(filepath.Join(dir, rel)); n > 0 {
				d.Changes = append(d.Changes, lineChange{Kind: "add", Start: 0, End: n - 1, ID: id})
			}
			rc.Files[rel] = d
		}
	}
	return rc
}

// gitBase returns the commit to diff against: where HEAD forked from base if this repo has it,
// else from the first default base that exists, else HEAD. Both results are empty outside a repo.
func gitBase(dir, base string) (commit, label string) {
	candidates := defaultBases
	if base != "" && !strings.HasPrefix(base, "-") {
		candidates = append([]string{base}, defaultBases...)
	}
	for _, b := range candidates {
		if _, err := gitOutput(dir, "rev-parse", "--verify", "--quiet", "--end-of-options", b+"^{commit}"); err != nil {
			continue
		}
		out, err := gitOutput(dir, "merge-base", "HEAD", b)
		if err != nil {
			continue
		}
		return strings.TrimSpace(string(out)), b
	}
	if _, err := gitOutput(dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"); err == nil {
		return "HEAD", "HEAD"
	}
	return "", ""
}

// gitBranches lists local branches, then remote ones, each sorted by name.
func gitBranches(dir string) []string {
	out, err := gitOutput(dir, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
	if err != nil {
		return nil
	}
	var local, remote []string
	for _, ref := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		switch {
		case strings.HasPrefix(ref, "refs/heads/"):
			local = append(local, strings.TrimPrefix(ref, "refs/heads/"))
		case strings.HasPrefix(ref, "refs/remotes/") && !strings.HasSuffix(ref, "/HEAD"):
			remote = append(remote, strings.TrimPrefix(ref, "refs/remotes/"))
		}
	}
	sort.Strings(local)
	sort.Strings(remote)
	return append(local, remote...)
}

// gitOutput runs git in dir; pathspecs are literal, so file names like "[id].tsx" match exactly.
func gitOutput(dir string, args ...string) ([]byte, error) {
	return exec.Command("git", append([]string{"--literal-pathspecs", "-C", dir}, args...)...).Output()
}

// parsePatch splits a multi-file -U0 patch into line runs per new path.
func parsePatch(patch string) map[string][]lineChange {
	res := map[string][]lineChange{}
	for _, chunk := range strings.Split(patch, "\ndiff --git ") {
		i := strings.Index(chunk, "\n+++ b/")
		if i < 0 {
			continue // deleted or binary
		}
		line := chunk[i+len("\n+++ b/"):]
		if j := strings.IndexByte(line, '\n'); j >= 0 {
			line = line[:j]
		}
		res[strings.TrimSuffix(line, "\t")] = parseHunks(chunk)
	}
	return res
}

// parseHunks turns the hunk headers of a -U0 diff into changed line runs, with the lines they removed.
// Each run's ID hashes the hunk's removed and added lines, numbered when the same hunk occurs more
// than once in the file.
func parseHunks(diff string) []lineChange {
	changes := []lineChange{}
	seen := map[string]int{}
	locs := hunkRe.FindAllStringSubmatchIndex(diff, -1)
	for k, loc := range locs {
		m := hunkRe.FindStringSubmatch(diff[loc[0]:loc[1]])
		body := diff[loc[1]:]
		if k+1 < len(locs) {
			body = diff[loc[1]:locs[k+1][0]]
		}
		if i := strings.IndexByte(body, '\n'); i >= 0 {
			body = body[i+1:] // the rest of the header line names the enclosing function, which may change
		} else {
			body = ""
		}
		var removed []string
		for _, l := range strings.Split(body, "\n") {
			if strings.HasPrefix(l, "-") {
				removed = append(removed, l[1:])
			}
		}
		id := contentID(body)
		seen[id]++
		if n := seen[id]; n > 1 {
			id += "-" + strconv.Itoa(n)
		}
		count := func(s string) int {
			if s == "" {
				return 1
			}
			n, _ := strconv.Atoi(s)
			return n
		}
		oldCount := count(m[2])
		oldStart, _ := strconv.Atoi(m[1])
		start, _ := strconv.Atoi(m[3])
		newCount := count(m[4])
		c := lineChange{Kind: "mod", Start: start - 1, End: start + newCount - 2, ID: id}
		switch {
		case newCount == 0:
			c = lineChange{Kind: "del", Start: start - 1, End: start - 1, ID: id}
		case oldCount == 0:
			c.Kind = "add"
		}
		if len(removed) > 0 {
			c.OldStart = oldStart - 1
			if len(removed) > maxOldLines {
				c.OldMore = len(removed) - maxOldLines
				removed = removed[:maxOldLines]
			}
			c.Old = removed
		}
		changes = append(changes, c)
	}
	return changes
}

// untrackedLines counts the lines of a file and hashes its content. A file too large to read is
// one line, with an ID from its size and modification time.
func untrackedLines(path string) (int, string) {
	fi, err := os.Stat(path)
	if err != nil || fi.Size() == 0 {
		return 0, ""
	}
	if fi.Size() > maxUntrackedRead {
		return 1, contentID(fmt.Sprint(fi.Size(), fi.ModTime().UnixNano()))
	}
	content, err := os.ReadFile(path)
	if err != nil || len(content) == 0 {
		return 0, ""
	}
	n := bytes.Count(content, []byte("\n"))
	if content[len(content)-1] != '\n' {
		n++
	}
	return n, contentID(string(content))
}

// contentID is a short hash identifying a change by its content.
func contentID(s string) string {
	h := fnv.New64a()
	h.Write([]byte(s))
	return strconv.FormatUint(h.Sum64(), 36)
}
