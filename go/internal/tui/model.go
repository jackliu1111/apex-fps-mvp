// Package tui owns terminal interaction; all media work runs as commands.
package tui

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"apex-highlight/highlight"
	"apex-highlight/internal/workflow"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type Backend interface {
	Analyze(context.Context, workflow.Request) (workflow.Session, error)
	ExportClips(context.Context, workflow.Session, []bool, highlight.RenderMode) (workflow.ExportResult, error)
	OutputDirectory() string
}
type page int

const (
	setup page = iota
	selectedFiles
	analyzeConfirm
	analyzing
	results
	review
	confirm
	exporting
	done
)

type recording struct {
	source                    string
	session                   workflow.Session
	selected                  []bool
	status, err, exportStatus string
	outputs                   []workflow.ExportResult
}

func (r recording) count() int {
	n := 0
	for _, yes := range r.selected {
		if yes {
			n++
		}
	}
	return n
}

type resultMsg struct {
	batch   uint64
	index   int
	session workflow.Session
	output  workflow.ExportResult
	err     error
}
type tickMsg struct{ batch uint64 }
type previewMsg struct {
	batch uint64
	paths []string
}
type Model struct {
	backend                       Backend
	ctx, workCtx                  context.Context
	page                          page
	browser                       browser
	recordings                    []recording
	audio, fast                   bool
	width, height, cursor, detail int
	batch                         uint64
	queue                         []int
	position                      int
	cancel                        context.CancelFunc
	stopping, quitting            bool
	started                       time.Time
	fileStarted                   time.Time
	elapsed                       time.Duration
	notice                        string
	previews                      []string
	previewReady                  bool
}

