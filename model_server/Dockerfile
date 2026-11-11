# Build from the repo root so the catalog JSON is in the context:
#   gcloud builds submit --config model_server/cloudbuild.yaml .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY model_server/requirements.txt model_server/requirements.txt
RUN pip install --no-cache-dir -r model_server/requirements.txt

COPY model_server/app.py model_server/gmi_video.py model_server/
COPY src/data/gmi-video-models.json src/data/gmi-video-models.json

# Cloud Run sets PORT (8080); app.py reads it.
CMD ["python", "model_server/app.py"]
