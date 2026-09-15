package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"apex-highlight/highlight"
	"apex-highlight/internal/workflow"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

type fakeBackend struct {
	calls      []string
	selections [][]bool
	fail       string
	root       string
}

func (f *fakeBackend) OutputDirectory() string { return f.root }
func (f *fakeBackend) Analyze(ctx context.Context, r workflow.Request) (workflow.Session, error) {
	f.calls = append(f.calls, r.Source)
	if r.Source == "empty" {
		return workflow.Session{Source: r.Source}, ctx.Err()
	}
	if r.Source == f.fail {
		return workflow.Session{}, errors.New("bad recording")
	}
	return workflow.Session{Source: r.Source, Clips: []highlight.Clip{{Start: 1, End: 2}, {Start: 3, End: 4}}}, ctx.Err()
}
func (f *fakeBackend) ExportClips(ctx context.Context, s workflow.Session, b []bool, mode highlight.RenderMode) (workflow.ExportResult, error) {
	f.selections = append(f.selections, b)
	if s.Source == f.fail {
		return workflow.ExportResult{}, errors.New("export failed")
	}
	return workflow.ExportResult{Directory: filepath.Join(f.root, s.Source), Files: []string{"clip_001.mp4"}}, ctx.Err()
}
func key(m *Model, name string) tea.Cmd {
	var msg tea.KeyMsg
	switch name {
	case "enter":
		msg.Type = tea.KeyEnter
	case "esc":
		msg.Type = tea.KeyEsc
	case "tab":
		msg.Type = tea.KeyTab
	case " ":
		msg.Type = tea.KeySpace
	case "ctrl+c":
		msg.Type = tea.KeyCtrlC
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(name)}
	}
	_, cmd := m.Update(msg)
	return cmd
}
func batchWork(cmd tea.Cmd) tea.Cmd { return cmd().(tea.BatchMsg)[0] }
func prepared(t *testing.T, names ...string) (*Model, *fakeBackend) {
	t.Helper()
	f := &fakeBackend{root: t.TempDir()}
	m := New(context.Background(), f)
	for _, name := range names {
		m.recordings = append(m.recordings, recording{source: name})
	}
	return m, f
}
func TestBatchSelectionAndExport(t *testing.T) {
	m, f := prepared(t, "first", "bad", "last")
	f.fail = "bad"
	first := batchWork(m.begin(false))
	if len(f.calls) != 0 {
		t.Fatal("work ran synchronously")
	}
	_, next := m.Update(first())
	if len(f.calls) != 1 || m.page != analyzing {
		t.Fatal("not serial")
	}
	_, next = m.Update(next())
	m.Update(next())
	if m.page != results || m.total() != 4 || m.recordings[1].status != "分析失败" {
		t.Fatal("batch failure handling")
	}
	key(m, "enter")
	key(m, " ")
	key(m, "esc")
	m.cursor = 2
	key(m, "enter")
	key(m, "esc")
	if m.recordings[0].selected[0] {
		t.Fatal("lost per-recording selection")
	}
	cmd := key(m, "e")
	m.Update(cmd())
	if m.page != confirm || !m.previewReady || len(m.previews) != 2 {
		t.Fatal("missing export preview")
	}
	first = batchWork(key(m, "enter"))
	_, next = m.Update(first())
	m.Update(next())
	if m.page != done || len(f.selections) != 2 || f.selections[0][0] || !f.selections[1][0] {
		t.Fatal("incorrect export selection")
	}
	if len(m.recordings[0].outputs) != 1 || len(m.recordings[2].outputs) != 1 {
		t.Fatal("missing outputs")
	}
}
func TestCancelAndStaleMessages(t *testing.T) {
	m, f := prepared(t, "one", "two")
	first := batchWork(m.begin(false))
	id := m.batch
	key(m, "esc")
	if !m.busy() {
		t.Fatal("did not wait for worker")
	}
	_, next := m.Update(first())
	if next != nil || m.page != results || len(f.calls) != 1 || m.recordings[1].status != "未执行" {
		t.Fatal("cancel launched next task")
	}
	first = batchWork(m.begin(false))
	m.Update(resultMsg{batch: id, index: 0, session: workflow.Session{}})
	if m.position != 0 || m.recordings[0].status != "正在分析" {
		t.Fatal("accepted stale result")
	}
	key(m, "ctrl+c")
	_, quit := m.Update(first())
	if _, ok := quit().(tea.QuitMsg); !ok {
		t.Fatal("did not quit after cleanup")
	}
}
func TestCancelAfterSuccessDoesNotLaunchNext(t *testing.T) {
	m, f := prepared(t, "one", "two")
	first := batchWork(m.begin(false))
	result := first() // Completed worker, message has not yet been processed.
	key(m, "esc")
	_, next := m.Update(result)
	if next != nil || len(f.calls) != 1 || m.total() != 2 {
		t.Fatal("lost completed result or launched next")
	}
}
func TestExportFailureAndCancellationPreserveEarlierResults(t *testing.T) {
	m, f := prepared(t, "one", "two", "three")
	for i := range m.recordings {
		r := &m.recordings[i]
		r.session = workflow.Session{Source: r.source, Clips: []highlight.Clip{{Start: 0, End: 1}}}
		r.selected = []bool{true}
	}
	f.fail = "two"
	first := batchWork(m.begin(true))
	_, next := m.Update(first())
	_, next = m.Update(next())
	if next == nil || len(m.recordings[0].outputs) != 1 {
		t.Fatal("failure stopped batch")
	}
	key(m, "esc")
	m.Update(next())
	if m.page != done || len(m.recordings[0].outputs) != 1 || m.recordings[2].exportStatus != "已取消" {
		t.Fatal("cancel lost prior export")
	}
}
func TestReanalysisClearsStaleSelections(t *testing.T) {
	m, _ := prepared(t, "one")
	m.recordings[0].selected = []bool{true}
	first := batchWork(m.begin(false))
	if m.total() != 0 {
		t.Fatal("stale selection exported after failed reanalysis")
	}
	key(m, "esc")
	m.Update(first())
}
func TestEmptySelectionAndViewports(t *testing.T) {
	m, _ := prepared(t, "one")
	m.page = results
	if key(m, "e") != nil || m.page != results {
		t.Fatal("accepted empty selection")
	}
	for i := 0; i < 100; i++ {
		m.browser.entries = append(m.browser.entries, fileEntry{name: fmt.Sprintf("录像 %d.mp4", i), path: "x"})
	}
	for i := 0; i < 100; i++ {
		m.recordings[0].session.Clips = append(m.recordings[0].session.Clips, highlight.Clip{})
		m.recordings[0].selected = append(m.recordings[0].selected, true)
	}
	for _, size := range [][2]int{{40, 14}, {50, 16}, {80, 24}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		for _, p := range []page{setup, analyzeConfirm, results, review, confirm, done} {
			m.page, m.cursor = p, 0
			if p == review {
				m.cursor = 99
			}
			m.notice = "test error"
			view := m.View()
			if len(strings.Split(view, "\n")) > size[1] {
				t.Fatalf("page %d height overflow: %q", p, view)
			}
			for _, line := range strings.Split(view, "\n") {
				if ansi.StringWidth(line) > size[0] {
					t.Fatalf("page %d width overflow", p)
				}
			}
		}
	}
}
func TestBrowserNavigationAndSelection(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "子目录")
	if err := os.Mkdir(sub, 0755); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(root, "我的 录像.MP4")
	other := filepath.Join(sub, "other.mkv")
	for _, p := range []string{video, other, filepath.Join(root, "ignored.txt")} {
		if err := os.WriteFile(p, nil, 0644); err != nil {
			t.Fatal(err)
		}
	}
	b := newBrowser()
	cmd := b.load("\"" + video + "\"")
	b.accept(cmd().(directoryMsg))
	if b.directory != root || !b.chosen(video) || b.input.Focused() {
		t.Fatal("file path not selected")
	}
	b.accept(b.load(sub)().(directoryMsg))
	b.update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	if !b.chosen(other) || !b.chosen(video) {
		t.Fatal("cross-directory selection lost")
	}
	b.update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("A")})
	if b.chosen(other) || !b.chosen(video) {
		t.Fatal("clear affected other directory")
	}
	b.accept(b.load(video)().(directoryMsg))
	if len(b.selected) != 1 {
		t.Fatal("duplicate selection")
	}
	if len(b.entries) != 3 || !b.entries[0].directory || !b.entries[1].directory {
		t.Fatal("directory sorting or filter")
	}
	stale := b.load(root)()
	current := b.load(sub)()
	b.accept(current.(directoryMsg))
	b.accept(stale.(directoryMsg))
	if b.directory != sub {
		t.Fatal("stale directory accepted")
	}
	b.accept(b.load(filepath.Join(root, "missing"))().(directoryMsg))
	if b.notice == "" || b.directory != sub {
		t.Fatal("failed read discarded previous directory")
	}
	b.accept(directoryMsg{id: b.request, err: os.ErrPermission})
	if b.notice == "" {
		t.Fatal("permission error hidden")
	}
}
func TestPathsAndInput(t *testing.T) {
	for input, want := range map[string]string{`"C:\我的 录像\q.mkv"`: `C:\我的 录像\q.mkv`, `'/tmp/我的 录像.mkv'`: "/tmp/我的 录像.mkv"} {
		if cleanPath(input) != want {
			t.Fatal(input)
		}
	}
	home, _ := os.UserHomeDir()
	got, err := normalizedPath("~/Videos/../Movies")
	if err != nil || got != filepath.Join(home, "Movies") {
		t.Fatal(got, err)
	}
	m, _ := prepared(t)
	m.browser.input.SetValue("")
	key(m, "q")
	if m.browser.input.Value() != "q" {
		t.Fatal("input q quits")
	}
}

