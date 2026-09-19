# Watch Party Sync

An MVP Chrome/Chromium extension and Go WebSocket relay for synchronizing ordinary HTML5 video controls. It relays playback events only; video data continues to come from the site or local file selected in each browser.

## Run locally

1. Start the relay:

   ```sh
   cd server
   go mod tidy
   go run .
   ```

2. Serve the test page from the repository root in a second terminal:

   ```sh
   python3 -m http.server 8081
   ```

3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension` directory.
4. Open `http://localhost:8081/test-page/` in two separate browser profiles (or two computers). Select the same video file in each window.
5. Use the extension popup in each browser to join the same room ID. A room ID may be made up locally, or create one with `curl -X POST http://localhost:8080/rooms`.

Play, pause, and completed seeks are relayed to the other participant. The relay automatically creates a valid room on first WebSocket join, reconnects clients with exponential backoff, and sends the latest room state after reconnecting.

## Tests

```sh
cd server
go test ./...
```

## Development notes

- The extension is intentionally scoped to `localhost:8081` and `127.0.0.1:8081`; expand the manifest deliberately when adding supported sites.
- This is a generic HTML5 video adapter, not a DRM bypass, proxy, downloader, or restreamer.
- The server uses in-memory rooms and no authentication, which is appropriate only for local development.