func New(ctx context.Context, backend Backend) *Model {
	return &Model{backend: backend, ctx: ctx, browser: newBrowser(), width: 80, height: 24}
}
func (m *Model) Init() tea.Cmd {
	return tea.Batch(textinput.Blink, m.browser.load(m.browser.input.Value()))
}
func (m *Model) tick() tea.Cmd {
	id := m.batch
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return tickMsg{id} })
}
func (m *Model) busy() bool { return m.page == analyzing || m.page == exporting }
func (m *Model) begin(export bool) tea.Cmd {
	m.batch++
	m.workCtx, m.cancel = context.WithCancel(m.ctx)
	m.stopping, m.quitting, m.notice = false, false, ""
	m.started, m.elapsed, m.position = time.Now(), 0, 0
	m.queue = nil
	for i := range m.recordings {
		r := &m.recordings[i]
		if export {
			r.exportStatus = "未选择"
			if r.count() > 0 {
				r.exportStatus = "等待导出"
				m.queue = append(m.queue, i)
			}
		} else {
			r.status, r.err = "等待分析", ""
			r.session, r.selected = workflow.Session{}, nil
			m.queue = append(m.queue, i)
		}
	}
	if export {
		m.page = exporting
	} else {
		m.page = analyzing
	}
	if len(m.queue) == 0 {
		m.finish()
		return nil
	}
	return tea.Batch(m.work(), m.tick())
}
func (m *Model) work() tea.Cmd {
	m.fileStarted = time.Now()
	index := m.queue[m.position]
	r := &m.recordings[index]
	id, ctx := m.batch, m.workCtx
	if m.page == exporting {
		r.exportStatus = "正在导出"
		session, selected := r.session, append([]bool(nil), r.selected...)
		mode := highlight.Precise
		if m.fast {
			mode = highlight.Fast
		}
		return func() tea.Msg {
			output, err := m.backend.ExportClips(ctx, session, selected, mode)
			return resultMsg{batch: id, index: index, output: output, err: err}
		}
	}
	r.status = "正在分析"
	mode := "damage"
	if m.audio {
		mode = "audio"
	}
	req := workflow.Request{Source: r.source, Mode: mode}
	return func() tea.Msg {
		session, err := m.backend.Analyze(ctx, req)
		return resultMsg{batch: id, index: index, session: session, err: err}
	}
}
func (m *Model) finish() {
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	if m.page == exporting {
		m.page = done
	} else {
		m.page = results
	}
	m.cursor = 0
	m.stopping = false
}
func (m *Model) prepareExport() tea.Cmd {
	if m.total() == 0 {
		m.notice = "请至少选择一个片段"
		return nil
	}
	m.page, m.cursor, m.notice, m.previewReady = confirm, 0, "", false
	m.batch++
	id, root := m.batch, m.backend.OutputDirectory()
	var sources []string
	for _, r := range m.recordings {
		if r.count() > 0 {
			sources = append(sources, r.source)
		}
	}
	return func() tea.Msg { return previewMsg{id, workflow.PreviewDirectories(root, sources)} }
}
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.browser.input.Width = max(10, msg.Width-16)
	case playbackMsg:
		if msg.err != nil {
			m.notice = "预览失败：" + msg.err.Error()
		}
	case directoryMsg:
		if m.page == setup {
			m.browser.accept(msg)
		}
	case previewMsg:
		if m.page == confirm && msg.batch == m.batch {
			m.previews, m.previewReady = msg.paths, true
		}
	case tickMsg:
		if m.busy() && msg.batch == m.batch {
			m.elapsed = time.Since(m.started)
			return m, m.tick()
		}
	case resultMsg:
		if !m.busy() || msg.batch != m.batch || msg.index != m.queue[m.position] {
			return m, nil
		}
		r := &m.recordings[msg.index]
		if m.page == exporting {
			if msg.err != nil {
				r.exportStatus = "失败：" + msg.err.Error()
				if m.stopping {
					r.exportStatus = "已取消"
				}
			} else {
				r.outputs = append(r.outputs, msg.output)
				r.exportStatus = "导出成功"
			}
		} else {
			if msg.err != nil {
				r.status, r.err = "分析失败", msg.err.Error()
				if m.stopping {
					r.status, r.err = "已取消", ""
				}
			} else {
				r.session, r.status = msg.session, "分析成功"
				r.selected = make([]bool, len(msg.session.Clips))
				for i := range r.selected {
					r.selected[i] = true
				}
				if len(r.selected) == 0 {
					r.status = "无候选"
				}
			}
		}
		m.position++
		if m.stopping {
			for _, i := range m.queue[m.position:] {
				if m.page == exporting {
					m.recordings[i].exportStatus = "未执行"
				} else {
					m.recordings[i].status = "未执行"
				}
			}
			m.notice = "批次已取消；已完成结果保留"
		}
		if m.stopping || m.position == len(m.queue) {
			quit := m.quitting
			m.finish()
			if quit {
				return m, tea.Quit
			}
			return m, nil
		}
		return m, m.work()
	case tea.KeyMsg:
		key := msg.String()
		if m.busy() {
			if key == "esc" || key == "ctrl+c" {
				m.stopping = true
				m.quitting = m.quitting || key == "ctrl+c"
				m.cancel()
			}
			return m, nil
		}
		if key == "ctrl+c" {
			return m, tea.Quit
		}
		if m.page == setup {
			if key == "esc" {
				return m, tea.Quit
			}
			if (key == "s" || key == "S") && !m.browser.input.Focused() && !m.browser.loading {
				m.page, m.cursor = selectedFiles, 0
				return m, nil
			}
			if (key == "n" || key == "N") && !m.browser.input.Focused() && !m.browser.loading {
				if len(m.browser.selected) == 0 {
					m.browser.notice = "请至少勾选一份录像"
					return m, nil
				}
				m.recordings = nil
				for _, source := range m.browser.selected {
					m.recordings = append(m.recordings, recording{source: source})
				}
				m.page, m.cursor, m.notice = analyzeConfirm, 0, ""
				return m, nil
			}
			return m, m.browser.update(msg)
		}
		switch m.page {
		case selectedFiles:
			switch key {
			case "esc", "enter":
				m.page = setup
			case " ", "delete", "backspace":
				if len(m.browser.selected) > 0 {
					m.browser.toggle(m.browser.selected[m.cursor])
					m.cursor = min(m.cursor, max(0, len(m.browser.selected)-1))
				}
			case "a", "A":
				m.browser.selected = nil
				m.cursor = 0
			default:
				m.move(key, len(m.browser.selected))
			}
		case analyzeConfirm:
			switch key {
			case "esc":
				m.page, m.notice = setup, ""
			case "tab":
				m.audio = !m.audio
			case "enter":
				return m, m.begin(false)
			default:
				m.move(key, len(m.recordings))
			}
		case results:
			switch key {
			case "q", "Q":
				return m, tea.Quit
			case "esc":
				m.page, m.notice = analyzeConfirm, ""
			case "enter", "right":
				if len(m.recordings) > 0 {
					r := m.recordings[m.cursor]
					if r.status == "分析成功" || r.status == "无候选" {
						m.detail, m.cursor, m.page, m.notice = m.cursor, 0, review, ""
					} else {
						m.notice = r.status + " " + r.err
					}
				}
			case "e", "E":
				return m, m.prepareExport()
			default:
				m.move(key, len(m.recordings))
			}
		case review:
			r := &m.recordings[m.detail]
			switch key {
			case "p", "P":
				return m, m.playClip()
			case "esc", "left":
				m.page, m.cursor, m.notice = results, m.detail, ""
			case " ":
				if len(r.selected) > 0 {
					r.selected[m.cursor] = !r.selected[m.cursor]
				}
			case "a", "A":
				all := r.count() == len(r.selected)
				for i := range r.selected {
					r.selected[i] = !all
				}
			case "enter":
				m.page, m.cursor, m.notice = results, m.detail, ""
			default:
				m.move(key, len(r.selected))
			}
		case confirm:
			switch key {
			case "esc":
				m.page, m.cursor, m.notice = results, 0, ""
			case "tab":
				m.fast = !m.fast
			case "enter":
				if m.previewReady {
					return m, m.begin(true)
				}
			default:
				m.move(key, len(m.previews))
			}
		case done:
			switch key {
			case "q", "Q":
				return m, tea.Quit
			case "enter", "esc":
				m.page, m.cursor, m.notice = results, 0, ""
			case "n", "N":
				m.browser.selected = nil
				m.page, m.cursor, m.notice = setup, 0, ""
				return m, m.browser.load(m.browser.directory)
			default:
				m.move(key, len(m.completionLines()))
			}
		}
	default:
		if m.page == setup && m.browser.input.Focused() {
			var cmd tea.Cmd
			m.browser.input, cmd = m.browser.input.Update(msg)
			return m, cmd
		}
	}
	return m, nil
}
func (m *Model) move(key string, length int) {
	switch key {
	case "up", "k":
		m.cursor = max(0, m.cursor-1)
	case "down", "j":
		m.cursor = min(max(0, length-1), m.cursor+1)
	}
}
func (m *Model) total() int {
	n := 0
	for _, r := range m.recordings {
		n += r.count()
	}
	return n
}
func safe(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}

var accent = lipgloss.NewStyle().Foreground(lipgloss.Color("80")).Bold(true)
var muted = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))

func (m *Model) list(lines []string, cursor, rows int) string {
	if len(lines) == 0 {
		return "  （空）\n"
	}
	rows = max(1, rows)
	start := max(0, cursor-rows+1)
	end := min(len(lines), start+rows)
	var b strings.Builder
	for i := start; i < end; i++ {
		line := "  " + safe(lines[i])
		if i == cursor {
			line = accent.Render("› " + safe(lines[i]))
		}
		b.WriteString(line + "\n")
	}
	fmt.Fprintf(&b, "显示 %d–%d / %d\n", start+1, end, len(lines))
	return b.String()
}
func (m *Model) completionLines() []string {
	var lines []string
	for _, r := range m.recordings {
		lines = append(lines, filepath.Base(r.source)+" · "+r.exportStatus)
		for _, out := range r.outputs {
			lines = append(lines, fmt.Sprintf("%d 个片段 → %s", len(out.Files), out.Directory))
		}
	}
	return lines
}
