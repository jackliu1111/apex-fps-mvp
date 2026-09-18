// Command apex-highlight is a thin adapter for the reusable highlight package.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"apex-highlight/highlight"
	"apex-highlight/internal/tui"
	"apex-highlight/internal/workflow"
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 && tui.IsTerminal() {
		args = []string{"tui"}
	}
	if err := run(args, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" || args[0] == "-h" {
		_, err := fmt.Fprintln(out, `Apex highlight Go core CLI

Commands:
  tui     [--output-dir DIR]
  doctor
  probe   VIDEO
  analyze [--mode damage|audio] [--output result.json] [options] VIDEO
  render  --source VIDEO --intervals result.json --output montage.mp4 [--mode precise|fast]

Flags precede positional arguments. Use COMMAND --help for all options.
Default analysis mode: damage. Existing output files are never overwritten.
render accepts {"clips":[{"start":1.0,"end":2.0}]} and processes all supplied intervals.
Run without arguments in a terminal to open the selection UI. FFmpeg and the player are built in. No Python or external media tools are required.`)
		return err
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(out)
	dir := fs.String("tools-dir", "", "obsolete: media tools are now built in; leave empty")
	mode, output, source, intervals := "damage", "", "", ""
	a := highlight.DefaultAudioOptions()
	d := highlight.DefaultDamageOptions()
	switch args[0] {
	case "tui":
		fs.StringVar(&output, "output-dir", "outputs", "directory for interactive results")
	case "doctor", "probe":
	case "analyze":
		fs.StringVar(&mode, "mode", "damage", "damage or audio")
		fs.StringVar(&output, "output", "", "new JSON file (default: stdout)")
		fs.IntVar(&d.FPS, "damage-fps", d.FPS, "HUD sampling FPS (10–60)")
		fs.Float64Var(&d.Gap, "damage-gap-s", d.Gap, "maximum interval between damage events")
		fs.Float64Var(&d.Before, "damage-before-s", d.Before, "damage pre-roll")
		fs.Float64Var(&d.After, "damage-after-s", d.After, "damage post-roll")
		fs.IntVar(&a.SampleRate, "sample-rate", a.SampleRate, "audio sampling rate")
		fs.Float64Var(&a.FrameMS, "frame-ms", a.FrameMS, "audio RMS frame milliseconds")
		fs.Float64Var(&a.ThresholdPercentile, "threshold-percentile", a.ThresholdPercentile, "audio percentile")
		fs.Float64Var(&a.EventBridgeMS, "event-bridge-ms", a.EventBridgeMS, "audio event bridge")
		fs.Float64Var(&a.FightGap, "fight-gap-s", a.FightGap, "audio event grouping gap")
		fs.IntVar(&a.MinEvents, "min-events", a.MinEvents, "minimum audio events per group")
		fs.Float64Var(&a.Before, "before-s", a.Before, "audio pre-roll")
		fs.Float64Var(&a.After, "after-s", a.After, "audio post-roll")
		fs.Float64Var(&a.MaxClip, "max-clip-s", a.MaxClip, "long clip warning threshold; never truncates")
	case "render":
		fs.StringVar(&mode, "mode", "precise", "precise or fast")
		fs.StringVar(&source, "source", "", "source recording")
		fs.StringVar(&intervals, "intervals", "", "JSON object with clips array")
		fs.StringVar(&output, "output", "", "new .mp4, .mkv or .mov file")
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if args[0] == "tui" {
		if fs.NArg() != 0 {
			return fmt.Errorf("unexpected positional arguments")
		}
		return tui.Run(workflow.Service{ToolsDir: *dir, OutputRoot: output})
	}
	if (args[0] == "probe" || args[0] == "analyze") && fs.NArg() != 1 {
		return fmt.Errorf("provide exactly one source recording after flags")
	}
	if (args[0] == "doctor" || args[0] == "render") && fs.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	if args[0] == "analyze" {
		if mode != "audio" && mode != "damage" {
			return fmt.Errorf("mode must be audio or damage")
		}
		if err := a.Validate(); err != nil {
			return err
		}
		if err := d.Validate(); err != nil {
			return err
		}
		if output != "" {
			if _, err := os.Lstat(output); err == nil {
				return fmt.Errorf("output already exists: %s", output)
			} else if !os.IsNotExist(err) {
				return err
			}
		}
	}
	t, err := highlight.FindTools(*dir)
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch args[0] {
	case "doctor":
		if err = t.Check(ctx); err != nil {
			return err
		}
		return writeJSON(out, map[string]any{"ffmpeg": t.FFmpeg, "ffprobe": t.FFprobe, "python_required": false, "backend": "cgo-static", "ffplay": "ffplay", "external_media_executables": false})
	case "probe":
		m, e := t.Probe(ctx, fs.Arg(0))
		if e != nil {
			return e
		}
		return writeJSON(out, m)
	case "analyze":
		source, e := filepath.Abs(fs.Arg(0))
		if e != nil {
			return e
		}
		var payload any
		if mode == "damage" {
			r, e := t.AnalyzeDamage(ctx, source, d)
			if e != nil {
				return e
			}
			payload = struct {
				Version int                     `json:"format_version"`
				Input   string                  `json:"input"`
				Mode    string                  `json:"mode"`
				Options highlight.DamageOptions `json:"options"`
				highlight.DamageAnalysis
			}{1, source, mode, d, r}
		} else {
			r, e := t.AnalyzeAudio(ctx, source, a)
			if e != nil {
				return e
			}
			payload = struct {
				Version int                    `json:"format_version"`
				Input   string                 `json:"input"`
				Mode    string                 `json:"mode"`
				Options highlight.AudioOptions `json:"options"`
				highlight.AudioAnalysis
			}{1, source, mode, a, r}
		}
		if output == "" {
			return writeJSON(out, payload)
		}
		return saveJSON(output, payload)
	case "render":
		if source == "" || intervals == "" || output == "" {
			return fmt.Errorf("render requires --source, --intervals and --output")
		}
		b, e := os.ReadFile(intervals)
		if e != nil {
			return e
		}
		var data struct {
			Clips []highlight.Clip `json:"clips"`
		}
		if e = json.Unmarshal(b, &data); e != nil {
			return e
		}
		r, e := t.Render(ctx, source, data.Clips, output, highlight.RenderMode(mode))
		if e != nil {
			return e
		}
		return writeJSON(out, r)
	}
	return nil
}

func writeJSON(out io.Writer, v any) error {
	e := json.NewEncoder(out)
	e.SetIndent("", "  ")
	return e.Encode(v)
}
func saveJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".apex-json-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(append(b, '\n'))
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Link(f.Name(), path)
}
