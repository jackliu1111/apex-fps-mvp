package tui

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	tea "github.com/charmbracelet/bubbletea"
)

type playbackMsg struct{ err error }

func (m *Model) playClip() tea.Cmd {
	r := m.recordings[m.detail]
	if len(r.session.Clips) == 0 {
		m.notice = "没有可预览的片段"
		return nil
	}
	name := "ffplay"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	player := ""
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(executable), "bin", name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			player = candidate
		}
	}
	if player == "" {
		player, _ = exec.LookPath(name)
	}
	if player == "" {
		m.notice = "预览需要 ffplay：请放入程序旁 bin 目录或 PATH"
		return nil
	}
	c := r.session.Clips[m.cursor]
	cmd := exec.CommandContext(m.ctx, player, "-autoexit", "-loglevel", "error", "-ss", fmt.Sprint(c.Start), "-t", fmt.Sprint(c.End-c.Start), "-i", r.source)
	m.notice = "关闭播放窗口返回选片"
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return playbackMsg{err} })
}
