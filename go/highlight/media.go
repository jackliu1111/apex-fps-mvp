package highlight

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"apex-highlight/internal/native"
)

type Tools struct {
	FFmpeg  string
	FFprobe string
}

// FindTools keeps the public media facade while selecting built-in tools only.
// An explicit external tools directory is rejected instead of silently ignored.
func FindTools(dir string) (Tools, error) {
	if dir != "" {
		return Tools{}, fmt.Errorf("this build contains its media tools; remove --tools-dir")
	}
	return Tools{"ffmpeg", "ffprobe"}, nil
}

// stream always reaps the child, including when decoding fails. stderr is
// disk-backed to avoid a full pipe blocking FFmpeg or growing memory indefinitely.
func (t Tools) stream(ctx context.Context, tool string, args []string, consume func(io.Reader) error) error {
	if tool == "" {
		return fmt.Errorf("media tool path is empty")
	}
	if tool == t.FFmpeg {
		args = append([]string{"-nostdin"}, args...)
	}
	errors, err := os.CreateTemp("", "apex-media-errors-*")
	if err != nil {
		return err
	}
	defer os.Remove(errors.Name())
	defer errors.Close()
	cmd, err := native.Command(ctx, tool, args...)
	if err != nil {
		return err
	}
	cmd.Stderr = errors
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		pipe.Close()
		return err
	}
	readErr := consume(pipe)
	if readErr != nil {
		_ = cmd.Process.Kill()
	} else {
		_, readErr = io.Copy(io.Discard, pipe)
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if readErr != nil {
		return fmt.Errorf("%s decoding: %w", filepath.Base(tool), readErr)
	}
	if waitErr != nil {
		s, _ := errors.Stat()
		if s != nil {
			_, _ = errors.Seek(max(0, s.Size()-4096), io.SeekStart)
		}
		tail, _ := io.ReadAll(errors)
		return fmt.Errorf("%s failed: %w: %s", filepath.Base(tool), waitErr, strings.TrimSpace(string(tail)))
	}
	return readErr
}

func (t Tools) run(ctx context.Context, tool string, args ...string) error {
	return t.stream(ctx, tool, args, func(r io.Reader) error { _, err := io.Copy(io.Discard, r); return err })
}

type Stream struct {
	Index     int    `json:"index"`
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	FrameRate string `json:"r_frame_rate"`
}

type Media struct {
	Duration float64  `json:"duration_seconds"`
	Streams  []Stream `json:"streams"`
}

func (m Media) HasAudio() bool {
	for _, s := range m.Streams {
		if s.CodecType == "audio" {
			return true
		}
	}
	return false
}
func (m Media) Video() (Stream, error) {
	for _, s := range m.Streams {
		if s.CodecType == "video" {
			return s, nil
		}
	}
	return Stream{}, fmt.Errorf("input has no video stream")
}

func (t Tools) Probe(ctx context.Context, source string) (Media, error) {
	var data struct {
		Streams []Stream `json:"streams"`
		Format  struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	var buf bytes.Buffer
	err := t.stream(ctx, t.FFprobe, []string{"-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate", "-of", "json", source}, func(r io.Reader) error { _, e := io.Copy(&buf, io.LimitReader(r, 4*1024*1024)); return e })
	if err != nil {
		return Media{}, err
	}
	if err = json.Unmarshal(buf.Bytes(), &data); err != nil {
		return Media{}, err
	}
	d, err := strconv.ParseFloat(data.Format.Duration, 64)
	if err != nil {
		return Media{}, err
	}
	if err = validateDuration(d); err != nil {
		return Media{}, err
	}
	return Media{d, data.Streams}, nil
}

func (t Tools) Check(ctx context.Context) error {
	if err := t.run(ctx, t.FFmpeg, "-version"); err != nil {
		return err
	}
	if err := t.run(ctx, t.FFprobe, "-version"); err != nil {
		return err
	}
	return t.run(ctx, "ffplay", "-version")
}
