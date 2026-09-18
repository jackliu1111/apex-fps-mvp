package tui

import (
	"fmt"

	"apex-highlight/internal/native"
	tea "github.com/charmbracelet/bubbletea"
)

type playbackMsg struct{ err error }

func (m *Model) playClip() tea.Cmd {
	r := m.recordings[m.detail]
	if len(r.session.Clips) == 0 {
		m.notice = "没有可预览的片段"
		return nil
	}
	c := r.session.Clips[m.cursor]
	cmd, err := native.Command(m.ctx, "ffplay", "-autoexit", "-loglevel", "error", "-ss", fmt.Sprint(c.Start), "-t", fmt.Sprint(c.End-c.Start), "-i", r.source)
	if err != nil {
		m.notice = err.Error()
		return nil
	}
	m.notice = "关闭播放窗口返回选片"
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return playbackMsg{err} })
}
