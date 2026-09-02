ARG WORKER_BASE=runpod/worker-comfyui:5.8.6-base-cuda12.8.1
FROM ${WORKER_BASE}

COPY requirements.txt /tmp/mix-h3-requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/mix-h3-requirements.txt
COPY handler.py /mix-h3/handler.py
COPY start.sh /mix-h3/start.sh
RUN chmod 0755 /mix-h3/start.sh

ENV COMFY_URL=http://127.0.0.1:8188 \
    COMFY_INPUT=/comfyui/input \
    COMFY_OUTPUT=/comfyui/output \
    REFRESH_WORKER=true
CMD ["/mix-h3/start.sh"]
