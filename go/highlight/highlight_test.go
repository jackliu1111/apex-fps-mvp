package highlight

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func readFixture(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func TestHUDPythonParity(t *testing.T) {
	var expected []int
	readFixture(t, "hud_expected.json", &expected)
	b, err := os.ReadFile("testdata/hud.rgb")
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != len(expected)*HUDFrameBytes {
		t.Fatal("fixture size mismatch")
	}
	for i, want := range expected {
		v, e := ReadCounter(b[i*HUDFrameBytes : (i+1)*HUDFrameBytes])
		if e != nil {
			t.Fatal(e)
		}
		got := -1
		if v != nil {
			got = *v
		}
		if got != want {
			t.Errorf("frame %d: got %d, want %d", i, got, want)
		}
	}
	if _, err = ReadCounter(b[:3]); err == nil {
		t.Fatal("accepted incomplete crop")
	}
}

func TestFourDigitsNotTruncated(t *testing.T) {
	f := make([]byte, HUDFrameBytes)
	for i, n := range []int{1, 0, 1, 0} {
		for p, v := range banks["white_180"][n] {
			if v {
				y, x := 24+p/20, 65+i*22+p%20
				for c := 0; c < 3; c++ {
					f[(y*200+x)*3+c] = 255
				}
			}
		}
	}
	if got, ok := classify(f, "white_180"); !ok || got != 1010 {
		t.Fatalf("got %d, %v", got, ok)
	}
}

func TestTrackerPythonParity(t *testing.T) {
	var data struct {
		Values []*int
		Events []DamageEvent
		Clips  []Clip
	}
	readFixture(t, "tracker_golden.json", &data)
	tracker := CounterTracker{}
	events := []DamageEvent{}
	for i, v := range data.Values {
		if e := tracker.Update(float64(i)/30, v); e != nil {
			events = append(events, *e)
		}
	}
	if !reflect.DeepEqual(events, data.Events) {
		t.Fatalf("events: %#v != %#v", events, data.Events)
	}
	clips, err := DamageClips(events, 1, DefaultDamageOptions())
	if err != nil {
		t.Fatal(err)
	}
	assertClips(t, clips, data.Clips)
}

func TestDamageBoundaries(t *testing.T) {
	clips, err := DamageClips([]DamageEvent{{Time: .05}, {Time: .35}, {Time: .8}}, 1, DefaultDamageOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(clips) != 2 || clips[0].Start != 0 || math.Abs(clips[0].End-.55) > 1e-9 || clips[1].End != 1 || clips[0].EventCount != 2 {
		t.Fatalf("%+v", clips)
	}
	o := DefaultDamageOptions()
	o.Gap = .01
	o.Before = .2
	o.After = .2
	clips, err = DamageClips([]DamageEvent{{Time: .3}, {Time: .5}}, 1, o)
	if err != nil || len(clips) != 1 || clips[0].EventCount != 2 {
		t.Fatalf("overlapping padding: %+v %v", clips, err)
	}
}

func TestAudioPythonParity(t *testing.T) {
	var cases []struct {
		RMS       []float64
		Options   AudioOptions
		Duration  float64
		Threshold float64
		Events    []Event
		Clips     []Clip
	}
	readFixture(t, "audio_golden.json", &cases)
	for i, c := range cases {
		threshold, events, err := DetectAudioEvents(c.RMS, c.Options)
		if err != nil {
			t.Fatal(err)
		}
		if math.Abs(threshold-c.Threshold) > 1e-5 {
			t.Errorf("case %d threshold: %.9f != %.9f", i, threshold, c.Threshold)
		}
		if !reflect.DeepEqual(events, c.Events) {
			t.Errorf("case %d events: %+v != %+v", i, events, c.Events)
		}
		clips, err := AudioClips(events, c.Duration, c.Options)
		if err != nil {
			t.Fatal(err)
		}
		assertClips(t, clips, c.Clips)
	}
	_, events, err := DetectAudioEvents([]float64{-240, -240, -240}, DefaultAudioOptions())
	if err != nil || len(events) != 0 {
		t.Fatalf("silence generated events: %v %v", events, err)
	}
}

func assertClips(t *testing.T, got, want []Clip) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("clip count %d != %d", len(got), len(want))
	}
	for i, c := range got {
		w := want[i]
		for j, v := range []float64{c.Start - w.Start, c.End - w.End, c.RawStart - w.RawStart, c.RawEnd - w.RawEnd, c.PeakDBFS - w.PeakDBFS} {
			if math.Abs(v) > 1e-8 {
				t.Errorf("clip %d field %d mismatch: %+v != %+v", i, j, c, w)
			}
		}
		if c.EventCount != w.EventCount || c.ExceedsMaxDuration != w.ExceedsMaxDuration {
			t.Errorf("clip metadata mismatch: %+v != %+v", c, w)
		}
	}
}

