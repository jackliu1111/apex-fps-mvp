package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestHelpAndInvalidCommands(t *testing.T) {
	for _, args := range [][]string{nil, {"--help"}, {"analyze", "--help"}, {"render", "--help"}} {
		var out bytes.Buffer
		if err := run(args, &out); err != nil || out.Len() == 0 {
			t.Fatalf("%v: %v", args, err)
		}
	}
	for _, args := range [][]string{{"bogus"}, {"analyze"}, {"analyze", "--mode", "bad", "input.mkv"}, {"analyze", "--damage-fps", "0", "input.mkv"}} {
		if err := run(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestJSONNoOverwrite(t *testing.T) {
	p := filepath.Join(t.TempDir(), "result.json")
	if err := saveJSON(p, map[string]int{"first": 1}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(p)
	if err := saveJSON(p, map[string]int{"second": 2}); err == nil {
		t.Fatal("overwrote existing result")
	}
	after, _ := os.ReadFile(p)
	if !bytes.Equal(before, after) {
		t.Fatal("result changed")
	}
}
