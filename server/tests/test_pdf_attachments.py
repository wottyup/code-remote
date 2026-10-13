from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from starlette.requests import Request

from codex_remote.app import (
    MAX_PDF_BYTES,
    PDF_ATTACHMENT_TTL_SECONDS,
    PdfAttachmentStore,
    SteerRequest,
    TurnRequest,
    create_app,
)


class PdfAttachmentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        workspace = root / "project"
        workspace.mkdir()
        image_directory = root / "private-temp"
        image_directory.mkdir()
        self.workspace = workspace
        with (
            patch.dict(os.environ, {"CODEX_REMOTE_AUTH_FILE": str(workspace / "auth.json")}),
            patch("codex_remote.app.tempfile.mkdtemp", return_value=str(image_directory)),
        ):
            self.app = create_app(workspace)
        self.addCleanup(self.app.state.shared_state.close)
        self.server = self.app.state.codex
        self.store: PdfAttachmentStore = self.app.state.pdf_attachments

    def endpoint(self, path: str):
        return next(route.endpoint for route in self.app.routes if getattr(route, "path", None) == path)

    def upload_request(self, content: bytes, name: str = "invoice.pdf", media_type: str = "application/pdf") -> Request:
        scope = {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/v1/codex/pdf-attachments",
            "raw_path": b"/api/v1/codex/pdf-attachments",
            "query_string": f"name={name}".encode(),
            "root_path": "",
            "headers": [
                (b"content-type", media_type.encode()),
                (b"content-length", str(len(content)).encode()),
            ],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 8000),
        }
        body_sent = False

        async def receive():
            nonlocal body_sent
            if body_sent:
                return {"type": "http.request", "body": b"", "more_body": False}
            body_sent = True
            return {"type": "http.request", "body": content, "more_body": False}

        return Request(scope, receive)

    async def test_upload_stores_unchanged_pdf_outside_the_project_workspace(self) -> None:
        original = b"%PDF-1.7\nDO_NOT_EXTRACT_THIS_TEXT\n%%EOF"
        upload = self.endpoint("/api/v1/codex/pdf-attachments")

        result = await upload(self.upload_request(original, "invoice%203522.pdf"))

        stored = self.store.get(result["attachment_id"])
        self.assertIsNotNone(stored)
        assert stored is not None
        self.assertEqual(stored.name, "invoice 3522.pdf")
        self.assertEqual(stored.path.read_bytes(), original)
        self.assertFalse(stored.path.is_relative_to(self.workspace))
        self.assertEqual(stored.path.stat().st_mode & 0o777, 0o600)

    async def test_upload_rejects_non_pdf_and_invalid_pdf_signatures(self) -> None:
        upload = self.endpoint("/api/v1/codex/pdf-attachments")
        with self.assertRaises(HTTPException) as wrong_media:
            await upload(self.upload_request(b"not a pdf", media_type="text/plain"))
        self.assertEqual(wrong_media.exception.status_code, 415)

        with self.assertRaises(HTTPException) as invalid_pdf:
            await upload(self.upload_request(b"not a pdf"))
        self.assertEqual(invalid_pdf.exception.status_code, 422)

    async def test_upload_rejects_oversized_pdf_before_reading_the_body(self) -> None:
        upload = self.endpoint("/api/v1/codex/pdf-attachments")
        request = self.upload_request(b"")
        request.scope["headers"] = [
            (b"content-type", b"application/pdf"),
            (b"content-length", str(MAX_PDF_BYTES + 1).encode()),
        ]

        with self.assertRaises(HTTPException) as oversized:
            await upload(request)
        self.assertEqual(oversized.exception.status_code, 413)

    async def test_turn_start_passes_a_local_original_file_reference_not_extracted_content(self) -> None:
        attachment = self.store.save("invoice.pdf", b"%PDF-1.7\nPRIVATE_PDF_TEXT\n%%EOF")
        self.server.start_turn = AsyncMock(return_value={"turn": {"id": "turn-one"}})
        start = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")

        result = await start("thread-one", TurnRequest(
            prompt="请读取这个 PDF",
            pdf_attachments=[attachment.attachment_id],
            request_id="pdf-turn-request-001",
        ))

        prompt = self.server.start_turn.await_args.args[1]
        self.assertEqual(result, {"turn_id": "turn-one"})
        self.assertIn(str(attachment.path), prompt)
        self.assertIn("使用本机可用工具直接读取这个 PDF 原件", prompt)
        self.assertIn("CODEX_REMOTE_PDF_BEGIN", prompt)
        self.assertNotIn("PRIVATE_PDF_TEXT", prompt)

    async def test_immediate_steer_also_passes_the_original_pdf_path(self) -> None:
        attachment = self.store.save("invoice.pdf", b"%PDF-1.7\nPDF_BYTES\n%%EOF")
        self.server.steer_turn = AsyncMock(return_value={"turnId": "turn-one"})
        steer = self.endpoint("/api/v1/codex/threads/{thread_id}/steer")

        result = await steer("thread-one", SteerRequest(
            pdf_attachments=[attachment.attachment_id],
            request_id="pdf-steer-request-001",
        ))

        self.assertEqual(result, {"turn_id": "turn-one"})
        prompt = self.server.steer_turn.await_args.args[1]
        self.assertIn(str(attachment.path), prompt)
        self.assertNotIn("PDF_BYTES", prompt)

    async def test_expired_or_forged_attachment_ids_are_rejected(self) -> None:
        attachment = self.store.save("invoice.pdf", b"%PDF-1.7\nPDF_BYTES\n%%EOF")
        attachment.last_accessed_at = time.time() - PDF_ATTACHMENT_TTL_SECONDS - 1
        self.server.start_turn = AsyncMock(return_value={"turn": {"id": "turn-one"}})
        start = self.endpoint("/api/v1/codex/threads/{thread_id}/turns")

        with self.assertRaises(HTTPException) as expired:
            await start("thread-one", TurnRequest(pdf_attachments=[attachment.attachment_id]))
        self.assertEqual(expired.exception.status_code, 410)
        self.server.start_turn.assert_not_awaited()

        with self.assertRaises(HTTPException) as forged:
            await start("thread-one", TurnRequest(pdf_attachments=["../../etc/passwd" * 2]))
        self.assertEqual(forged.exception.status_code, 410)


if __name__ == "__main__":
    unittest.main()
