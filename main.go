// erd-creator: serves the embedded Svelte ERD app. All logic (SQL generate/parse,
// file open/save) lives client-side; this is a static file server over embed.FS.
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
)

//go:embed frontend/dist
var dist embed.FS

func main() {
	sub, err := fs.Sub(dist, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}

	http.HandleFunc("/export", handleExport)
	fileServer := http.FileServer(http.FS(sub))
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// SPA fallback: unknown paths serve index.html.
		if _, err := fs.Stat(sub, r.URL.Path[1:]); err != nil {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
	addr := "127.0.0.1:8731"
	log.Printf("erd-creator on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
