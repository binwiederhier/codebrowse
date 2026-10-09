package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxOpenDocs = 40

var goplsSettings = map[string]any{
	"semanticTokens": true,
	"hints": map[string]any{
		"parameterNames":         true,
		"compositeLiteralFields": false,
	},
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcMsg struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

type fileEvent struct {
	URI  string `json:"uri"`
	Type int    `json:"type"`
}

type legend struct {
	TokenTypes     []string `json:"tokenTypes"`
	TokenModifiers []string `json:"tokenModifiers"`
}

type openDoc struct {
	version int
	stat    fileStat
}

type lspClient struct {
	root string
	cmd  *exec.Cmd
	in   io.WriteCloser
	wmu  sync.Mutex

	nextID   atomic.Int64
	mu       sync.Mutex
	pending  map[int64]chan *rpcMsg
	opened   map[string]*openDoc
	order    []string
	progress map[string]string
	legend   legend
	lastUsed time.Time
	ready    chan struct{}
	dead     chan struct{}
	initErr  error
}

func startGopls(root string) (*lspClient, error) {
	bin, err := exec.LookPath("gopls")
	if err != nil {
		bin = filepath.Join(os.Getenv("HOME"), "go", "bin", "gopls")
	}
	cmd := exec.Command(bin)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOMEMLIMIT=2GiB")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	slog.Info("started gopls", "root", root, "pid", cmd.Process.Pid)
	l := &lspClient{root: root, cmd: cmd, in: in, pending: map[int64]chan *rpcMsg{}, opened: map[string]*openDoc{}, progress: map[string]string{}, lastUsed: time.Now(), ready: make(chan struct{}), dead: make(chan struct{})}
	go l.readLoop(bufio.NewReaderSize(out, 1<<20))
	go func() {
		_ = cmd.Wait()
		close(l.dead)
		l.mu.Lock()
		for id, ch := range l.pending {
			close(ch)
			delete(l.pending, id)
		}
		l.mu.Unlock()
		slog.Info("gopls exited", "root", root)
	}()
	go l.initialize()
	return l, nil
}

func (l *lspClient) initialize() {
	defer close(l.ready)
	params := map[string]any{
		"processId":             os.Getpid(),
		"rootUri":               pathToURI(l.root),
		"workspaceFolders":      []map[string]string{{"uri": pathToURI(l.root), "name": filepath.Base(l.root)}},
		"initializationOptions": goplsSettings,
		"capabilities": map[string]any{
			"general": map[string]any{"positionEncodings": []string{"utf-16"}},
			"window":  map[string]any{"workDoneProgress": true},
			"workspace": map[string]any{
				"configuration":         true,
				"workspaceFolders":      true,
				"didChangeWatchedFiles": map[string]any{"dynamicRegistration": true},
			},
			"textDocument": map[string]any{
				"hover":          map[string]any{"contentFormat": []string{"markdown", "plaintext"}},
				"definition":     map[string]any{"linkSupport": true},
				"implementation": map[string]any{"linkSupport": true},
				"references":     map[string]any{},
				"documentSymbol": map[string]any{"hierarchicalDocumentSymbolSupport": true},
				"inlayHint":      map[string]any{},
				"semanticTokens": map[string]any{
					"requests":                map[string]any{"full": true},
					"tokenTypes":              []string{"namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "label"},
					"tokenModifiers":          []string{"declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"},
					"formats":                 []string{"relative"},
					"multilineTokenSupport":   false,
					"overlappingTokenSupport": false,
				},
			},
		},
	}
	var res struct {
		Capabilities struct {
			SemanticTokensProvider struct {
				Legend legend `json:"legend"`
			} `json:"semanticTokensProvider"`
		} `json:"capabilities"`
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := l.rawCall(ctx, "initialize", params, &res); err != nil {
		l.initErr = err
		slog.Error("gopls initialize failed", "error", err)
		return
	}
	l.legend = res.Capabilities.SemanticTokensProvider.Legend
	l.notify("initialized", map[string]any{})
}

func (l *lspClient) readLoop(r *bufio.Reader) {
	for {
		length := -1
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimSpace(line)
			if line == "" {
				break
			}
			if v, ok := strings.CutPrefix(line, "Content-Length:"); ok {
				length, _ = strconv.Atoi(strings.TrimSpace(v))
			}
		}
		if length < 0 {
			continue
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(r, body); err != nil {
			return
		}
		var m rpcMsg
		if err := json.Unmarshal(body, &m); err != nil {
			continue
		}
		switch {
		case m.Method != "" && m.ID != nil:
			go l.handleRequest(&m)
		case m.Method != "":
			l.handleNotification(&m)
		case m.ID != nil:
			var id int64
			if json.Unmarshal(*m.ID, &id) == nil {
				l.mu.Lock()
				ch := l.pending[id]
				delete(l.pending, id)
				l.mu.Unlock()
				if ch != nil {
					ch <- &m
				}
			}
		}
	}
}

func (l *lspClient) handleRequest(m *rpcMsg) {
	var result any
	switch m.Method {
	case "workspace/configuration":
		var p struct {
			Items []json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(m.Params, &p)
		cfgs := make([]any, len(p.Items))
		for i := range cfgs {
			cfgs[i] = goplsSettings
		}
		result = cfgs
	case "workspace/workspaceFolders":
		result = []map[string]string{{"uri": pathToURI(l.root), "name": filepath.Base(l.root)}}
	}
	l.write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
}

func (l *lspClient) handleNotification(m *rpcMsg) {
	switch m.Method {
	case "$/progress":
		var p struct {
			Token json.RawMessage `json:"token"`
			Value struct {
				Kind    string `json:"kind"`
				Title   string `json:"title"`
				Message string `json:"message"`
			} `json:"value"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return
		}
		tok := string(p.Token)
		l.mu.Lock()
		switch p.Value.Kind {
		case "begin":
			l.progress[tok] = p.Value.Title
		case "report":
			if t, ok := l.progress[tok]; ok && p.Value.Message != "" {
				l.progress[tok] = strings.SplitN(t, ":", 2)[0] + ": " + p.Value.Message
			}
		case "end":
			delete(l.progress, tok)
		}
		l.mu.Unlock()
	case "window/showMessage", "window/logMessage":
		var p struct {
			Type    int    `json:"type"`
			Message string `json:"message"`
		}
		if json.Unmarshal(m.Params, &p) == nil && p.Type == 1 {
			slog.Warn("gopls", "root", l.root, "message", p.Message)
		}
	}
}

func (l *lspClient) write(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	l.wmu.Lock()
	defer l.wmu.Unlock()
	if _, err := fmt.Fprintf(l.in, "Content-Length: %d\r\n\r\n", len(data)); err != nil {
		return err
	}
	_, err = l.in.Write(data)
	return err
}

func (l *lspClient) notify(method string, params any) {
	_ = l.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (l *lspClient) rawCall(ctx context.Context, method string, params, result any) error {
	id := l.nextID.Add(1)
	ch := make(chan *rpcMsg, 1)
	l.mu.Lock()
	l.pending[id] = ch
	l.mu.Unlock()
	if err := l.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return err
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return fmt.Errorf("gopls exited")
		}
		if m.Error != nil {
			return fmt.Errorf("gopls: %s", m.Error.Message)
		}
		if result != nil && len(m.Result) > 0 {
			return json.Unmarshal(m.Result, result)
		}
		return nil
	case <-ctx.Done():
		l.mu.Lock()
		delete(l.pending, id)
		l.mu.Unlock()
		l.notify("$/cancelRequest", map[string]any{"id": id})
		return ctx.Err()
	}
}

// call waits for initialization, syncs the document at path (if any) and issues the request.
func (l *lspClient) call(ctx context.Context, path, method string, params, result any) error {
	select {
	case <-l.ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	if l.initErr != nil {
		return l.initErr
	}
	l.touch()
	if path != "" {
		if err := l.sync(path); err != nil {
			return err
		}
	}
	return l.rawCall(ctx, method, params, result)
}

// sync opens path in gopls, or re-sends its content if it changed on disk.
func (l *lspClient) sync(path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	st := fileStat{fi.ModTime(), fi.Size()}
	uri := pathToURI(path)
	l.mu.Lock()
	doc := l.opened[uri]
	if doc != nil && doc.stat == st {
		l.mu.Unlock()
		return nil
	}
	var closeURI string
	if doc == nil {
		doc = &openDoc{}
		l.opened[uri] = doc
		l.order = append(l.order, uri)
		if len(l.order) > maxOpenDocs {
			closeURI = l.order[0]
			l.order = l.order[1:]
			delete(l.opened, closeURI)
		}
	}
	doc.stat = st
	doc.version++
	version := doc.version
	l.mu.Unlock()
	if closeURI != "" {
		l.notify("textDocument/didClose", map[string]any{"textDocument": map[string]any{"uri": closeURI}})
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if version == 1 {
		l.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": languageID(path), "version": version, "text": string(content)}})
	} else {
		l.notify("textDocument/didChange", map[string]any{"textDocument": map[string]any{"uri": uri, "version": version}, "contentChanges": []map[string]any{{"text": string(content)}}})
	}
	return nil
}

func (l *lspClient) touch() {
	l.mu.Lock()
	l.lastUsed = time.Now()
	l.mu.Unlock()
}

func (l *lspClient) idle() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	return time.Since(l.lastUsed)
}

func (l *lspClient) isDead() bool {
	select {
	case <-l.dead:
		return true
	default:
		return false
	}
}

func (l *lspClient) status() string {
	select {
	case <-l.ready:
	default:
		return "starting"
	}
	if l.initErr != nil {
		return "error: " + l.initErr.Error()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.progress) == 0 {
		return "ready"
	}
	var titles []string
	for _, t := range l.progress {
		titles = append(titles, t)
	}
	sort.Strings(titles)
	return titles[0]
}

func (l *lspClient) shutdown() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = l.rawCall(ctx, "shutdown", nil, nil)
		l.notify("exit", nil)
		select {
		case <-l.dead:
		case <-time.After(5 * time.Second):
			_ = l.cmd.Process.Kill()
		}
	}()
}

func languageID(path string) string {
	switch filepath.Base(path) {
	case "go.mod":
		return "go.mod"
	case "go.work":
		return "go.work"
	case "go.sum":
		return "go.sum"
	}
	return "go"
}

func pathToURI(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

func uriToPath(uri string) string {
	u, err := url.Parse(uri)
	if err != nil {
		return strings.TrimPrefix(uri, "file://")
	}
	return u.Path
}
