package highlight

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type RenderMode string

const (
	Precise RenderMode = "precise"
	Fast    RenderMode = "fast"
)

type RenderedInterval struct {
	Start  float64 `json:"start"`
	End    float64 `json:"end"`
	Frames int     `json:"frames,omitempty"`
}
type RenderInfo struct {
	Mode      RenderMode         `json:"mode"`
	Intervals []RenderedInterval `json:"rendered_intervals"`
}

// Render processes the supplied intervals in their supplied order. It neither
// selects clips nor persists selection state. Output must be a new file.
// Precise uses CFR frame-aligned MPEG-4/AAC; Fast copies packets and may include
// content outside the requested boundaries because of keyframe dependencies.
func (t Tools) Render(ctx context.Context, source string, clips []Clip, output string, mode RenderMode) (RenderInfo, error) {
	info := RenderInfo{Mode: mode, Intervals: []RenderedInterval{}}
	if mode != Precise && mode != Fast {
		return info, fmt.Errorf("render mode must be precise or fast")
	}
	source, err := filepath.Abs(source)
	if err != nil {
		return info, err
	}
	output, err = filepath.Abs(output)
	if err != nil {
		return info, err
	}
	if source == output {
		return info, fmt.Errorf("cannot overwrite source recording")
	}
	if _, err = os.Lstat(output); err == nil {
		return info, fmt.Errorf("output already exists: %s", output)
	} else if !os.IsNotExist(err) {
		return info, err
	}
	ext := strings.ToLower(filepath.Ext(output))
	if ext != ".mp4" && ext != ".mkv" && ext != ".mov" {
		return info, fmt.Errorf("output must be .mp4, .mkv or .mov")
	}
	media, err := t.Probe(ctx, source)
	if err != nil {
		return info, err
	}
	video, err := media.Video()
	if err != nil {
		return info, err
	}
	if err = validateClips(clips, media.Duration); err != nil {
		return info, err
	}
	rate := 0.
	if mode == Precise {
		rate, err = frameRate(video.FrameRate)
		if err != nil {
			return info, err
		}
	}
	if err = os.MkdirAll(filepath.Dir(output), 0755); err != nil {
		return info, err
	}
	work, err := os.MkdirTemp(filepath.Dir(output), ".apex-render-*")
	if err != nil {
		return info, err
	}
	defer os.RemoveAll(work)
	var listing strings.Builder
	for i, c := range clips {
		segment := filepath.Join(work, fmt.Sprintf("clip_%05d.nut", i))
		start, duration := c.Start, c.End-c.Start
		frames := 0
		if mode == Precise {
			first := math.Ceil(c.Start*rate - 1e-4)
			last := math.Max(first+1, math.Ceil(c.End*rate-1e-4))
			start = first / rate
			duration = (last - first) / rate
			frames = int(last - first)
		}
		args := []string{"-v", "error", "-y", "-ss", decimal(start), "-i", source}
		if mode == Precise {
			args = append(args, "-vf", "trim=duration="+decimal(duration)+",setpts=PTS-STARTPTS", "-map", "0:v:0")
			if media.HasAudio() {
				args = append(args, "-map", "0:a:0", "-af", "atrim=duration="+decimal(duration)+",asetpts=PTS-STARTPTS,apad=whole_dur="+decimal(duration))
			}
			args = append(args, "-t", decimal(duration), "-r", video.FrameRate, "-fps_mode", "cfr", "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", segment)
		} else {
			args = append(args, "-t", decimal(duration), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-avoid_negative_ts", "make_zero", segment)
		}
		if err = t.run(ctx, t.FFmpeg, args...); err != nil {
			return info, err
		}
		// Generated relative filenames avoid Windows drive and apostrophe escaping.
		fmt.Fprintf(&listing, "file '%s'\n", filepath.Base(segment))
		if mode == Precise {
			fmt.Fprintf(&listing, "duration %.9f\n", duration)
		}
		info.Intervals = append(info.Intervals, RenderedInterval{start, start + duration, frames})
	}
	listPath := filepath.Join(work, "concat.txt")
	if err = os.WriteFile(listPath, []byte(listing.String()), 0600); err != nil {
		return info, err
	}
	temp := filepath.Join(work, "output"+ext)
	args := []string{"-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"}
	if mode == Precise {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	} else {
		args = append(args, "-c:a", "copy")
	}
	if ext != ".mkv" {
		args = append(args, "-movflags", "+faststart")
	}
	args = append(args, temp)
	if err = t.run(ctx, t.FFmpeg, args...); err != nil {
		return info, err
	}
	// Same-filesystem hard link provides atomic no-clobber publication. Do not
	// fall back to overwriting if the destination filesystem cannot support it.
	if err = os.Link(temp, output); err != nil {
		return info, fmt.Errorf("publish output without overwrite: %w", err)
	}
	return info, nil
}

func decimal(v float64) string { return strconv.FormatFloat(v, 'f', 9, 64) }
func frameRate(s string) (float64, error) {
	parts := strings.Split(s, "/")
	n, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0, err
	}
	if len(parts) == 2 {
		d, e := strconv.ParseFloat(parts[1], 64)
		if e != nil || d == 0 {
			return 0, fmt.Errorf("invalid video frame rate")
		}
		n /= d
	} else if len(parts) != 1 {
		return 0, fmt.Errorf("invalid video frame rate")
	}
	if !finite(n) || n <= 0 {
		return 0, fmt.Errorf("invalid video frame rate")
	}
	return n, nil
}
