// Package highlight detects candidate highlights and renders supplied intervals.
// It has no UI, task registry, selection state, or result-file persistence.
package highlight

import (
	"fmt"
	"math"
)

type Event struct {
	Start        float64 `json:"start"`
	End          float64 `json:"end"`
	PeakDBFS     float64 `json:"peak_dbfs"`
	ActiveFrames int     `json:"active_frames"`
}

type Clip struct {
	Start              float64 `json:"start"`
	End                float64 `json:"end"`
	RawStart           float64 `json:"raw_start"`
	RawEnd             float64 `json:"raw_end"`
	EventCount         int     `json:"event_count"`
	PeakDBFS           float64 `json:"peak_dbfs"`
	ExceedsMaxDuration bool    `json:"exceeds_max_duration"`
}

type AudioOptions struct {
	SampleRate          int     `json:"sample_rate"`
	FrameMS             float64 `json:"frame_ms"`
	ThresholdPercentile float64 `json:"threshold_percentile"`
	EventBridgeMS       float64 `json:"event_bridge_ms"`
	FightGap            float64 `json:"fight_gap_s"`
	MinEvents           int     `json:"min_events"`
	Before              float64 `json:"before_s"`
	After               float64 `json:"after_s"`
	MaxClip             float64 `json:"max_clip_s"`
}

func DefaultAudioOptions() AudioOptions {
	return AudioOptions{16000, 25, 96, 200, 4, 4, 5, 8, 60}
}

func (o AudioOptions) Validate() error {
	if !finite(o.FrameMS, o.ThresholdPercentile, o.EventBridgeMS, o.FightGap, o.Before, o.After, o.MaxClip) ||
		o.SampleRate <= 0 || o.FrameMS <= 0 || o.ThresholdPercentile <= 0 || o.ThresholdPercentile >= 100 ||
		o.EventBridgeMS < 0 || o.FightGap < 0 || o.MinEvents <= 0 || o.Before < 0 || o.After < 0 || o.MaxClip <= 0 {
		return fmt.Errorf("invalid audio parameters")
	}
	return nil
}

type DamageOptions struct {
	FPS    int     `json:"sampling_fps"`
	Gap    float64 `json:"gap_s"`
	Before float64 `json:"before_s"`
	After  float64 `json:"after_s"`
}

func DefaultDamageOptions() DamageOptions { return DamageOptions{30, .3, .1, .2} }

func (o DamageOptions) Validate() error {
	if o.FPS < 10 || o.FPS > 60 || !finite(o.Gap, o.Before, o.After) || o.Gap < 0 || o.Before < 0 || o.After < 0 {
		return fmt.Errorf("damage FPS must be 10–60; gap and padding must be finite and nonnegative")
	}
	return nil
}

func finite(values ...float64) bool {
	for _, v := range values {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}

func rounded(v float64, digits int) float64 {
	p := math.Pow10(digits)
	return math.RoundToEven(v*p) / p
}

func validateDuration(duration float64) error {
	if !finite(duration) || duration <= 0 {
		return fmt.Errorf("invalid media duration")
	}
	return nil
}

func validateClips(clips []Clip, duration float64) error {
	if len(clips) == 0 {
		return fmt.Errorf("no intervals to render")
	}
	for i, c := range clips {
		if !finite(c.Start, c.End) || c.Start < 0 || c.Start >= c.End || c.End > duration+.001 {
			return fmt.Errorf("invalid interval %d", i+1)
		}
	}
	return nil
}
