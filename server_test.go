package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) (*server, *http.ServeMux, string) {
	t.Helper()
	root := t.TempDir()
	s := &server{cfg: &config{}, projects: map[string]*project{}}
	s.projects["p"] = newProject(&projectConfig{ID: "p", Name: "p", Path: root}, s)
	mux := http.NewServeMux()
	s.routes(mux, http.NotFoundHandler())
	return s, mux, root
}

func getRaw(mux *http.ServeMux, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	q := url.Values{"project": {"p"}, "path": {path}}
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/raw?"+q.Encode(), nil))
	return rec
}

func TestHandleRaw_Image(t *testing.T) {
	_, mux, root := newTestServer(t)
	png := []byte("\x89PNG\r\n\x1a\nfake")
	if err := os.WriteFile(filepath.Join(root, "shot.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	rec := getRaw(mux, filepath.Join(root, "shot.png"))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("content type = %q", ct)
	}
	if rec.Body.String() != string(png) {
		t.Errorf("body = %q", rec.Body)
	}
	if rec.Header().Get("Content-Security-Policy") != "sandbox" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("missing hardening headers: %v", rec.Header())
	}
}

func TestHandleRaw_SVG(t *testing.T) {
	_, mux, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "logo.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := getRaw(mux, filepath.Join(root, "logo.svg"))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/svg+xml" {
		t.Fatalf("code = %d, content type = %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestHandleRaw_RejectsNonImage(t *testing.T) {
	_, mux, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "page.html"), []byte("<script>alert(1)</script>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := getRaw(mux, filepath.Join(root, "page.html")); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("code = %d, want 415", rec.Code)
	}
}

func TestHandleRaw_RejectsOutsideProject(t *testing.T) {
	_, mux, _ := newTestServer(t)
	outside := filepath.Join(t.TempDir(), "secret.png")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := getRaw(mux, outside); rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestAuthKeepsLinkThroughLogin(t *testing.T) {
	s := &server{cfg: &config{Password: "pw", Secret: "s"}, projects: map[string]*project{}}
	mux := http.NewServeMux()
	s.routes(mux, http.NotFoundHandler())
	h := s.auth(mux)

	// Signed out, a link goes to the login page, which carries it along
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/gh/owner/repo/pull/7", nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/login.html?next=%2Fgh%2Fowner%2Frepo%2Fpull%2F7" {
		t.Fatalf("code %d, location %q", rec.Code, rec.Header().Get("Location"))
	}

	// Signing in returns to it; anything but a local path goes to the start page
	for next, want := range map[string]string{"/gh/owner/repo/pull/7": "/gh/owner/repo/pull/7", "//evil.com/x": "/", "https://evil.com": "/", "/\\evil.com": "/", "": "/"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/login", strings.NewReader(url.Values{"password": {"pw"}, "next": {next}}.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		h.ServeHTTP(rec, req)
		if rec.Header().Get("Location") != want {
			t.Errorf("next %q: location %q, want %q", next, rec.Header().Get("Location"), want)
		}
	}
}
