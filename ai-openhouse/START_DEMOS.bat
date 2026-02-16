@echo off
setlocal

cd /d %~dp0
echo Restarting Docker Desktop (Needed on the DSU AI Lab PCs)
docker desktop restart

echo Starting AI Open House demos...
docker compose up -d --build

echo.
echo Opening demos in browser...
start http://localhost:3000  rem Demo 1 (Open WebUI)
start http://localhost:8501  rem Demo 2 (Streamlit)
start http://localhost:7860  rem Demo 3 (Gradio)

echo.
echo NOTE: For Demo 1, you should pull a model into Ollama once.
echo Run: docker exec -it openhouse-ollama ollama pull llama3.1:8b
echo (or another model you prefer)
echo.

pause
