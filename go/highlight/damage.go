package highlight

import (
	"context"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
)

//go:embed templates.json
var templateJSON []byte

var methods = []string{"white_180", "gray_otsu", "white_otsu"}

type glyph [600]bool
type icon struct {
	values []float64
	norm   float64
}

var banks, icons = loadTemplates()

func loadTemplates() (map[string][10]glyph, []icon) {
	var data struct {
		Digits map[string]string `json:"digits"`
		Icons  []string          `json:"icons"`
	}
	if err := json.Unmarshal(templateJSON, &data); err != nil {
		panic(err)
	}
	banks := map[string][10]glyph{}
	for _, m := range methods {
		var bank [10]glyph
		for n := range bank {
			b, e := hex.DecodeString(data.Digits[fmt.Sprintf("%s_%d", m, n)])
			if e != nil || len(b) != 75 {
				panic("invalid embedded digit template")
			}
			for i := range bank[n] {
				bank[n][i] = (b[i/8] & (1 << uint(7-i%8))) != 0
			}
		}
		banks[m] = bank
	}
	icons := []icon{}
	for _, s := range data.Icons {
		b, e := hex.DecodeString(s)
		if e != nil || len(b) != 19*32 {
			panic("invalid embedded icon template")
		}
		mean := 0.
		for _, v := range b {
			mean += float64(v)
		}
		mean /= float64(len(b))
		t := icon{values: make([]float64, len(b))}
		for i, v := range b {
			t.values[i] = float64(v) - mean
			t.norm += t.values[i] * t.values[i]
		}
		t.norm = math.Sqrt(t.norm)
		icons = append(icons, t)
	}
	return banks, icons
}

const HUDFrameBytes = 200 * 90 * 3

func iconScore(frame []byte) float64 {
	var strip [19][53]float64
	for y := range strip {
		for x := range strip[y] {
			i := ((20+y*2)*200 + x*2) * 3
			strip[y][x] = (float64(frame[i]) + float64(frame[i+1]) + float64(frame[i+2])) / 3
		}
	}
	best := math.Inf(-1)
	for x := 0; x <= 53-32; x++ {
		mean := 0.
		for y := 0; y < 19; y++ {
			for j := 0; j < 32; j++ {
				mean += strip[y][x+j]
			}
		}
		mean /= 19 * 32
		var centered [608]float64
		norm := 0.
		for y := 0; y < 19; y++ {
			for j := 0; j < 32; j++ {
				v := strip[y][x+j] - mean
				centered[y*32+j] = v
				norm += v * v
			}
		}
		norm = math.Sqrt(norm)
		for _, t := range icons {
			dot := 0.
			for i, v := range centered {
				dot += v * t.values[i]
			}
			best = math.Max(best, dot/math.Max(norm*t.norm, 1e-9))
		}
	}
	return best
}

func otsu(values []float64) int {
	var hist [256]float64
	for _, v := range values {
		hist[uint8(v)]++
	}
	total := float64(len(values))
	muTotal := 0.
	for i, h := range hist {
		muTotal += float64(i) * (h / total)
	}
	w, mu, best := 0., 0., -1.
	threshold := 0
	for i, h := range hist {
		p := h / total
		w += p
		mu += p * float64(i)
		d := muTotal*w - mu
		score := d * d / math.Max(w*(1-w), 1e-10)
		if score > best {
			best = score
			threshold = i
		}
	}
	return threshold
}

func binaryMask(frame []byte, method string) [][]bool {
	low := make([]float64, 31*160)
	gray := make([]float64, len(low))
	chroma := make([]float64, len(low))
	for y := 0; y < 31; y++ {
		for x := 0; x < 160; x++ {
			i := ((24+y)*200 + x) * 3
			r, g, b := frame[i], frame[i+1], frame[i+2]
			j := y*160 + x
			low[j] = float64(min(r, g, b))
			gray[j] = (float64(r) + float64(g) + float64(b)) / 3
			chroma[j] = float64(max(r, g, b)) - low[j]
		}
	}
	threshold := 180.
	if method == "gray_otsu" {
		threshold = float64(otsu(gray))
	}
	if method == "white_otsu" {
		threshold = math.Max(140, float64(otsu(low)))
	}
	mask := make([][]bool, 31)
	for y := range mask {
		mask[y] = make([]bool, 160)
		for x := range mask[y] {
			i := y*160 + x
			if method == "gray_otsu" {
				mask[y][x] = gray[i] > threshold
			} else {
				mask[y][x] = low[i] > threshold && chroma[i] < 75
			}
		}
	}
	return mask
}

