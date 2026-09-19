package main

import (
	"flag"
	"log"
	"net/http"
	"os"
)

func main() {
	defaultAddr := ":8080"
	if port := os.Getenv("PORT"); port != "" {
		defaultAddr = ":" + port
	}
	addr := flag.String("addr", defaultAddr, "HTTP listen address")
	flag.Parse()
	server := newServer()
	log.Printf("watch-party relay listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, server.routes()))
}
