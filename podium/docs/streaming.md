# Streaming a Lecture (OBS, YouTube, Twitch)

Podium can keep and replay a lecture by itself (see [Replaying a Lecture](features.md#replaying-a-lecture) in the features guide: the controller mic recording, optional screen video and a replay that searches and jumps to any moment). This page covers the other route: **streaming the lecture live** to YouTube or Twitch, so people can watch it as it happens, and keeping the stream as the recording.

A web page cannot send a live stream to YouTube or Twitch by itself. Those services take video over RTMP, which browsers do not speak. So streaming goes through **[OBS Studio](https://obsproject.com/)**, which is free, open source, and runs on Windows, macOS and Linux. Podium needs no setup for it: OBS captures what Podium already shows.

Presenting inside a Zoom or Teams call instead? No OBS needed: go live in a window and share that window in the call. See [Presenting over Zoom or Teams](features.md#presenting-over-zoom-or-teams), and give your polls [links to share in advance](features.md#audience-polls-quizzes--qa) for the invitation or handout.

There are two ways to set it up. Pick the one that matches where you can run OBS.

| | **A. OBS on the classroom PC** | **B. OBS anywhere, from Guest View** |
|---|---|---|
| Where OBS runs | The computer running the display | Any computer: a TA's laptop, an AV booth, a home office |
| Picture | Captures the display window or the projector screen | Loads the Guest View link, so it shows exactly what the room sees |
| Sound | Everything the room hears: videos, background music, and controller mics played through the display's speakers | Videos and music from Podium. Your voice needs a microphone plugged into that computer (Guest View does not carry live mics) |
| Shows the cue? | No, the display never does | No, a viewer never receives it |
| Best for | A room you control, one machine | Shared rooms, or keeping the classroom PC's load down |

## A. OBS on the classroom PC

1. **Install OBS Studio** on the classroom PC and open it. Skip the auto-configuration wizard's "optimize for recording" choice; pick **optimize for streaming**.
2. **Add the picture.** In **Sources**, click **+** and choose one of:
   - **Window Capture**: pick the browser window showing `display.html`. On Windows, if it comes out black, set **Capture Method** to *Windows 10 (1903 and up)*, or turn off hardware acceleration in the browser.
   - **Display Capture**: pick the screen the projector shows. This is the simplest choice when the display runs full screen.
3. **Add the sound.** OBS includes **Desktop Audio** by default. That captures everything Podium plays through the PC: videos, background music, and every controller mic you turn on with **Play through the display's speakers** (the controller's **Say** tab). Several controller mics can play at once, so a co-presenter or a student answering from their own device is heard too.
   - If you speak without a controller mic, add your room microphone as an **Audio Input Capture** as well.
   - Watch the meters in OBS's **Audio Mixer** while you talk. If your voice comes through twice (the room mic picking up the speakers), mute one of the two.
4. **Connect the stream:** see [Streaming to YouTube](#streaming-to-youtube) or [Streaming to Twitch](#streaming-to-twitch) below.
5. **In class:** click **Go live** on the display as usual, then **Start Streaming** in OBS. Captions, ink, polls, the laser and the spotlight all appear in the stream, because they are on the display.

## B. OBS anywhere, from Guest View

[Guest View](features.md#guest-view-watching-on-your-own-device) is Podium's watch-only link: the projector's picture and sound, on any device, without the room's passphrase. OBS can load it like a web page.

1. **Get the viewer link.** On the display, open **Pair a device** and choose **Guest view (watch only)**, then copy the link shown under the QR code. The link keeps working from lecture to lecture until you choose **New viewer link**.
2. **In OBS, add a Browser source.** In **Sources**, click **+** → **Browser**:
   - **URL**: the viewer link.
   - **Width** 1920 and **Height** 1080 (or your stream's size).
   - Tick **Control audio via OBS**, so Podium's videos and music come through OBS's mixer.
3. **Add your voice.** Guest View does not carry live controller mics, so add an **Audio Input Capture** for a microphone connected to this computer: a wireless lapel mic, or the room's audio feed if your AV setup provides one.
4. **Connect the stream:** see the two sections below.
5. **In class:** go live on the display. Between lectures the Browser source shows "Not live right now", and it picks the lecture up on its own when the class goes live. The controllers' viewer count includes OBS as one viewer.

## Streaming to YouTube

1. In YouTube Studio, choose **Create → Go live → Stream**. (A channel's first live stream can take up to 24 hours to be enabled.)
2. Set the **visibility**:
   - **Unlisted**: anyone with the link can watch, but it does not appear in search or on your channel. This is usually right for a class.
   - **Private**: only accounts you invite can watch.
3. Copy the **stream key**. In OBS, go to **Settings → Stream**, choose **YouTube - RTMPS**, and either **Connect Account** or paste the stream key.
4. In **Settings → Output**, a 1080p stream at 30 frames per second needs about 4,500–6,000 kbps; 720p at 30 needs about 2,500–4,000 kbps. Use less if the room's upload speed is limited (OBS's **Stats** dock shows dropped frames).
5. After you stop streaming, YouTube keeps the stream as a video on your channel with the same visibility. **That video is your recording**: share its link, add it to a course page, or download it from YouTube Studio. YouTube's own limits on archived streams change from time to time; check its help pages if you stream for many hours at once.

## Streaming to Twitch

1. In the Twitch **Creator Dashboard**, go to **Settings → Stream** and copy your **Primary Stream key**.
2. In OBS, go to **Settings → Stream**, choose **Twitch**, and either **Connect Account** or paste the key.
3. Turn on **Store past broadcasts** in the same Twitch settings page if you want the stream kept afterwards. Twitch keeps past broadcasts only for a limited number of days, so **download** any you want to keep.
4. Twitch has no "unlisted" option: a live channel can be found by anyone. For a class, YouTube's unlisted streams are usually the better fit.

## Before you stream a class

- **Tell the room.** The display's Go live screen already says what Podium keeps. Say out loud, or on a slide, that the class is also being streamed and where.
- **Check what the room's devices show.** Anything on the projector is in the stream: a notification popping up on the classroom PC, a password typed into a web page, or poll results that show who answered what. Turn on **Do not disturb** on the classroom PC.
- **Captions** help remote viewers too. Live captions (the controller's **Say** tab) are drawn on the display, so they are in the stream.
- **Test once, end to end:** stream a minute to an unlisted video and play it back, checking the sound especially.

## Streaming, Podium's own replay, or both?

They do different jobs, and you can use both at once.

| | **Streaming (OBS)** | **Podium's replay** |
|---|---|---|
| Watch live | Yes | No (Guest View is the live option) |
| Where the recording lives | YouTube or Twitch | Your Podium server |
| Who can open it | Anyone with the link (unlisted) or invited accounts | Only people who could open the lecture in Podium |
| Searchable by what was said | Through YouTube's own captions, if enabled | Yes: across every lecture, from My Files |
| Jump to a slide, poll or caption | By scrubbing | Yes: the transcript, the scrubber's marks, and **Play from here** |
| Disk on your server | None | Mic audio is small; screen video is several hundred MB an hour (see [deploy/README.md](../deploy/README.md#session-records-and-how-long-they-are-kept)) |
