package main

import (
	"encoding/json"
	"errors"
	"log"
	"sync"
)

const maxClientsPerRoom = 20

type Room struct {
	ID string

	mu       sync.RWMutex
	clients  map[string]*Client
	sequence uint64
	state    *PlaybackState
}

func newRoom(id string) *Room { return &Room{ID: id, clients: make(map[string]*Client)} }

func (r *Room) addClient(client *Client) (*PlaybackState, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.clients) >= maxClientsPerRoom {
		return nil, errors.New("room is full")
	}
	if _, exists := r.clients[client.ID]; exists {
		return nil, errors.New("client id is already connected")
	}
	r.clients[client.ID] = client
	if r.state == nil {
		return nil, nil
	}
	copy := *r.state
	return &copy, nil
}

func (r *Room) removeClient(client *Client) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.clients[client.ID] == client {
		delete(r.clients, client.ID)
	}
	return len(r.clients) == 0
}

func (r *Room) publish(sender *Client, event Event) {
	r.mu.Lock()
	r.sequence++
	event.Sequence = r.sequence
	r.state = &PlaybackState{Type: event.Type, Position: event.Position, Timestamp: event.Timestamp, Sequence: event.Sequence}
	payload, err := json.Marshal(event)
	if err != nil {
		r.mu.Unlock()
		return
	}
	recipients := make([]*Client, 0, len(r.clients)-1)
	for id, client := range r.clients {
		if id != sender.ID {
			recipients = append(recipients, client)
		}
	}
	r.mu.Unlock()
	log.Printf("[SYNC] room=%s sequence=%d sender=%s type=%s position=%.3f recipients=%d", r.ID, event.Sequence, sender.ID, event.Type, event.Position, len(recipients))
	for _, client := range recipients {
		select {
		case client.Send <- payload:
		default: // A slow peer must not stall the whole room.
		}
	}
}

func (r *Room) clientCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients)
}

type RoomManager struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

func newRoomManager() *RoomManager { return &RoomManager{rooms: make(map[string]*Room)} }

func (m *RoomManager) create(id string) (*Room, error) {
	if !validRoomID(id) {
		return nil, errors.New("invalid room id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.rooms[id]; exists {
		return nil, errors.New("room already exists")
	}
	room := newRoom(id)
	m.rooms[id] = room
	return room, nil
}

func (m *RoomManager) getOrCreate(id string) (*Room, error) {
	if !validRoomID(id) {
		return nil, errors.New("invalid room id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if room := m.rooms[id]; room != nil {
		return room, nil
	}
	room := newRoom(id)
	m.rooms[id] = room
	return room, nil
}

func (m *RoomManager) get(id string) *Room {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.rooms[id]
}

func (m *RoomManager) removeClient(roomID string, client *Client) {
	room := m.get(roomID)
	if room == nil || !room.removeClient(client) {
		return
	}
	m.mu.Lock()
	if m.rooms[roomID] == room && room.clientCount() == 0 {
		delete(m.rooms, roomID)
	}
	m.mu.Unlock()
}
