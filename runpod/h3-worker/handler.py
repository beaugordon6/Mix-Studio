#!/usr/bin/env python3
"""RunPod Serverless worker for Mix Studio MiniMax H3 workflows."""

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time
import urllib.request

import boto3
import runpod

MANIFEST_VERSION = 1
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_INPUT = pathlib.Path(os.environ.get("COMFY_INPUT", "/comfyui/input"))
COMFY_OUTPUT = pathlib.Path(os.environ.get("COMFY_OUTPUT", "/comfyui/output"))
REQUIRED_CLASSES = {
    "UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3ImageToVideo",
    "RandomNoise", "BasicGuider", "BasicScheduler", "SamplerCustomAdvanced",
    "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo",
}


def request_json(path, method="GET", payload=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        COMFY_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def r2_client():
    return boto3.client(
        "s3", endpoint_url=os.environ["MIX_R2_ENDPOINT"],
        aws_access_key_id=os.environ["MIX_R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["MIX_R2_SECRET_ACCESS_KEY"],
        region_name="auto")


def safe_name(name):
    clean = "".join(c for c in str(name) if c.isalnum() or c in "._-")
    if not clean or clean in (".", ".."):
        raise ValueError("invalid asset name")
    return clean[:180]


def download_inputs(items):
    client = r2_client()
    bucket = os.environ["MIX_R2_BUCKET"]
    COMFY_INPUT.mkdir(parents=True, exist_ok=True)
    for item in items or []:
        name = safe_name(item["name"])
        target = COMFY_INPUT / name
        client.download_file(bucket, item["key"], str(target))
        expected = item.get("sha256")
        if expected:
            actual = hashlib.sha256(target.read_bytes()).hexdigest()
            if actual != expected:
                target.unlink(missing_ok=True)
                raise ValueError("input checksum mismatch: " + name)


def output_entries(outputs):
    entries = []
    for node in (outputs or {}).values():
        if not isinstance(node, dict):
            continue
        for value in node.values():
            if not isinstance(value, list):
                continue
            for entry in value:
                if isinstance(entry, dict) and entry.get("filename") and entry.get("type") == "output":
                    entries.append(entry)
    return entries


def run_graph(job, graph):
    queued = request_json("/prompt", "POST", {"prompt": graph, "client_id": "mix-runpod-" + job["id"]})
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
        raise RuntimeError("ComfyUI rejected workflow: " + json.dumps(queued)[:500])
    while True:
        history = request_json("/history/" + prompt_id, timeout=30).get(prompt_id)
        if history:
            status = history.get("status") or {}
            if status.get("status_str") == "error" or status.get("completed") is False:
                messages = status.get("messages") or []
                raise RuntimeError("ComfyUI execution failed: " + json.dumps(messages)[-1000:])
            return history.get("outputs") or {}
        runpod.serverless.progress_update(job, "Generating on RunPod…")
        time.sleep(2)


def publish(job_id, entries):
    client = r2_client()
    bucket = os.environ["MIX_R2_BUCKET"]
    published = []
    for index, entry in enumerate(entries):
        source = (COMFY_OUTPUT / (entry.get("subfolder") or "") / entry["filename"]).resolve()
        if COMFY_OUTPUT.resolve() not in source.parents or not source.is_file():
            raise RuntimeError("declared ComfyUI output is unavailable")
        suffix = source.suffix.lower()
        kind = "video" if suffix in (".mp4", ".webm", ".mov", ".mkv") else "poster"
        key = "mix-h3/%s/output-%d%s" % (job_id, index, suffix)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        client.upload_file(str(source), bucket, key)
        published.append({"key": key, "kind": kind, "sha256": digest, "bytes": source.stat().st_size})
    if not any(item["kind"] == "video" for item in published):
        raise RuntimeError("MiniMax H3 produced no video")
    return published


def readiness():
    info = request_json("/object_info", timeout=120)
    missing = sorted(REQUIRED_CLASSES - set(info))
    return {"manifestVersion": MANIFEST_VERSION, "ready": not missing, "missingNodes": missing}


def handler(job):
    request = job.get("input") or {}
    if int(request.get("manifestVersion") or 0) != MANIFEST_VERSION:
        raise ValueError("Mix Studio and worker manifest versions differ")
    ready = readiness()
    if not ready["ready"]:
        raise RuntimeError("H3 worker is missing nodes: " + ", ".join(ready["missingNodes"]))
    if request.get("probe") is True:
        return {"refresh_worker": True, **ready}
    try:
        runpod.serverless.progress_update(job, "Preparing H3 inputs…")
        download_inputs(request.get("inputs"))
        all_outputs = {}
        graphs = request.get("graphs") or [request.get("workflow")]
        for index, graph in enumerate(graphs):
            if not isinstance(graph, dict):
                raise ValueError("H3 request has no workflow")
            runpod.serverless.progress_update(job, "Generating H3 segment %d/%d…" % (index + 1, len(graphs)))
            all_outputs.update(run_graph(job, graph))
        runpod.serverless.progress_update(job, "Uploading finished video…")
        assets = publish(job["id"], output_entries(all_outputs))
        return {"refresh_worker": True, "manifestVersion": MANIFEST_VERSION, "assets": assets}
    finally:
        for item in request.get("inputs") or []:
            try:
                (COMFY_INPUT / safe_name(item["name"])).unlink(missing_ok=True)
            except Exception:
                pass


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
