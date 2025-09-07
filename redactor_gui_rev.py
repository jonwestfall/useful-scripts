import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog
from PIL import Image, ImageTk, ImageFilter, ImageGrab
import os
import platform

class RedactorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Redactor GUI")
        self.image = None
        self.tk_img = None
        self.start_x = self.start_y = 0
        self.rect = None
        self.redaction_type = "blur"  # or "black"
        self.filename = None

        self.menu = tk.Menu(self.root)
        self.root.config(menu=self.menu)

        file_menu = tk.Menu(self.menu, tearoff=False)
        file_menu.add_command(label="Open Image", command=self.load_image)
        file_menu.add_command(label="Paste from Clipboard", command=self.paste_clipboard)
        file_menu.add_command(label="Save Redacted Image", command=self.save_image)
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.root.quit)
        self.menu.add_cascade(label="File", menu=file_menu)

        redact_menu = tk.Menu(self.menu, tearoff=False)
        redact_menu.add_command(label="Use Blur", command=lambda: self.set_redaction("blur"))
        redact_menu.add_command(label="Use Black Box", command=lambda: self.set_redaction("black"))
        self.menu.add_cascade(label="Redaction", menu=redact_menu)

        self.canvas = tk.Canvas(self.root, cursor="cross")
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)

    def load_image(self):
        file_path = filedialog.askopenfilename(filetypes=[("Image files", "*.png;*.jpg;*.jpeg;*.bmp")])
        if file_path:
            self.image = Image.open(file_path)
            self.filename = os.path.basename(file_path)
            self.display_image()

    def paste_clipboard(self):
        try:
            img = ImageGrab.grabclipboard()
            if isinstance(img, Image.Image):
                self.image = img
                self.filename = "clipboard.png"
                self.display_image()
            else:
                messagebox.showerror("Error", "No image in clipboard.")
        except Exception as e:
            messagebox.showerror("Error", f"Clipboard error:\n{e}")

    def display_image(self):
        self.tk_img = ImageTk.PhotoImage(self.image)
        self.canvas.config(width=self.tk_img.width(), height=self.tk_img.height())
        self.canvas.create_image(0, 0, anchor="nw", image=self.tk_img)

    def set_redaction(self, mode):
        self.redaction_type = mode

    def on_press(self, event):
        self.start_x, self.start_y = event.x, event.y
        if self.rect:
            self.canvas.delete(self.rect)
        self.rect = self.canvas.create_rectangle(self.start_x, self.start_y, event.x, event.y, outline="red")

    def on_drag(self, event):
        self.canvas.coords(self.rect, self.start_x, self.start_y, event.x, event.y)

    def on_release(self, event):
        x1, y1 = min(self.start_x, event.x), min(self.start_y, event.y)
        x2, y2 = max(self.start_x, event.x), max(self.start_y, event.y)
        box = (x1, y1, x2, y2)

        if self.redaction_type == "blur":
            region = self.image.crop(box).filter(ImageFilter.GaussianBlur(25))
        else:
            region = Image.new("RGB", (x2 - x1, y2 - y1), (0, 0, 0))

        self.image.paste(region, box)
        self.display_image()

    def save_image(self):
        if not self.image:
            messagebox.showerror("Error", "No image to save.")
            return

        save_path = filedialog.asksaveasfilename(
            defaultextension=".png",
            filetypes=[("PNG Image", "*.png"), ("JPEG Image", "*.jpg"), ("Bitmap", "*.bmp")]
        )
        if save_path:
            self.image.save(save_path)
            messagebox.showinfo("Saved", f"Image saved to:\n{save_path}")

if __name__ == "__main__":
    root = tk.Tk()
    root.withdraw()  # Hide extra window
    app = RedactorApp(root)
    root.deiconify()
    root.mainloop()
