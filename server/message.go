package main

import (
	"errors"
	"math"
	"regexp"
	"strings"
)

const maxPositionSeconds = 60 * 60 * 24 * 7 // one week is plenty for this MVP.

var roomIDPattern = regexp.MustCompile(`^[A-Za-z0-9]{4,12}$`)

// Event is the wire format for a playback action.
type Event struct {
	ID        string  `json:"id"`
	SenderID  string  `json:"senderId"`
	RoomID    string  `json:"roomId"`
	Type      string  `json:"type"`
	Position  float64 `json:"position"`
	Timestamp int64   `json:"timestamp"`
	Sequence  uint64  `json:"sequence,omitempty"`
}

type StateMessage struct {
	Type      string  `json:"type"`
	Playback  string  `json:"playback"`
	Position  float64 `json:"position"`
	Timestamp int64   `json:"timestamp"`
	Sequence  uint64  `json:"sequence"`
}

type PlaybackState struct {
	Type      string
	Position  float64
	Timestamp int64
	Sequence  uint64
}

func validRoomID(id string) bool { return roomIDPattern.MatchString(id) }

func validateEvent(event Event) error {
	if strings.TrimSpace(event.ID) == "" || len(event.ID) > 128 {
		return errors.New("event id is required")
	}
	if strings.TrimSpace(event.SenderID) == "" || len(event.SenderID) > 128 {
		return errors.New("sender id is required")
	}
	if !validRoomID(event.RoomID) {
		return errors.New("invalid room id")
	}
	if event.Type != "PLAY" && event.Type != "PAUSE" && event.Type != "SEEK" {
		return errors.New("invalid event type")
	}
	if math.IsNaN(event.Position) || math.IsInf(event.Position, 0) || event.Position < 0 || event.Position > maxPositionSeconds {
		return errors.New("invalid playback position")
	}
	if event.Timestamp <= 0 {
		return errors.New("invalid timestamp")
	}
	return nil
}
