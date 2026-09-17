import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("import-chatgpt.py")
requests_stub = types.ModuleType("requests")
requests_stub.RequestException = Exception
requests_stub.post = lambda *args, **kwargs: None
SPEC = importlib.util.spec_from_file_location("import_chatgpt", MODULE_PATH)
import_chatgpt = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
with patch.dict(sys.modules, {"requests": requests_stub}):
    SPEC.loader.exec_module(import_chatgpt)


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        return self.payload


class IngestEndpointTests(unittest.TestCase):
    def post(self, response, *, retain_transcript=False):
        with patch.object(import_chatgpt, "http_post_with_retry", return_value=response) as post:
            result = import_chatgpt.ingest_thought_endpoint(
                "distilled thought",
                {"chatgpt_title": "Example"},
                full_text="private transcript",
                retain_transcript=retain_transcript,
            )
        return result, post.call_args.kwargs["body"]

    def test_success_responses_mark_capture_ok(self):
        for status in (200, 201):
            result, _ = self.post(FakeResponse(status, {"ok": False, "id": "capture-1"}))
            self.assertTrue(result["ok"])
            self.assertEqual(result["id"], "capture-1")

    def test_transcript_is_distilled_only_by_default(self):
        result, body = self.post(FakeResponse(201, {"ok": True}))
        self.assertTrue(result["ok"])
        self.assertNotIn("full_text", body["metadata"])

    def test_transcript_requires_explicit_opt_in(self):
        _, body = self.post(FakeResponse(201, {"ok": True}), retain_transcript=True)
        self.assertEqual(body["metadata"]["full_text"], "private transcript")

    def test_non_success_payload_is_preserved(self):
        result, _ = self.post(FakeResponse(422, {"ok": False, "error": "invalid capture"}))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid capture")

if __name__ == "__main__":
    unittest.main()
