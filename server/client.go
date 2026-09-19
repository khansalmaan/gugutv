package main

import (
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 4096
)

// Client owns one WebSocket connection. Only writePump writes to Conn.
type Client struct {
	ID   string
	Room *Room
	Conn *websocket.Conn
	Send chan []byte

	onClose sync.Once
}

func newClient(id string, room *Room, conn *websocket.Conn) *Client {
	return &Client{ID: id, Room: room, Conn: conn, Send: make(chan []byte, 32)}
}

func (c *Client) close(manager *RoomManager) {
	c.onClose.Do(func() {
		log.Printf("[WS] client=%s left room=%s", c.ID, c.Room.ID)
		manager.removeClient(c.Room.ID, c)
		// Do not close Send here: a broadcaster may have already taken a
		// snapshot of room clients. Closing it would turn that harmless stale
		// delivery into a send-on-closed-channel panic.
		_ = c.Conn.Close()
	})
}

func (c *Client) readPump(server *Server) {
	defer c.close(server.rooms)
	c.Conn.SetReadLimit(maxMessageSize)
	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		var event Event
		if err := c.Conn.ReadJSON(&event); err != nil {
			return
		}
		if event.RoomID != c.Room.ID || event.SenderID != c.ID || validateEvent(event) != nil {
			continue
		}
		c.Room.publish(c, event)
	}
}

func (c *Client) writePump(server *Server) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.close(server.rooms)
	}()
	for {
		select {
		case message, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
