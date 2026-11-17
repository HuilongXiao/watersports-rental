FROM python:3.12-slim

WORKDIR /app

# Overridable package index (set PIP_INDEX_URL to a local mirror in slow networks).
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL}

COPY requirements.txt ./
RUN pip install --no-cache-dir --default-timeout=120 -r requirements.txt

COPY app ./app

# 和风天气 JWT 私钥放在持久化的 data 目录（宿主机 ./data/secrets/）
ENV QWEATHER_PRIVATE_KEY_PATH=/app/data/secrets/qweather_private.pem

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