func normalize(mask [][]bool, left, right int) (glyph, bool) {
	var out glyph
	first, last := -1, -1
	for y, row := range mask {
		n := 0
		for x := left; x < right; x++ {
			if row[x] {
				n++
			}
		}
		if n >= 4 {
			if first < 0 {
				first = y
			}
			last = y
		}
	}
	if first < 0 {
		return out, false
	}
	minY, maxY, minX, maxX, count := len(mask), -1, right, -1, 0
	for y := first; y <= last; y++ {
		for x := left; x < right; x++ {
			if mask[y][x] {
				minY = min(minY, y)
				maxY = max(maxY, y)
				minX = min(minX, x)
				maxX = max(maxX, x)
				count++
			}
		}
	}
	if count < 8 {
		return out, false
	}
	for y := 0; y < 30; y++ {
		for x := 0; x < 20; x++ {
			sy := minY + int(float64(y)*(float64(maxY-minY)/29))
			sx := minX + int(float64(x)*(float64(maxX-minX)/19))
			if y == 29 {
				sy = maxY
			}
			if x == 19 {
				sx = maxX
			}
			out[y*20+x] = mask[sy][sx]
		}
	}
	return out, true
}

func splitGlyphs(mask [][]bool, left, right int, wide bool) []glyph {
	type run struct{ a, b int }
	runs := []run{}
	for x := left; x < right; x++ {
		n := 0
		for _, row := range mask {
			if row[x] {
				n++
			}
		}
		if n <= 2 {
			continue
		}
		if len(runs) > 0 && runs[len(runs)-1].b == x {
			runs[len(runs)-1].b = x + 1
		} else {
			runs = append(runs, run{x, x + 1})
		}
	}
	if wide {
		for i, j := 0, len(runs)-1; i < j; i, j = i+1, j-1 {
			runs[i], runs[j] = runs[j], runs[i]
		}
	}
	out := []glyph{}
	for _, r := range runs {
		if r.a == left {
			if wide {
				break
			}
			continue
		}
		if r.b-r.a < 6 || r.b-r.a > 21 {
			if wide {
				break
			}
			return nil
		}
		g, ok := normalize(mask, r.a, r.b)
		if !ok {
			return nil
		}
		out = append(out, g)
	}
	if wide {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out
}

func classify(frame []byte, method string) (int, bool) {
	mask := binaryMask(frame, method)
	gs := splitGlyphs(mask, 0, 160, true)
	if len(gs) < 4 || len(gs) > 5 {
		gs = splitGlyphs(mask, 80, 160, false)
		if len(gs) < 1 || len(gs) > 3 {
			return 0, false
		}
	}
	number := 0
	for _, g := range gs {
		type score struct {
			v float64
			n int
		}
		scores := make([]score, 10)
		for n, t := range banks[method] {
			intersection, union := 0, 0
			for i, v := range g {
				if v && t[i] {
					intersection++
				}
				if v || t[i] {
					union++
				}
			}
			scores[n] = score{float64(intersection) / float64(max(1, union)), n}
		}
		sort.Slice(scores, func(i, j int) bool {
			if scores[i].v == scores[j].v {
				return scores[i].n > scores[j].n
			}
			return scores[i].v > scores[j].v
		})
		if scores[0].v < .68 || scores[0].v-scores[1].v < .05 {
			return 0, false
		}
		number = number*10 + scores[0].n
	}
	return number, true
}

// ReadCounter expects a normalized 200x90 RGB24 HUD crop, not a full frame.
// A nil value is unreadable and must never be substituted with zero.
func ReadCounter(frame []byte) (*int, error) {
	if len(frame) != HUDFrameBytes {
		return nil, fmt.Errorf("expected %d RGB bytes, got %d", HUDFrameBytes, len(frame))
	}
	if iconScore(frame) < .6 {
		return nil, nil
	}
	var value *int
	for _, m := range methods {
		n, ok := classify(frame, m)
		if !ok {
			continue
		}
		if value != nil && *value != n {
			return nil, nil
		}
		v := n
		value = &v
	}
	return value, nil
}

type DamageEvent struct {
	Time     float64 `json:"time"`
	Previous int     `json:"previous"`
	Value    int     `json:"value"`
	Increase int     `json:"increase"`
}
type Reading struct {
	Time  float64 `json:"time"`
	Value *int    `json:"value"`
}

// CounterTracker confirms a reading on its second consecutive observation.
// Unreadable frames and drops reset the baseline without generating an event.
type CounterTracker struct {
	baseline    *int
	pending     *int
	pendingTime float64
	repeats     int
}

func (t *CounterTracker) Update(time float64, value *int) *DamageEvent {
	if value == nil {
		t.baseline = nil
		t.pending = nil
		t.repeats = 0
		return nil
	}
	if t.pending != nil && *t.pending == *value {
		t.repeats++
	} else {
		v := *value
		t.pending = &v
		t.pendingTime = time
		t.repeats = 1
	}
	if t.repeats != 2 {
		return nil
	}
	previous := t.baseline
	v := *value
	t.baseline = &v
	if previous != nil && v > *previous {
		return &DamageEvent{rounded(t.pendingTime, 6), *previous, v, v - *previous}
	}
	return nil
}

func DamageClips(events []DamageEvent, duration float64, o DamageOptions) ([]Clip, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	if err := validateDuration(duration); err != nil {
		return nil, err
	}
	groups := [][]DamageEvent{}
	for i, e := range events {
		if !finite(e.Time) || e.Time < 0 || e.Time > duration || (i > 0 && e.Time < events[i-1].Time) {
			return nil, fmt.Errorf("invalid or unordered damage events")
		}
		if len(groups) > 0 {
			g := groups[len(groups)-1]
			if e.Time-g[len(g)-1].Time <= o.Gap+1e-8 {
				groups[len(groups)-1] = append(g, e)
				continue
			}
		}
		groups = append(groups, []DamageEvent{e})
	}
	clips := []Clip{}
	for _, g := range groups {
		a, b := g[0].Time, g[len(g)-1].Time
		c := Clip{Start: math.Max(0, a-o.Before), End: math.Min(duration, math.Max(b+o.After, a+1/float64(o.FPS))), RawStart: a, RawEnd: b, EventCount: len(g)}
		if c.End <= c.Start {
			continue
		}
		if len(clips) > 0 && c.Start <= clips[len(clips)-1].End+1e-8 {
			p := &clips[len(clips)-1]
			p.End = math.Max(p.End, c.End)
			p.RawEnd = b
			p.EventCount += len(g)
		} else {
			clips = append(clips, c)
		}
	}
	return clips, nil
}

type DamageStats struct {
	SampledFrames    int      `json:"sampled_frames"`
	ReadableFrames   int      `json:"readable_frames"`
	UnreadableFrames int      `json:"unreadable_frames"`
	SamplingFPS      int      `json:"sampling_fps"`
	TimestampBasis   string   `json:"timestamp_basis"`
	Warnings         []string `json:"warnings"`
}
type DamageAnalysis struct {
	Duration float64       `json:"duration_seconds"`
	Events   []DamageEvent `json:"events"`
	Clips    []Clip        `json:"clips"`
	Readings []Reading     `json:"damage_readings"`
	Stats    DamageStats   `json:"damage_stats"`
}

func (t Tools) AnalyzeDamage(ctx context.Context, source string, o DamageOptions) (DamageAnalysis, error) {
	result := DamageAnalysis{Events: []DamageEvent{}, Clips: []Clip{}, Readings: []Reading{}}
	if err := o.Validate(); err != nil {
		return result, err
	}
	media, err := t.Probe(ctx, source)
	if err != nil {
		return result, err
	}
	video, err := media.Video()
	if err != nil {
		return result, err
	}
	result.Duration = media.Duration
	if video.Height <= 0 || math.Abs(float64(video.Width)/float64(video.Height)-16./9) > .02 {
		return result, fmt.Errorf("damage mode requires a full 16:9 image with default HUD")
	}
	filter := fmt.Sprintf("fps=%d:start_time=0,crop=iw*200/3840:ih*90/2160:iw*3320/3840:ih*175/2160,scale=200:90", o.FPS)
	tracker := CounterTracker{}
	count, valid := 0, 0
	err = t.stream(ctx, t.FFmpeg, []string{"-v", "error", "-i", source, "-an", "-vf", filter, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"}, func(r io.Reader) error {
		buf := make([]byte, HUDFrameBytes)
		for {
			_, err := io.ReadFull(r, buf)
			if err == io.EOF {
				break
			}
			if err != nil {
				return fmt.Errorf("incomplete HUD frame: %w", err)
			}
			value, err := ReadCounter(buf)
			if err != nil {
				return err
			}
			time := float64(count) / float64(o.FPS)
			if event := tracker.Update(time, value); event != nil {
				result.Events = append(result.Events, *event)
			}
			if value != nil {
				valid++
			}
			if len(result.Readings) == 0 || !sameValue(result.Readings[len(result.Readings)-1].Value, value) {
				result.Readings = append(result.Readings, Reading{rounded(time, 6), value})
			}
			count++
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	result.Clips, err = DamageClips(result.Events, media.Duration, o)
	result.Stats = DamageStats{count, valid, count - valid, o.FPS, "sampling_grid_from_video_start", []string{"Unreadable HUD may be absent, occluded or unrecognized; it is not treated as zero."}}
	if valid == 0 {
		result.Stats.Warnings = append(result.Stats.Warnings, "No reliable damage readings; check HUD layout and recording clarity.")
	}
	return result, err
}

func sameValue(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
