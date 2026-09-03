FROM python:3.11-slim
COPY sdk/python /sdk
RUN pip install --no-cache-dir /sdk
COPY capsules/malicious-demo/app.py /app/app.py
USER 65534:65534
WORKDIR /app
CMD ["python", "/app/app.py"]
