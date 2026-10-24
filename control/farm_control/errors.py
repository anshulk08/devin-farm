from __future__ import annotations


class ControlError(Exception):
    """An API error rendered as `{"error": {"code", "message"}}` (same envelope as C1)."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
