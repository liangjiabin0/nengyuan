FROM python:3.11-slim
WORKDIR /app
COPY requirements-full.txt ./
RUN pip install --no-cache-dir -r requirements-full.txt
COPY . /app
ENV PYTHONPATH=/app/src
EXPOSE 8000
CMD ["uvicorn", "web.fastapi_app:app", "--host", "0.0.0.0", "--port", "8000"]
