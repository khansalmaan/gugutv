package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	flag.Parse()
	server := newServer()
	log.Printf("watch-party relay listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, server.routes()))
}
