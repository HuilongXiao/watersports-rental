FROM python:3.12-slim

WORKDIR /app

# Overridable package index (set PIP_INDEX_URL to a local mirror in slow networks).
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL}

COPY requirements.txt ./
RUN pip install --no-cache-dir --default-timeout=120 -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
