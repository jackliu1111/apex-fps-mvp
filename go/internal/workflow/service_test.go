package workflow

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"apex-highlight/highlight"
	"apex-highlight/internal/native"
)

func TestRejectInvalidRequests(t *testing.T) {
	s := Service{}
	if _, err := s.Analyze(context.Background(), Request{Mode: "bad"}); err == nil {
		t.Fatal("accepted mode")
	}
	if _, err := s.ExportClips(context.Background(), Session{Clips: []highlight.Clip{{Start: 1, End: 2}}}, nil, highlight.Precise); err == nil {
		t.Fatal("accepted mismatched selection")
	}
	if _, err := s.ExportClips(context.Background(), Session{}, nil, highlight.Precise); err == nil {
		t.Fatal("accepted empty")
	}
}
func TestMediaWorkflow(t *testing.T) {
	if os.Getenv("APEX_MEDIA_TEST") != "1" {
		t.Skip("set APEX_MEDIA_TEST=1")
	}
	root := t.TempDir()
	source := filepath.Join(root, "录像 sample.mp4")
	cmd := mediaCommand(t, "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=2", "-c:v", "mpeg4", source)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	svc := Service{OutputRoot: root}
	session, err := svc.Analyze(context.Background(), Request{Source: source, Mode: "damage"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(session.Directory, "analysis.json")); err != nil {
		t.Fatal(err)
	}
	session.Clips = []highlight.Clip{{Start: 0, End: .5}, {Start: 1, End: 1.5}}
	output, err := svc.ExportClips(context.Background(), session, []bool{false, true}, highlight.Precise)
	if err != nil {
		t.Fatal(err)
	}
	tools, err := highlight.FindTools("")
	if err != nil {
		t.Fatal(err)
	}
	media, err := tools.Probe(context.Background(), output.Files[0])
	if err != nil || media.Duration < .4 || media.Duration > .7 {
		t.Fatalf("%+v %v", media, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = svc.ExportClips(ctx, session, []bool{true, false}, highlight.Precise); err == nil {
		t.Fatal("accepted cancellation")
	}
	dirs, _ := filepath.Glob(filepath.Join(root, "录像 sample*"))
	if len(dirs) != 2 {
		t.Fatal("failed export not cleaned")
	}
	if err = os.WriteFile(source, []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ExportClips(context.Background(), session, []bool{true, false}, highlight.Precise); err == nil {
		t.Fatal("accepted changed source")
	}
}

func TestPreviewDirectories(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "录像")
	if err := os.Mkdir(existing, 0755); err != nil {
		t.Fatal(err)
	}
	paths := PreviewDirectories(root, []string{"/a/录像.mp4", "/b/录像.mkv", "/a/other.mov"})
	for i, name := range []string{"录像_2", "录像_3", "other"} {
		if paths[i] != filepath.Join(root, name) {
			t.Fatal(paths)
		}
		if _, err := os.Stat(paths[i]); !os.IsNotExist(err) {
			t.Fatal("preview created output")
		}
	}
	// A non-directory ancestor produces ENOTDIR, not an endless suffix loop.
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if len(PreviewDirectories(filepath.Join(file, "child"), []string{"x.mp4"})) != 1 {
		t.Fatal("invalid root")
	}
}

func TestSeparateExportsAndRollback(t *testing.T) {
	if os.Getenv("APEX_MEDIA_TEST") != "1" {
		t.Skip("set APEX_MEDIA_TEST=1")
	}
	root := t.TempDir()
	svc := Service{OutputRoot: filepath.Join(root, "outputs")}
	tools, err := highlight.FindTools("")
	if err != nil {
		t.Fatal(err)
	}
	var sessions []Session
	for _, name := range []string{"first", "second"} {
		source := filepath.Join(root, name+".mp4")
		cmd := mediaCommand(t, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-c:v", "mpeg4", source)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
		session, err := svc.Analyze(context.Background(), Request{Source: source, Mode: "damage"})
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Dir(session.Directory) != filepath.Join(svc.OutputRoot, ".analysis") {
			t.Fatal("analysis mixed with videos")
		}
		// Deliberately unsorted, and a third unselected interval.
		session.Clips = []highlight.Clip{{Start: 1, End: 2}, {Start: 0, End: .5}, {Start: 2, End: 2.2}}
		sessions = append(sessions, session)
		result, err := svc.ExportClips(context.Background(), session, []bool{true, true, false}, highlight.Precise)
		if err != nil {
			t.Fatal(err)
		}
		if result.Directory != filepath.Join(svc.OutputRoot, name) || len(result.Files) != 2 {
			t.Fatal(result)
		}
		entries, _ := os.ReadDir(result.Directory)
		if len(entries) != 2 {
			t.Fatal("extra files or merged video")
		}
		for i, file := range result.Files {
			if filepath.Base(file) != []string{"clip_001.mp4", "clip_002.mp4"}[i] {
				t.Fatal(file)
			}
			media, err := tools.Probe(context.Background(), file)
			expected := []float64{.5, 1}[i]
			if err != nil || media.Duration < expected-.1 || media.Duration > expected+.1 {
				t.Fatalf("wrong interval order/duration: %+v %v", media, err)
			}
			if out, err := mediaCommand(t, "-v", "error", "-i", file, "-f", "null", "-").CombinedOutput(); err != nil {
				t.Fatalf("decode: %v %s", err, out)
			}
		}
	}
	original := filepath.Join(svc.OutputRoot, "first", "clip_001.mp4")
	before, err := os.ReadFile(original)
	if err != nil {
		t.Fatal(err)
	}
	again, err := svc.ExportClips(context.Background(), sessions[0], []bool{false, true, false}, highlight.Fast)
	if err != nil || again.Directory != filepath.Join(svc.OutputRoot, "first_2") {
		t.Fatal(again, err)
	}
	// Second interval fails after the first has been exported; remove only first_3.
	bad := sessions[0]
	bad.Clips = []highlight.Clip{{Start: 0, End: .5}, {Start: 4, End: 5}}
	if _, err := svc.ExportClips(context.Background(), bad, []bool{true, true}, highlight.Precise); err == nil {
		t.Fatal("invalid interval accepted")
	}
	if _, err := os.Stat(filepath.Join(svc.OutputRoot, "first_3")); !os.IsNotExist(err) {
		t.Fatal("partial export retained")
	}
	after, err := os.ReadFile(original)
	if err != nil || string(before) != string(after) {
		t.Fatal("previous output changed")
	}
	if _, err := os.Stat(filepath.Join(svc.OutputRoot, "second", "clip_002.mp4")); err != nil {
		t.Fatal("other source output removed")
	}
	// Different source with the same stem must also obtain a new directory.
	dir := filepath.Join(root, "elsewhere")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(sessions[0].Source)
	source := filepath.Join(dir, "first.mp4")
	if err := os.WriteFile(source, data, 0644); err != nil {
		t.Fatal(err)
	}
	session, err := svc.Analyze(context.Background(), Request{Source: source, Mode: "damage"})
	if err != nil {
		t.Fatal(err)
	}
	session.Clips = []highlight.Clip{{Start: 0, End: .5}}
	result, err := svc.ExportClips(context.Background(), session, []bool{true}, highlight.Precise)
	if err != nil || result.Directory != filepath.Join(svc.OutputRoot, "first_3") {
		t.Fatal(result, err)
	}
	// Cancel after a real first file is published, while more clips remain.
	// The whole new source directory must roll back, not just its temporary files.
	partial := sessions[0]
	partial.Clips = make([]highlight.Clip, 20)
	selected := make([]bool, 20)
	for i := range partial.Clips {
		partial.Clips[i] = highlight.Clip{Start: 0, End: .5}
		selected[i] = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	observed := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := os.Stat(filepath.Join(svc.OutputRoot, "first_4", "clip_001.mp4")); err == nil {
					close(observed)
					cancel()
					return
				}
			}
		}
	}()
	_, err = svc.ExportClips(ctx, partial, selected, highlight.Precise)
	cancel()
	<-watcherDone
	if err == nil {
		t.Fatal("mid-export cancellation accepted")
	}
	select {
	case <-observed:
	default:
		t.Fatal("did not exercise cancellation after publication")
	}
	if _, err := os.Stat(filepath.Join(svc.OutputRoot, "first_4")); !os.IsNotExist(err) {
		t.Fatal("canceled partial directory retained")
	}
	if _, err := os.Stat(original); err != nil {
		t.Fatal("cancel removed completed export")
	}
}

// Fixtures and output decoding use the same statically linked worker as production.
func mediaCommand(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	cmd, err := native.Command(context.Background(), "ffmpeg", args...)
	if err != nil {
		t.Fatal(err)
	}
	return cmd
}
