package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

type fileEntry struct {
	name, path string
	directory  bool
}
type directoryMsg struct {
	id                uint64
	directory, target string
	entries           []fileEntry
	err               error
}
type browser struct {
	input     textinput.Model
	directory string
	entries   []fileEntry
	selected  []string
	cursor    int
	request   uint64
	loading   bool
	notice    string
}

func newBrowser() browser {
	input := textinput.New()
	input.Placeholder = "输入目录或录像路径"
	input.CharLimit = 4096
	input.Focus()
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	input.SetValue(cwd)
	return browser{input: input}
}

func cleanPath(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		s = s[1 : len(s)-1]
	}
	if runtime.GOOS != "windows" {
		s = strings.ReplaceAll(s, `\ `, " ")
	}
	return s
}
func normalizedPath(s string) (string, error) {
	s = cleanPath(s)
	if s == "~" || strings.HasPrefix(s, "~/") || (runtime.GOOS == "windows" && strings.HasPrefix(s, `~\`)) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if len(s) == 1 {
			s = home
		} else {
			s = filepath.Join(home, s[2:])
		}
	}
	if s == "" {
		s = "."
	}
	return filepath.Abs(s)
}
func isVideo(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts":
		return true
	}
	return false
}
func readDirectory(id uint64, input string) directoryMsg {
	msg := directoryMsg{id: id}
	path, err := normalizedPath(input)
	if err != nil {
		msg.err = err
		return msg
	}
	stat, err := os.Stat(path)
	if err != nil {
		msg.err = err
		return msg
	}
	if !stat.IsDir() {
		if !stat.Mode().IsRegular() || !isVideo(path) {
			msg.err = fmt.Errorf("请选择支持的录像文件或目录")
			return msg
		}
		msg.target, path = path, filepath.Dir(path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		msg.err = err
		return msg
	}
	msg.directory = path
	parent := filepath.Dir(path)
	if parent != path {
		msg.entries = append(msg.entries, fileEntry{"..", parent, true})
	}
	var items []fileEntry
	for _, e := range entries {
		p := filepath.Join(path, e.Name())
		info, err := e.Info()
		if e.Type()&os.ModeSymlink != 0 {
			info, err = os.Stat(p)
		}
		if err != nil {
			continue
		}
		if info.IsDir() || (info.Mode().IsRegular() && isVideo(p)) {
			items = append(items, fileEntry{e.Name(), p, info.IsDir()})
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].directory != items[j].directory {
			return items[i].directory
		}
		return items[i].name < items[j].name
	})
	msg.entries = append(msg.entries, items...)
	return msg
}
func (b *browser) load(path string) tea.Cmd {
	b.request++
	id := b.request
	b.loading, b.notice = true, ""
	return func() tea.Msg { return readDirectory(id, path) }
}
func (b *browser) accept(msg directoryMsg) {
	if msg.id != b.request {
		return
	}
	b.loading = false
	if msg.err != nil {
		b.notice = msg.err.Error()
		return
	}
	b.directory, b.entries, b.cursor = msg.directory, msg.entries, 0
	b.input.SetValue(msg.directory)
	b.input.Blur()
	b.notice = ""
	for i, e := range b.entries {
		if e.path == msg.target {
			b.cursor = i
			if !b.chosen(e.path) {
				b.selected = append(b.selected, e.path)
			}
		}
	}
}
func (b *browser) chosen(path string) bool {
	for _, p := range b.selected {
		if p == path {
			return true
		}
	}
	return false
}
func (b *browser) toggle(path string) {
	for i, p := range b.selected {
		if p == path {
			b.selected = append(b.selected[:i], b.selected[i+1:]...)
			return
		}
	}
	b.selected = append(b.selected, path)
}
func (b *browser) update(msg tea.KeyMsg) tea.Cmd {
	key := msg.String()
	if key == "tab" {
		if b.input.Focused() {
			b.input.Blur()
		} else {
			return b.input.Focus()
		}
		return nil
	}
	if b.input.Focused() {
		if key == "enter" {
			return b.load(b.input.Value())
		}
		var cmd tea.Cmd
		b.input, cmd = b.input.Update(msg)
		return cmd
	}
	if b.loading {
		return nil
	}
	switch key {
	case "up", "k":
		b.cursor = max(0, b.cursor-1)
	case "down", "j":
		b.cursor = min(max(0, len(b.entries)-1), b.cursor+1)
	case "left", "backspace":
		return b.load(filepath.Dir(b.directory))
	case "right", "enter":
		if len(b.entries) > 0 && b.entries[b.cursor].directory {
			return b.load(b.entries[b.cursor].path)
		}
	case " ":
		if len(b.entries) > 0 && !b.entries[b.cursor].directory {
			b.toggle(b.entries[b.cursor].path)
		}
	case "a", "A":
		all := true
		for _, e := range b.entries {
			if !e.directory && !b.chosen(e.path) {
				all = false
			}
		}
		for _, e := range b.entries {
			if !e.directory && b.chosen(e.path) == all {
				b.toggle(e.path)
			}
		}
	}
	return nil
}
