import importlib.util
import pathlib
import sys
import types
import unittest


sys.modules.setdefault("boto3", types.SimpleNamespace(client=lambda *args, **kwargs: None))
sys.modules.setdefault(
    "runpod",
    types.SimpleNamespace(
        serverless=types.SimpleNamespace(progress_update=lambda *args: None, start=lambda *args: None)))

MODULE_PATH = pathlib.Path(__file__).with_name("handler.py")
SPEC = importlib.util.spec_from_file_location("mix_h3_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def object_info(missing_model=None):
    info = {name: {"input": {"required": {}}} for name in worker.REQUIRED_CLASSES}
    models = worker.REQUIRED_FRAME_MODELS
    info["UNETLoader"]["input"]["required"]["unet_name"] = [[models["diffusionModel"]], {}]
    info["CLIPLoader"]["input"]["required"]["clip_name"] = [[models["textEncoder"]], {}]
    info["VAELoader"]["input"]["required"]["vae_name"] = [
        [models["videoVae"], models["audioVae"]], {}]
    if missing_model:
        for definition in info.values():
            required = definition["input"]["required"]
            for field in required.values():
                if isinstance(field, list) and field and isinstance(field[0], list):
                    field[0][:] = [name for name in field[0] if name != missing_model]
    return info


class WorkerReadinessTest(unittest.TestCase):
    def test_frames_stack_is_ready(self):
        result = worker.readiness(object_info())
        self.assertTrue(result["ready"])
        self.assertEqual(result["mode"], "frames")
        self.assertEqual(result["models"]["missing"], [])

    def test_missing_exact_model_blocks_readiness(self):
        missing = worker.REQUIRED_FRAME_MODELS["diffusionModel"]
        result = worker.readiness(object_info(missing))
        self.assertFalse(result["ready"])
        self.assertEqual(result["models"]["missing"], [missing])

    def test_workflow_model_must_be_registered(self):
        graph = {"model": {"class_type": "UNETLoader", "inputs": {"unet_name": "unknown.safetensors"}}}
        with self.assertRaisesRegex(RuntimeError, "unknown.safetensors"):
            worker.validate_workflow_models(graph, object_info())

    def test_probe_failure_requests_worker_refresh(self):
        previous = worker.request_json
        try:
            worker.request_json = lambda *args, **kwargs: object_info(
                worker.REQUIRED_FRAME_MODELS["textEncoder"])
            result = worker.handler({"input": {"manifestVersion": 1, "probe": True}})
            self.assertTrue(result["refresh_worker"])
            self.assertIn("not ready", result["error"])
        finally:
            worker.request_json = previous


if __name__ == "__main__":
    unittest.main()
