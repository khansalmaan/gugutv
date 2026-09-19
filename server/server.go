package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Server struct {
	rooms    *RoomManager
	upgrader websocket.Upgrader
}

func newServer() *Server {
	return &Server{
		rooms:    newRoomManager(),
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}, // local-development MVP
	}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rooms", s.createRoom)
	mux.HandleFunc("GET /ws", s.serveWS)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	return mux
}

func (s *Server) createRoom(w http.ResponseWriter, _ *http.Request) {
	for range 10 {
		id, err := randomRoomID()
		if err != nil {
			http.Error(w, "could not create room", http.StatusInternalServerError)
			return
		}
		if _, err := s.rooms.create(id); err == nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"roomId": id})
			return
		}
	}
	http.Error(w, "could not create room", http.StatusInternalServerError)
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	roomID := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("room")))
	clientID := strings.TrimSpace(r.URL.Query().Get("clientId"))
	if !validRoomID(roomID) || clientID == "" || len(clientID) > 128 {
		http.Error(w, "invalid room or client id", http.StatusBadRequest)
		return
	}
	room, err := s.rooms.getOrCreate(roomID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := newClient(clientID, room, conn)
	state, err := room.addClient(client)
	if err != nil {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, err.Error()), time.Now().Add(writeWait))
		_ = conn.Close()
		return
	}
	if state != nil {
		payload, _ := json.Marshal(StateMessage{Type: "STATE", Playback: state.Type, Position: state.Position, Timestamp: state.Timestamp, Sequence: state.Sequence})
		client.Send <- payload
	}
	log.Printf("[WS] client=%s joined room=%s", client.ID, room.ID)
	go client.writePump(s)
	client.readPump(s)
}

func randomRoomID() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	bytes := make([]byte, 6)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	var b strings.Builder
	for _, value := range bytes {
		b.WriteByte(alphabet[int(value)%len(alphabet)])
	}
	return b.String(), nil
}

func (s *Server) String() string {
	return fmt.Sprintf("watch-party server (%d rooms)", len(s.rooms.rooms))
}
