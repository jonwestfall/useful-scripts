FROM python:3.11-slim

WORKDIR /app

# OpenCV runtime deps (important)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip \
 && pip install --no-cache-dir --no-deps -r /app/requirements.txt \
 && pip install --no-cache-dir -r /app/requirements.txt


COPY . /app

EXPOSE 7860
CMD ["python", "app.py"]
