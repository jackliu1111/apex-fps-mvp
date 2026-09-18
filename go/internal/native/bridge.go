package native

/*
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int apex_ffmpeg_main(int argc, char **argv);
int apex_ffprobe_main(int argc, char **argv);
int apex_ffplay_main(int argc, char **argv);
void SDL_SetMainReady(void);

static int apex_media_main(int argc, char **argv) {
    int code;
    if (!strcmp(argv[0], "ffmpeg"))
        code = apex_ffmpeg_main(argc, argv);
    else if (!strcmp(argv[0], "ffprobe"))
        code = apex_ffprobe_main(argc, argv);
    else if (!strcmp(argv[0], "ffplay")) {
        SDL_SetMainReady();
        code = apex_ffplay_main(argc, argv);
    } else {
        fprintf(stderr, "unknown built-in media tool: %s\n", argv[0]);
        code = 2;
    }
    fflush(NULL);
    return code;
}
*/
import "C"

import (
	"fmt"
	"os"
	"runtime"
	"unsafe"
)

// Referenced by native.go so CGO_ENABLED=0 cannot silently produce a binary
// without its worker entry points. Build this edition with build_native.py.
const mediaRequiresCGO = true

func init() {
	if len(os.Args) < 2 || os.Args[1] != workerFlag {
		return
	}
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "missing built-in media tool")
		os.Exit(2)
	}
	// init runs on the startup thread. Cocoa/SDL must stay on that thread.
	// This also dispatches workers in Go test binaries, exercising the same path.
	runtime.LockOSThread()
	args := os.Args[2:]
	argv := C.calloc(C.size_t(len(args)+1), C.size_t(unsafe.Sizeof(uintptr(0))))
	if argv == nil {
		fmt.Fprintln(os.Stderr, "cannot allocate media arguments")
		os.Exit(1)
	}
	strings := unsafe.Slice((**C.char)(argv), len(args)+1)
	for i, arg := range args {
		strings[i] = C.CString(arg)
	}
	code := int(C.apex_media_main(C.int(len(args)), (**C.char)(argv)))
	// Some CLI paths exit inside C. Returning paths clean up explicitly.
	for _, s := range strings {
		C.free(unsafe.Pointer(s))
	}
	C.free(argv)
	os.Exit(code)
}
