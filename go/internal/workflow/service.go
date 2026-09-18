// Package workflow coordinates an interactive session without depending on a UI.
package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"apex-highlight/highlight"
)

type Request struct{ Source, Mode string }
type Session struct {
	Source    string
	Directory string
	Clips     []highlight.Clip
	size      int64
	modified  int64
}
type Service struct{ ToolsDir, OutputRoot string }

func (s Service) Analyze(ctx context.Context, req Request) (Session, error) {
	var session Session
	if req.Mode != "damage" && req.Mode != "audio" {
		return session, fmt.Errorf("未知分析模式")
	}
	source, err := filepath.Abs(req.Source)
	if err != nil {
		return session, err
	}
	stat, err := os.Stat(source)
	if err != nil {
		return session, err
	}
	if !stat.Mode().IsRegular() {
		return session, fmt.Errorf("请选择录像文件")
	}
	tools, err := highlight.FindTools(s.ToolsDir)
	if err != nil {
		return session, err
	}
	var analysis, options any
	var clips []highlight.Clip
	if req.Mode == "damage" {
		o := highlight.DefaultDamageOptions()
		r, e := tools.AnalyzeDamage(ctx, source, o)
		if e != nil {
			return session, e
		}
		analysis, options, clips = r, o, r.Clips
	} else {
		o := highlight.DefaultAudioOptions()
		r, e := tools.AnalyzeAudio(ctx, source, o)
		if e != nil {
			return session, e
		}
		analysis, options, clips = r, o, r.Clips
	}
	if err := ctx.Err(); err != nil {
		return session, err
	}
	after, err := os.Stat(source)
	if err != nil {
		return session, err
	}
	if after.Size() != stat.Size() || after.ModTime() != stat.ModTime() {
		return session, fmt.Errorf("录像在分析期间发生变化，请重新分析")
	}
	root := filepath.Join(s.OutputDirectory(), ".analysis")
	root, err = filepath.Abs(root)
	if err != nil {
		return session, err
	}
	if err = os.MkdirAll(root, 0755); err != nil {
		return session, err
	}
	dir, err := os.MkdirTemp(root, "apex-")
	if err != nil {
		return session, err
	}
	// Keep the CLI's top-level analysis fields so its render command can read this file.
	b, err := json.Marshal(analysis)
	if err != nil {
		os.RemoveAll(dir)
		return session, err
	}
	var payload map[string]any
	if err = json.Unmarshal(b, &payload); err != nil {
		os.RemoveAll(dir)
		return session, err
	}
	payload["format_version"], payload["input"], payload["mode"], payload["options"] = 1, source, req.Mode, options
	b, err = json.MarshalIndent(payload, "", "  ")
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "analysis.json"), b, 0644)
	}
	if err != nil {
		os.RemoveAll(dir)
		return session, err
	}
	return Session{source, dir, clips, stat.Size(), stat.ModTime().UnixNano()}, nil
}

// OutputDirectory is also used by the UI before any output is created.
func (s Service) OutputDirectory() string {
	root := s.OutputRoot
	if root == "" {
		root = "outputs"
	}
	if absolute, err := filepath.Abs(root); err == nil {
		return absolute
	}
	return root
}

type ExportResult struct {
	Directory string
	Files     []string
}

func exportName(source string, suffix int) string {
	name := strings.TrimSuffix(filepath.Base(source), filepath.Ext(source))
	if name == "" || name == "." || name == ".." {
		name = "recording"
	}
	if suffix > 1 {
		name = fmt.Sprintf("%s_%d", name, suffix)
	}
	return name
}

// PreviewDirectories reserves names only in memory. Export still uses exclusive
// Mkdir because another process may create a directory after confirmation.
func PreviewDirectories(root string, sources []string) []string {
	paths := make([]string, 0, len(sources))
	reserved := map[string]bool{}
	for _, source := range sources {
		for suffix := 1; ; suffix++ {
			path := filepath.Join(root, exportName(source, suffix))
			_, err := os.Lstat(path)
			if !reserved[path] && os.IsNotExist(err) {
				reserved[path] = true
				paths = append(paths, path)
				break
			}
			// Permission and other errors must not cause an infinite naming loop.
			if err != nil && !os.IsNotExist(err) {
				paths = append(paths, path)
				break
			}
		}
	}
	return paths
}

// ExportClips publishes one file per selected interval, ordered by start time.
// A source is the rollback boundary: only this call's new directory is removed
// on failure; completed exports from other sources are never touched.
func (s Service) ExportClips(ctx context.Context, session Session, selected []bool, mode highlight.RenderMode) (ExportResult, error) {
	empty := ExportResult{}
	if err := ctx.Err(); err != nil {
		return empty, err
	}
	if len(selected) != len(session.Clips) {
		return empty, fmt.Errorf("候选选择不匹配")
	}
	clips := make([]highlight.Clip, 0)
	for i, yes := range selected {
		if yes {
			clips = append(clips, session.Clips[i])
		}
	}
	if len(clips) == 0 {
		return empty, fmt.Errorf("请至少选择一个片段")
	}
	if mode != highlight.Precise && mode != highlight.Fast {
		return empty, fmt.Errorf("未知剪辑模式")
	}
	sort.SliceStable(clips, func(i, j int) bool { return clips[i].Start < clips[j].Start })
	stat, err := os.Stat(session.Source)
	if err != nil {
		return empty, err
	}
	if stat.Size() != session.size || stat.ModTime().UnixNano() != session.modified {
		return empty, fmt.Errorf("源录像发生变化，请重新分析")
	}
	tools, err := highlight.FindTools(s.ToolsDir)
	if err != nil {
		return empty, err
	}
	root := s.OutputDirectory()
	if err = os.MkdirAll(root, 0755); err != nil {
		return empty, err
	}
	var dir string
	for suffix := 1; ; suffix++ {
		if err = ctx.Err(); err != nil {
			return empty, err
		}
		dir = filepath.Join(root, exportName(session.Source, suffix))
		err = os.Mkdir(dir, 0755)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			return empty, err
		}
	}
	complete := false
	defer func() {
		if !complete {
			os.RemoveAll(dir)
		}
	}()
	result := ExportResult{Directory: dir}
	for i, clip := range clips {
		if err = ctx.Err(); err != nil {
			return empty, err
		}
		output := filepath.Join(dir, fmt.Sprintf("clip_%03d.mp4", i+1))
		if _, err = tools.Render(ctx, session.Source, []highlight.Clip{clip}, output, mode); err != nil {
			return empty, err
		}
		result.Files = append(result.Files, output)
	}
	if err = ctx.Err(); err != nil {
		return empty, err
	}
	complete = true
	return result, nil
}
