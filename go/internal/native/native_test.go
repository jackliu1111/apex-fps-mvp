package native

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkersUseSameExecutableWithoutPATH(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("SDL_DYNAMIC_API", "/must-not-load-an-external-SDL-library")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"ffmpeg", "ffprobe", "ffplay"} {
		cmd, err := Command(context.Background(), tool, "-version")
		if err != nil || cmd.Path != executable {
			t.Fatalf("%s did not use this executable: %v %v", tool, cmd, err)
		}
		for _, setting := range cmd.Env {
			if strings.HasPrefix(setting, "SDL_DYNAMIC_API=") {
				t.Fatal("allowed replacement of the statically linked SDL")
			}
		}
		out, err := cmd.CombinedOutput()
		if err != nil || !strings.Contains(string(out), tool+" version 7.1.1") {
			t.Fatalf("%s: %v %s", tool, err, out)
		}
	}
}

func TestWorkerValidationAndCancellation(t *testing.T) {
	if _, err := Command(context.Background(), "/tmp/ffmpeg"); err == nil {
		t.Fatal("accepted an external executable")
	}
	if _, err := Command(context.Background(), "ffmpeg", "a\x00b"); err == nil {
		t.Fatal("accepted NUL argument")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	cmd, err := Command(ctx, "ffmpeg", "-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i", "sine", "-f", "null", "-")
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Run(); err == nil || ctx.Err() == nil || cmd.ProcessState == nil {
		t.Fatalf("worker was not cancelled and reaped: %v", err)
	}
}

func TestHeadlessPlayback(t *testing.T) {
	t.Setenv("SDL_VIDEODRIVER", "dummy")
	t.Setenv("SDL_AUDIODRIVER", "dummy")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	source := filepath.Join(t.TempDir(), "预览 sample.wav")
	makeAudio, _ := Command(ctx, "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.4", source)
	if out, err := makeAudio.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	play, _ := Command(ctx, "ffplay", "-nodisp", "-autoexit", "-loglevel", "error", source)
	if out, err := play.CombinedOutput(); err != nil {
		t.Fatalf("playback: %v %s", err, out)
	}
}
