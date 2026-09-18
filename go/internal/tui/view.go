package tui

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func timestamp(seconds float64) string {
	ms := int64(seconds*1000 + .5)
	return fmt.Sprintf("%02d:%02d.%03d", ms/60000, ms/1000%60, ms%1000)
}

// Reserve the right-hand status before shortening the filename.
func (m *Model) summary(name, status string) string {
	width := m.width - 6
	right := ansi.Truncate(safe(status), max(1, width-10), "…")
	leftWidth := max(1, width-ansi.StringWidth(right)-2)
	left := ansi.Truncate(safe(name), leftWidth, "…")
	return left + strings.Repeat(" ", max(0, leftWidth-ansi.StringWidth(left))) + "  " + right
}

func (m *Model) View() string {
	if m.width < 40 || m.height < 14 {
		return "请将终端扩大至至少 40 列 × 14 行\nCtrl+C 退出"
	}
	width := m.width - 4
	step := 0
	switch m.page {
	case analyzeConfirm, analyzing:
		step = 1
	case results, review:
		step = 2
	case confirm, exporting, done:
		step = 3
	}
	steps := []string{"选择录像", "分析", "选片", "导出"}
	for i := range steps {
		if i == step {
			steps[i] = accent.Render("[" + steps[i] + "]")
		} else {
			steps[i] = muted.Render(steps[i])
		}
	}
	header := []string{accent.Render("APEX / 录像片段"), strings.Join(steps, " → "), ""}
	var top, lines, detail, footer []string
	cursor := m.cursor
	notice := m.notice
	switch m.page {
	case setup:
		top = append(top, fmt.Sprintf("选择录像 · 已选 %d 份", len(m.browser.selected)))
		if m.browser.input.Focused() {
			top = append(top, accent.Render("路径 › ")+m.browser.input.View())
			footer = []string{"Enter 跳转目录 / 选择路径中的录像", "Tab 切换到列表 · Esc 退出"}
		} else {
			top = append(top, muted.Render("路径   ")+m.browser.input.View())
			footer = []string{"N 下一步 · S 查看已选 · Tab 编辑路径", "Enter/→ 进入 · ← 上级 · ↑↓ 移动", "空格 勾选 · A 本目录全选/清空 · Esc 退出"}
		}
		for _, e := range m.browser.entries {
			mark := "[ ]"
			if e.directory {
				mark = " ▸ "
			} else if m.browser.chosen(e.path) {
				mark = "[✓]"
			}
			lines = append(lines, mark+" "+e.name)
		}
		cursor = m.browser.cursor
		if m.browser.input.Focused() {
			cursor = -1
		}
		notice = m.browser.notice
		if m.browser.loading {
			notice = "读取目录中…"
		}
	case selectedFiles:
		top = []string{fmt.Sprintf("已选录像 · %d 份", len(m.browser.selected))}
		for _, p := range m.browser.selected {
			lines = append(lines, filepath.Base(p))
		}
		if len(lines) > 0 {
			detail = []string{m.browser.selected[m.cursor]}
		}
		footer = []string{"空格 移除 · A 清空全部 · ↑↓ 移动", "Enter / Esc 返回文件选择"}
	case analyzeConfirm:
		mode := "伤害增长"
		if m.audio {
			mode = "音频高能"
		}
		top = []string{fmt.Sprintf("确认分析 %d 份录像 · %s", len(m.recordings), mode)}
		for _, r := range m.recordings {
			lines = append(lines, filepath.Base(r.source))
		}
		detail = []string{"输出：" + m.backend.OutputDirectory()}
		if len(lines) > 0 {
			detail = append(detail, m.recordings[m.cursor].source)
		}
		footer = []string{"Enter 开始分析 · Tab 切换模式", "↑↓ 查看 · Esc 返回文件选择"}
	case analyzing, exporting:
		label := "正在分析"
		if m.page == exporting {
			label = "正在导出独立片段"
		}
		pulse := []string{"●··", "·●·", "··●"}[int(m.elapsed.Seconds())%3]
		if m.stopping {
			label = "正在取消，等待媒体进程退出"
		}
		top = []string{pulse + " " + label, fmt.Sprintf("已完成 %d / %d · 批次耗时 %s", m.position, len(m.queue), m.elapsed.Round(time.Second))}
		if m.position < len(m.queue) {
			r := m.recordings[m.queue[m.position]]
			current := max(time.Duration(0), m.started.Add(m.elapsed).Sub(m.fileStarted)).Round(time.Second)
			top = append(top, "当前："+safe(filepath.Base(r.source)), "当前文件耗时 "+current.String())
			detail = []string{r.source}
		}
		footer = []string{"Esc 取消批次并返回", "Ctrl+C 取消并退出"}
	case results:
		top = []string{fmt.Sprintf("录像结果 · 共选 %d 个片段", m.total())}
		for _, r := range m.recordings {
			lines = append(lines, m.summary(filepath.Base(r.source), fmt.Sprintf("%s %d/%d", r.status, r.count(), len(r.selected))))
		}
		if len(lines) > 0 {
			r := m.recordings[m.cursor]
			detail = []string{r.source}
			if r.err != "" {
				detail = append(detail, "错误："+r.err)
			}
		}
		footer = []string{"Enter 查看片段 · E 导出已选", "↑↓ 移动 · Esc 分析设置 · Q 退出"}
	case review:
		r := m.recordings[m.detail]
		top = []string{safe(filepath.Base(r.source)), fmt.Sprintf("候选片段 · %d/%d 已选", r.count(), len(r.selected))}
		for i, c := range r.session.Clips {
			mark := "[ ]"
			if r.selected[i] {
				mark = "[✓]"
			}
			if width < 60 {
				lines = append(lines, fmt.Sprintf("%s %03d %s  %.2fs", mark, i+1, timestamp(c.Start), c.End-c.Start))
			} else {
				lines = append(lines, fmt.Sprintf("%s %03d %s → %s  %.2fs", mark, i+1, timestamp(c.Start), timestamp(c.End), c.End-c.Start))
			}
		}
		if len(lines) == 0 {
			top = append(top, "未发现候选，可返回切换检测模式。")
		} else {
			c := r.session.Clips[m.cursor]
			detail = []string{timestamp(c.Start) + " → " + timestamp(c.End)}
		}
		footer = []string{"P 预览 · 空格 勾选 · A 全选/清空", "↑↓ 移动 · Enter / Esc 返回录像结果"}
	case confirm:
		mode := "精确剪辑：重编码，可能有画质损失"
		if m.fast {
			mode = "快速剪辑：边界受关键帧影响"
		}
		top = []string{fmt.Sprintf("确认导出 %d 个独立片段", m.total()), mode}
		if !m.previewReady {
			top = append(top, "正在检查输出目录…")
		} else {
			i := 0
			for _, r := range m.recordings {
				if r.count() > 0 {
					lines = append(lines, m.summary(filepath.Base(m.previews[i]), fmt.Sprintf("%d 段", r.count())))
					i++
				}
			}
			if len(lines) > 0 {
				detail = []string{m.previews[m.cursor]}
			}
		}
		footer = []string{"Enter 导出 · Tab 切换剪辑模式", "每段单独保存；目录冲突自动加序号", "↑↓ 查看 · Esc 返回"}
	case done:
		top = []string{"导出批次结束"}
		lines = m.completionLines()
		if len(lines) > 0 {
			detail = []string{lines[m.cursor]}
		}
		footer = []string{"Enter 返回选片 · N 新建 · Q 退出", "↑↓ 查看实际输出路径"}
	}
	// Size the list after reserving all fixed chrome; keep footer at a stable row.
	fixed := len(header) + len(top) + len(detail) + len(footer) + 2
	rows := max(1, m.height-2-fixed-1)
	body := append(header, top...)
	if len(lines) > 0 {
		body = append(body, strings.Split(strings.TrimSuffix(m.list(lines, cursor, rows), "\n"), "\n")...)
	} else if m.page == setup || m.page == selectedFiles {
		body = append(body, "（暂无录像）")
	}
	for i := range detail {
		detail[i] = safe(detail[i])
	}
	body = append(body, detail...)
	footerStart := m.height - 2 - len(footer) - 2
	if len(body) > footerStart {
		body = body[:footerStart]
	}
	for len(body) < footerStart {
		body = append(body, "")
	}
	body = append(body, muted.Render(strings.Repeat("─", width)))
	for _, line := range footer {
		body = append(body, muted.Render(line))
	}
	if notice != "" {
		body = append(body, "提示："+safe(notice))
	} else {
		body = append(body, "")
	}
	for i, line := range body {
		body[i] = ansi.Truncate(line, width, "…")
	}
	return lipgloss.NewStyle().Padding(1, 2).Render(strings.Join(body, "\n"))
}
