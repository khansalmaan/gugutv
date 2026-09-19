package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateRoomEndpoint(t *testing.T) {
	server := newServer()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/rooms", nil)
	server.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK { t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK) }
	var response struct{ RoomID string `json:"roomId"` }
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil { t.Fatal(err) }
	if !validRoomID(response.RoomID) { t.Fatalf("invalid room id returned: %q", response.RoomID) }
	if server.rooms.get(response.RoomID) == nil { t.Fatal("created room missing from manager") }
}

func TestWebSocketRejectsInvalidRoom(t *testing.T) {
	server := newServer()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/ws?room=bad!&clientId=alice", nil)
	server.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest { t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest) }
}
