// Package native runs statically linked FFmpeg tools in workers of this very
// executable. Upstream CLI globals, signal handlers and exit() stay isolated
// from the TUI; no executable is extracted, downloaded or looked up in PATH.
package native

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const workerFlag = "--apex-media-worker"

var _ = mediaRequiresCGO

func Command(ctx context.Context, tool string, args ...string) (*exec.Cmd, error) {
	if tool != "ffmpeg" && tool != "ffprobe" && tool != "ffplay" {
		return nil, fmt.Errorf("unknown built-in media tool %q", tool)
	}
	for _, arg := range args {
		for _, c := range arg {
			if c == 0 {
				return nil, fmt.Errorf("media argument contains NUL")
			}
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, executable, append([]string{workerFlag, tool}, args...)...)
	// SDL's optional dynamic-API override must not replace the built-in library.
	for _, setting := range os.Environ() {
		key, _, _ := strings.Cut(setting, "=")
		if !strings.EqualFold(key, "SDL_DYNAMIC_API") {
			cmd.Env = append(cmd.Env, setting)
		}
	}
	return cmd, nil
}
