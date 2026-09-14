# Audio

Drop an mp3, wav, ogg, m4a, or flac file in here, then either:

- Add it to `content/manifest.json` for a permanent library tile:

  ```json
  { "group": "Between classes", "title": "Waiting music",
    "type": "audio", "src": "content/audio/your-file.mp3", "loop": true }
  ```

- Or, for something you only need once, paste its URL straight into the
  controller's Library tab ("Paste a link…") — no manifest edit needed. This
  works for any audio file reachable by URL, not just ones in this folder
  (a direct link to a file on your course site, Dropbox, etc.).

`waiting-music.wav` is a synthesized placeholder so the "Waiting music" example
in the library actually plays out of the box — swap it for something you
actually want the class hearing between activities.

## Background music

The Music tab is a different thing from an audio *item*: it plays with nothing on the
projector, keeps going while you teach, and ducks itself under any clip that has its
own sound. Its playlists live in `../music.json`:

```json
{ "playlists": [
  { "name": "Before class",
    "tracks": [
      { "title": "Sonata in G", "artist": "…",
        "src": "https://your-server.example/music/sonata.mp3" }
    ] } ] }
```

A `src` can point anywhere reachable over https — a plain audio URL needs no CORS
headers — so keep the music on your own server rather than in this repository, which
is both a copyright question and a size one.
