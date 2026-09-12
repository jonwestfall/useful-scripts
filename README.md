# 🛠️ Useful Scripts by Jon Westfall

Welcome to **Useful Scripts**, a collection of small utilities and tools I've developed to make work and life more efficient. These scripts cover a range of purposes from image processing to automation, and are typically lightweight, easy to run, and cross-platform when possible.

This repository serves as a hub for scripts that don't warrant a full repository of their own. If you're looking for helpful one-off tools, this is the place.

---

## 📷 Redactor GUI (Python Image Redactor)

**`redactor_gui.py`** is a simple, cross-platform Python GUI tool that allows you to selectively redact parts of images either by **blurring** or **black boxing**. It supports:

- Loading images from disk
- Pasting images from clipboard
- Drawing boxes to redact regions
- Undoing redactions
- Saving the modified image

### 🧰 Use Cases

- Redacting sensitive screenshots
- Censoring faces or text before sharing images
- Easy visual editing without opening Photoshop

---

## 🖥️ Installation & Usage

### ✅ Prerequisites

- Python 3.9 or higher (tested on 3.11)
- [Pillow](https://pypi.org/project/pillow/) for image manipulation

### 📦 Install Dependencies

If you don’t already have Pillow installed, run:

```bash
pip install pillow
```

If using a virtual environment:

```bash
python -m venv venv
source venv/bin/activate        # macOS/Linux
# OR
venv\Scripts\activate.bat       # Windows

pip install pillow
```

### ▶️ Running the Script

```bash
python redactor_gui.py
```

Once launched, you'll see a simple interface that lets you open or paste an image, draw redaction areas, and save the result. Use the menu bar to switch between blur and black box modes.

### 🪟 Windows Alternative

If you're working on Windows and want a version tailored specifically for that platform, use **`redactor_gui_win.py`**. It offers the same blur, pixelate, and blackout tools as the cross-platform script but is packaged for Windows-only environments. Launch it with:

```bash
python redactor_gui_win.py
```

---

## 🎛️ Podium (Lecture Display Controller)

**[`podium/`](podium/)** turns the classroom PC into a screen you drive from your iPad.
The PC opens one fullscreen browser tab and is never touched again; everything on the
projector is chosen from a tablet or phone, from anywhere in the room.

- Present **Marp decks written in Markdown**, with presenter notes on the iPad, your own CSS themes, and math via KaTeX
- Show PDFs, images, video, YouTube, music, a QR code, a countdown, or your phone's camera
- **Freeze** holds the projector while you line up the next thing in the cue — the class sees none of it — then **TAKE** cuts to it
- Annotate live over whatever is on screen with an Apple Pencil
- iPad and iPhone can both be connected at once and stay in sync
- Three static pages: runs on GitHub Pages, a VPS, or a folder on disk

Messages travel via Supabase Realtime, your own tiny Node relay, or a public MQTT
broker, and are encrypted in the browser so the relay only ever moves ciphertext.

See [`podium/README.md`](podium/README.md) for setup.

---

## 📚 Other Scripts (In Standalone Repositories)

These are additional tools I’ve built that live in their own repositories due to size, specialization, or broader utility:

### [`advising-notes-app`](https://github.com/jonwestfall/advising-notes-app)
> A Python-based tool to streamline academic advising. It helps advisors track notes for students, generate summaries, and manage documentation—integrated with OneDrive or Teams shortcuts for ease of use.

---

### [`canvas-reporting-script`](https://github.com/jonwestfall/canvas-reporting-script)
> Generates detailed reports from Canvas LMS data, including student participation, grades, and login activity. Designed for instructors who want deeper insight than the default LMS analytics.

---

### [`ai-form-submission-check`](https://github.com/jonwestfall/ai-form-submission-check)
> An automated tool for auditing and verifying AI disclosure forms submitted by students. Designed to batch-process disclosures and flag missing or unusual entries in educational settings.

---

### [`youtube-transcript-download`](https://github.com/jonwestfall/youtube-transcript-download)
> Download and clean up YouTube video transcripts (auto-generated or uploaded), making them easier to use for accessibility, notes, or further analysis.

---

### [`llm-feedback-prompt-generator`](https://github.com/jonwestfall/llm-feedback-prompt-generator)
> A web-based tool that helps educators generate effective, constructive feedback using LLMs by selecting predefined response structures and prompt elements.

---

## 🔧 Contributing

Right now, this is a personal repository of useful tools. Feel free to fork and adapt! If you'd like to suggest improvements or contribute fixes, open an issue or PR.

---

## 🧠 About Me

I'm a psychology professor and educational technologist who builds tools to solve practical problems. If you're interested in psychology, automation, education, or open-source tools, [check out my other projects](https://github.com/jonwestfall) or reach out.

---