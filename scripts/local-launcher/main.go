// The build script stages the verified web release in site/ before compilation.
package main

import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os/exec"
	"path"
	"runtime"
	"strings"
	"time"
)

//go:embed site
var release embed.FS

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Run()
	case "darwin":
		for _, browser := range []string{"Google Chrome", "Microsoft Edge"} {
			if exec.Command("open", "-a", browser, url).Run() == nil {
				return nil
			}
		}
		return exec.Command("open", url).Run()
	default:
		return exec.Command("xdg-open", url).Run()
	}
}

func main() {
	noBrowser := flag.Bool("no-browser", false, "仅启动服务并显示本地地址")
	flag.Parse()
	site, err := fs.Sub(release, "site")
	if err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:18792")
	if err != nil {
		listener, err = net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			log.Fatal(err)
		}
	}
	address := listener.Addr().String()
	files := http.FileServerFS(site)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != address {
			http.Error(w, "Invalid host", http.StatusBadRequest)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; img-src 'self' blob: data:; style-src 'self'; connect-src 'self'; object-src 'none'")
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path != "/" {
			info, err := fs.Stat(site, strings.TrimPrefix(r.URL.Path, "/"))
			if err != nil || info.IsDir() {
				http.NotFound(w, r)
				return
			}
		}
		switch path.Ext(r.URL.Path) {
		case ".js", ".mjs":
			w.Header().Set("Content-Type", "text/javascript")
		case ".wasm":
			w.Header().Set("Content-Type", "application/wasm")
		case ".onnx", ".f32":
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		files.ServeHTTP(w, r)
	})
	url := "http://" + address + "/"
	fmt.Printf("Apex Local Cut\n%s\n请使用 Chrome 或 Edge 打开。按 Ctrl+C 退出本地服务。\n", url)
	if !*noBrowser {
		go func() {
			if err := openBrowser(url); err != nil {
				fmt.Println("请在 Chrome 或 Edge 中打开上方地址。")
			}
		}()
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
