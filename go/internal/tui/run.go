package tui

import (
	"context"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/term"
)

func IsTerminal() bool { return term.IsTerminal(os.Stdin.Fd()) && term.IsTerminal(os.Stdout.Fd()) }
func Run(backend Backend) error {
	if !IsTerminal() {
		return fmt.Errorf("TUI 需要交互终端；脚本请使用 analyze / render 命令")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := tea.NewProgram(New(ctx, backend), tea.WithAltScreen()).Run()
	return err
}
