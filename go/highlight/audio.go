package highlight

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
)

type AudioAnalysis struct {
	Duration      float64 `json:"duration_seconds"`
	ThresholdDBFS float64 `json:"threshold_dbfs"`
	FrameCount    int     `json:"frame_count"`
	Events        []Event `json:"events"`
	Clips         []Clip  `json:"clips"`
}

// RMSFrames reads mono little-endian float32 PCM, dropping an incomplete final
// frame exactly like the Python detector. Returned dB values retain float32 rounding.
func RMSFrames(r io.Reader, sampleRate int, frameMS float64) ([]float64, error) {
	if sampleRate <= 0 || !finite(frameMS) || frameMS <= 0 {
		return nil, fmt.Errorf("invalid audio frame size")
	}
	nf := math.Max(1, math.RoundToEven(float64(sampleRate)*frameMS/1000))
	if nf > 16*1024*1024 {
		return nil, fmt.Errorf("audio frame size too large")
	}
	n := int(nf)
	buf := make([]byte, n*4)
	values := []float64{}
	for {
		_, err := io.ReadFull(r, buf)
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return nil, err
		}
		var sum float64
		for i := 0; i < len(buf); i += 4 {
			v := float64(math.Float32frombits(binary.LittleEndian.Uint32(buf[i:])))
			if !finite(v) {
				return nil, fmt.Errorf("non-finite PCM sample")
			}
			sum += v * v
		}
		values = append(values, float64(float32(20*math.Log10(math.Max(math.Sqrt(sum/float64(n)), 1e-12)))))
	}
	if len(values) == 0 {
		return nil, fmt.Errorf("no complete audio frames decoded")
	}
	return values, nil
}

func DetectAudioEvents(rms []float64, o AudioOptions) (float64, []Event, error) {
	if err := o.Validate(); err != nil {
		return 0, nil, err
	}
	if len(rms) == 0 || !finite(rms...) {
		return 0, nil, fmt.Errorf("RMS must be finite and nonempty")
	}
	sorted := append([]float64(nil), rms...)
	sort.Float64s(sorted)
	pos := float64(len(sorted)-1) * o.ThresholdPercentile / 100
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	threshold := sorted[lo] + (sorted[hi]-sorted[lo])*(pos-float64(lo))
	events := []Event{}
	first, last, count := -1, -1, 0
	peak := math.Inf(-1)
	flush := func() {
		if first >= 0 {
			events = append(events, Event{rounded(float64(first)*o.FrameMS/1000, 6), rounded(float64(last+1)*o.FrameMS/1000, 6), rounded(peak, 3), count})
		}
	}
	bridge := int(math.Floor(o.EventBridgeMS / o.FrameMS))
	for i, v := range rms {
		if v <= threshold {
			continue
		}
		if first < 0 || i-last-1 > bridge {
			flush()
			first = i
			count = 0
			peak = math.Inf(-1)
		}
		last = i
		count++
		peak = math.Max(peak, v)
	}
	flush()
	return threshold, events, nil
}

func AudioClips(events []Event, duration float64, o AudioOptions) ([]Clip, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	if err := validateDuration(duration); err != nil {
		return nil, err
	}
	groups := [][]Event{}
	for i, e := range events {
		if !finite(e.Start, e.End, e.PeakDBFS) || e.Start < 0 || e.End < e.Start || (i > 0 && e.Start < events[i-1].Start) {
			return nil, fmt.Errorf("invalid or unordered audio events")
		}
		if len(groups) > 0 {
			g := groups[len(groups)-1]
			if e.Start-g[len(g)-1].End <= o.FightGap {
				groups[len(groups)-1] = append(g, e)
				continue
			}
		}
		groups = append(groups, []Event{e})
	}
	clips := []Clip{}
	for _, g := range groups {
		if len(g) < o.MinEvents {
			continue
		}
		c := Clip{Start: math.Max(0, g[0].Start-o.Before), End: math.Min(duration, g[len(g)-1].End+o.After), RawStart: g[0].Start, RawEnd: g[len(g)-1].End, EventCount: len(g), PeakDBFS: g[0].PeakDBFS}
		for _, e := range g {
			c.PeakDBFS = math.Max(c.PeakDBFS, e.PeakDBFS)
		}
		if c.End <= c.Start {
			continue
		}
		if len(clips) > 0 && c.Start <= clips[len(clips)-1].End {
			p := &clips[len(clips)-1]
			p.End = math.Max(p.End, c.End)
			p.RawEnd = math.Max(p.RawEnd, c.RawEnd)
			p.EventCount += c.EventCount
			p.PeakDBFS = math.Max(p.PeakDBFS, c.PeakDBFS)
		} else {
			clips = append(clips, c)
		}
	}
	for i := range clips {
		c := &clips[i]
		c.Start = rounded(c.Start, 3)
		c.End = rounded(c.End, 3)
		c.RawStart = rounded(c.RawStart, 3)
		c.RawEnd = rounded(c.RawEnd, 3)
		c.PeakDBFS = rounded(c.PeakDBFS, 3)
		c.ExceedsMaxDuration = c.End-c.Start > o.MaxClip
	}
	return clips, nil
}

func (t Tools) AnalyzeAudio(ctx context.Context, source string, o AudioOptions) (AudioAnalysis, error) {
	result := AudioAnalysis{}
	if err := o.Validate(); err != nil {
		return result, err
	}
	media, err := t.Probe(ctx, source)
	if err != nil {
		return result, err
	}
	if !media.HasAudio() {
		return result, fmt.Errorf("input has no audio stream")
	}
	result.Duration = media.Duration
	var rms []float64
	err = t.stream(ctx, t.FFmpeg, []string{"-v", "error", "-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", strconv.Itoa(o.SampleRate), "-f", "f32le", "pipe:1"}, func(r io.Reader) error { var e error; rms, e = RMSFrames(r, o.SampleRate, o.FrameMS); return e })
	if err != nil {
		return result, err
	}
	result.ThresholdDBFS, result.Events, err = DetectAudioEvents(rms, o)
	if err != nil {
		return result, err
	}
	result.FrameCount = len(rms)
	result.Clips, err = AudioClips(result.Events, media.Duration, o)
	return result, err
}
