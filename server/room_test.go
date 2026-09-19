package main

import (
	"encoding/json"
	"testing"
	"time"
)

func testClient(id string, room *Room) *Client {
	return &Client{ID: id, Room: room, Send: make(chan []byte, 4)}
}

func event(id, sender, room, kind string, position float64) Event {
	return Event{ID: id, SenderID: sender, RoomID: room, Type: kind, Position: position, Timestamp: time.Now().UnixMilli()}
}

func TestRoomPublishesOnlyToOtherClientsAndSequencesEvents(t *testing.T) {
	room := newRoom("ABCD12")
	alice, bob, charlie := testClient("alice", room), testClient("bob", room), testClient("charlie", room)
	for _, client := range []*Client{alice, bob, charlie} {
		if _, err := room.addClient(client); err != nil {
			t.Fatal(err)
		}
	}
	room.publish(alice, event("one", "alice", room.ID, "PLAY", 12.5))
	for _, recipient := range []*Client{bob, charlie} {
		var got Event
		if err := json.Unmarshal(<-recipient.Send, &got); err != nil {
			t.Fatal(err)
		}
		if got.Sequence != 1 || got.Type != "PLAY" {
			t.Fatalf("unexpected event: %#v", got)
		}
	}
	select {
	case <-alice.Send:
		t.Fatal("sender received its own event")
	default:
	}
	room.publish(bob, event("two", "bob", room.ID, "PAUSE", 13))
	var got Event
	if err := json.Unmarshal(<-alice.Send, &got); err != nil {
		t.Fatal(err)
	}
	if got.Sequence != 2 {
		t.Fatalf("sequence = %d, want 2", got.Sequence)
	}
	if room.state == nil || room.state.Type != "PAUSE" || room.state.Sequence != 2 {
		t.Fatalf("state not updated: %#v", room.state)
	}
}

func TestRoomManagerCleansUpEmptyRoom(t *testing.T) {
	manager := newRoomManager()
	room, err := manager.getOrCreate("ABCD12")
	if err != nil {
		t.Fatal(err)
	}
	client := testClient("alice", room)
	if _, err := room.addClient(client); err != nil {
		t.Fatal(err)
	}
	manager.removeClient(room.ID, client)
	if manager.get(room.ID) != nil {
		t.Fatal("empty room was not removed")
	}
}

func TestJoiningClientReceivesExistingState(t *testing.T) {
	room := newRoom("ABCD12")
	alice := testClient("alice", room)
	if _, err := room.addClient(alice); err != nil {
		t.Fatal(err)
	}
	room.publish(alice, event("one", "alice", room.ID, "SEEK", 42))
	bob := testClient("bob", room)
	state, err := room.addClient(bob)
	if err != nil {
		t.Fatal(err)
	}
	if state == nil || state.Position != 42 || state.Sequence != 1 {
		t.Fatalf("unexpected state: %#v", state)
	}
}

func TestValidation(t *testing.T) {
	valid := event("one", "alice", "ABCD12", "PLAY", 0)
	if err := validateEvent(valid); err != nil {
		t.Fatalf("valid event rejected: %v", err)
	}
	for _, invalid := range []Event{
		{ID: "one", SenderID: "a", RoomID: "bad!", Type: "PLAY", Timestamp: 1},
		{ID: "one", SenderID: "a", RoomID: "ABCD12", Type: "STOP", Timestamp: 1},
		{ID: "one", SenderID: "a", RoomID: "ABCD12", Type: "PLAY", Position: -1, Timestamp: 1},
	} {
		if err := validateEvent(invalid); err == nil {
			t.Fatalf("invalid event accepted: %#v", invalid)
		}
	}
}
