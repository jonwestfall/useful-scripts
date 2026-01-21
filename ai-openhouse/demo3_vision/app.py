import os
import time
import warnings

# Set these BEFORE importing gradio to reduce weird container/proxy behavior.
os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")
os.environ.setdefault("GRADIO_SERVER_NAME", "0.0.0.0")
os.environ.setdefault("GRADIO_SERVER_PORT", "7860")

warnings.filterwarnings("ignore", category=UserWarning, module="gradio.analytics")

import gradio as gr
from ultralytics import YOLO

MODEL_PATH = os.getenv("YOLO_MODEL_PATH", "yolov8n.pt")
PORT = int(os.getenv("GRADIO_SERVER_PORT", "7860"))

def load_model():
    # Load at startup so first user interaction is snappy.
    return YOLO(MODEL_PATH)

model = load_model()

def detect(image, conf=0.25):
    # Basic guardrails so the UI doesn’t explode on empty input.
    if image is None:
        return None
    results = model.predict(source=image, conf=float(conf), verbose=False)
    return results[0].plot()

demo = gr.Interface(
    fn=detect,
    inputs=[
        gr.Image(type="numpy", label="Input image"),
        gr.Slider(0.05, 0.9, value=0.25, step=0.05, label="Confidence threshold"),
    ],
    outputs=gr.Image(type="numpy", label="Detections"),
    title="Demo 3: See What the AI Sees (Local YOLO)",
    description="Upload an image and the model will detect objects locally (no cloud).",
)

def main():
    # IMPORTANT:
    # - prevent_thread_lock=True avoids some container localhost/share checks,
    #   BUT it also means launch() returns immediately (non-blocking).
    # - We MUST block after launch to keep the container alive.
    demo.launch(
        server_name="0.0.0.0",
        server_port=PORT,
        share=False,
        show_api=False,
        prevent_thread_lock=True,
    )

    # Keep the process alive in a Gradio-version-tolerant way.
    # Newer Gradio has block_thread(); older versions do not.
    if hasattr(demo, "block_thread"):
        demo.block_thread()
    else:
        while True:
            time.sleep(3600)

if __name__ == "__main__":
    main()