func TestNoCandidatesAndEmptyBrowser(t *testing.T) {
	m, _ := prepared(t, "empty")
	m.Update(batchWork(m.begin(false))())
	if m.page != results || m.recordings[0].status != "无候选" {
		t.Fatal("missing no-candidate status")
	}
	key(m, "enter")
	if m.page != review || !strings.Contains(m.View(), "未发现候选") {
		t.Fatal("no-candidate review")
	}
	key(m, "esc")
	if key(m, "e") != nil {
		t.Fatal("exported empty recording")
	}
	b := newBrowser()
	b.accept(b.load(t.TempDir())().(directoryMsg))
	b.update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	if len(b.selected) != 0 {
		t.Fatal("selected parent directory")
	}
}

func TestDirectoryEnterAndExplicitNext(t *testing.T) {
	m, _ := prepared(t)
	root := t.TempDir()
	m.browser.input.Blur()
	m.browser.entries = []fileEntry{{name: "folder", path: root, directory: true}}
	m.browser.selected = []string{"/other/video.mp4"}
	cmd := key(m, "enter")
	if m.page != setup || cmd == nil {
		t.Fatal("Enter should navigate, not confirm")
	}
	m.Update(cmd())
	key(m, "N")
	if m.page != analyzeConfirm || len(m.recordings) != 1 {
		t.Fatal("explicit next lost selection")
	}
	key(m, "esc")
	key(m, "S")
	if m.page != selectedFiles {
		t.Fatal("selected files not accessible")
	}
	key(m, " ")
	if len(m.browser.selected) != 0 {
		t.Fatal("remove selection")
	}
	key(m, "esc")
	key(m, "N")
	if m.page != setup || m.browser.notice == "" {
		t.Fatal("empty selection accepted")
	}
}

func TestFooterAndStatusRemainVisible(t *testing.T) {
	m, _ := prepared(t, strings.Repeat("很长的录像名称", 20)+".mp4")
	m.recordings[0].status = "分析失败"
	m.recordings[0].err = "无法读取录像"
	for _, size := range [][2]int{{40, 14}, {50, 16}, {80, 24}, {120, 40}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m.page = results
		v := ansi.Strip(m.View())
		for _, want := range []string{"分析失败", "E 导出已选", "Q 退出", "无法读取录像"} {
			if !strings.Contains(v, want) {
				t.Fatalf("%v missing %s: %s", size, want, v)
			}
		}
		lines := strings.Split(v, "\n")
		if len(lines) != size[1] {
			t.Fatalf("footer not anchored: %d != %d", len(lines), size[1])
		}
	}
	for _, p := range []page{results, done} {
		m.page = p
		cmd := key(m, "Q")
		if cmd == nil {
			t.Fatal("uppercase Q ignored")
		}
		if _, ok := cmd().(tea.QuitMsg); !ok {
			t.Fatal("Q not quit")
		}
	}
}