func TestRMSFrames(t *testing.T) {
	var buf bytes.Buffer
	for _, v := range []float32{.5, -.5, 0, 0, .7} {
		if err := binary.Write(&buf, binary.LittleEndian, v); err != nil {
			t.Fatal(err)
		}
	}
	rms, err := RMSFrames(&buf, 1000, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(rms) != 2 || math.Abs(rms[0]-(-6.020600)) > 1e-5 || rms[1] != -240 {
		t.Fatalf("unexpected RMS %v", rms)
	}
}

func TestInvalidParameters(t *testing.T) {
	d := DefaultDamageOptions()
	d.FPS = 0
	if d.Validate() == nil {
		t.Fatal("accepted zero FPS")
	}
	d = DefaultDamageOptions()
	d.Gap = math.NaN()
	if d.Validate() == nil {
		t.Fatal("accepted NaN")
	}
	a := DefaultAudioOptions()
	a.FrameMS = math.Inf(1)
	if a.Validate() == nil {
		t.Fatal("accepted infinity")
	}
	if _, _, err := DetectAudioEvents([]float64{math.NaN()}, DefaultAudioOptions()); err == nil {
		t.Fatal("accepted NaN RMS")
	}
	if _, err := DamageClips([]DamageEvent{{Time: 2}}, 1, DefaultDamageOptions()); err == nil {
		t.Fatal("accepted out-of-range event")
	}
}

// Run explicitly with APEX_MEDIA_TEST=1. A missing FFmpeg is a failure when enabled.
func TestMediaIntegration(t *testing.T) {
	if os.Getenv("APEX_MEDIA_TEST") != "1" {
		t.Skip("set APEX_MEDIA_TEST=1 for FFmpeg integration")
	}
	tools, err := FindTools("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "录 像's folder")
	if err = os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "input.mkv")
	if err = tools.run(ctx, tools.FFmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=16000:duration=2", "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-shortest", source); err != nil {
		t.Fatal(err)
	}
	m, err := tools.Probe(ctx, source)
	if err != nil || math.Abs(m.Duration-2) > .01 {
		t.Fatalf("probe: %+v %v", m, err)
	}
	a, err := tools.AnalyzeAudio(ctx, source, DefaultAudioOptions())
	if err != nil || a.FrameCount != 80 {
		t.Fatalf("audio: %+v %v", a, err)
	}
	d, err := tools.AnalyzeDamage(ctx, source, DefaultDamageOptions())
	if err != nil {
		t.Fatal(err)
	}
	if d.Stats.SampledFrames != 60 || len(d.Events) != 0 {
		t.Fatalf("background produced unexpected readings/events: %+v", d)
	}
	clips := []Clip{{Start: .105, End: .295}, {Start: 1.01, End: 1.21}}
	for _, mode := range []RenderMode{Precise, Fast} {
		output := filepath.Join(dir, string(mode)+".mp4")
		info, err := tools.Render(ctx, source, clips, output, mode)
		if err != nil {
			t.Fatal(err)
		}
		p, err := tools.Probe(ctx, output)
		if err != nil || p.Duration <= 0 {
			t.Fatalf("render probe: %+v %v", p, err)
		}
		if mode == Precise {
			expected := float64(info.Intervals[0].Frames+info.Intervals[1].Frames) / 30
			if math.Abs(p.Duration-expected) > .1 {
				t.Fatalf("duration %.6f != %.6f", p.Duration, expected)
			}
		}
		original, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tools.Render(ctx, source, clips, output, mode); err == nil {
			t.Fatal("overwrote existing output")
		}
		after, _ := os.ReadFile(output)
		if !bytes.Equal(original, after) {
			t.Fatal("existing output changed")
		}
	}
	if _, err = tools.Render(ctx, source, clips, source, Precise); err == nil {
		t.Fatal("allowed source overwrite")
	}
	if _, err = tools.Render(ctx, source, []Clip{{Start: 0, End: 3}}, filepath.Join(dir, "invalid.mp4"), Precise); err == nil {
		t.Fatal("accepted invalid interval")
	}
	if _, err = tools.Probe(ctx, filepath.Join(dir, "missing.mkv")); err == nil || !strings.Contains(err.Error(), "failed") {
		t.Fatalf("lost media error: %v", err)
	}
	items, _ := filepath.Glob(filepath.Join(dir, ".apex-render-*"))
	if len(items) != 0 {
		t.Fatalf("staging leaked: %v", items)
	}
	// Damage recognition and supplied-interval rendering also support silent
	// video files; only audio analysis requires an audio stream.
	silent := filepath.Join(dir, "no-audio.mkv")
	if err = tools.run(ctx, tools.FFmpeg, "-v", "error", "-i", source, "-an", "-c:v", "copy", silent); err != nil {
		t.Fatal(err)
	}
	if _, err = tools.AnalyzeAudio(ctx, silent, DefaultAudioOptions()); err == nil {
		t.Fatal("audio mode accepted a file without audio")
	}
	if _, err = tools.AnalyzeDamage(ctx, silent, DefaultDamageOptions()); err != nil {
		t.Fatal(err)
	}
	if _, err = tools.Render(ctx, silent, clips, filepath.Join(dir, "silent.mp4"), Precise); err != nil {
		t.Fatal(err)
	}
	// The process wrapper must surface a decoder failure and reap the child.
	err = tools.stream(ctx, tools.FFmpeg, []string{"-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "rawvideo", "-"}, func(r io.Reader) error {
		buf := make([]byte, 16)
		if _, e := io.ReadFull(r, buf); e != nil {
			return e
		}
		return fmt.Errorf("intentional decoder failure")
	})
	if err == nil || !strings.Contains(err.Error(), "intentional decoder failure") {
		t.Fatalf("lost decoder failure: %v", err)
	}
}
