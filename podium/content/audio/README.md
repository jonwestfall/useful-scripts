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

### Sourcing ambient music

None of the well-known "free music for video" libraries are safe to point `music.json`
at directly — they are download libraries, not permanent hotlink CDNs, so a class three
months from now would depend on someone else's server never changing its URL scheme.
Download from one of these once, then host the file yourself the normal way:

- **[Incompetech](https://incompetech.com/music/royalty-free/)** (Kevin MacLeod) — the
  library most "royalty-free music for YouTube" ends up meaning. Filterable by mood
  including Ambient, 2,000+ tracks, all CC-BY 4.0: keep a one-line "Music by Kevin
  MacLeod, incompetech.com" credit somewhere (a syllabus footer is enough), or buy a
  one-time personal license to drop the requirement entirely.
- **[FreePD's catalog, mirrored on the Internet Archive](https://archive.org/details/freepd)**
  — ~1,000 tracks, genuinely public domain, no attribution needed at all. FreePD.com
  itself closed in 2026; this mirror is the cleanest license story on this list.
- **YouTube Audio Library** (in YouTube Studio, under Audio Library) — worth checking
  first if you already have a channel from your Premium account. Free, most tracks need
  no attribution, but it is download-only — no public URL, so it is self-host either way.
- **Pixabay Music** and **Free Music Archive** — bigger and more eclectic, but Pixabay's
  download links are not stable public URLs and FMA licenses vary track by track, so
  check each one before use.

Once you have a handful of files, drop them in this folder (or your server) and add a
playlist like the "Ambient pre-lecture" template in `../music.json`.
