"""
core/translator/translator.py
Main translation orchestrator.
Passes the raw query through the fallback regex translator.
Designed to be swapped for Lark AST in Milestone 5.
"""

from dataclasses import dataclass
from utils.logger import get_logger
from core.translator.fallback import translate as regex_translate

log = get_logger(__name__)


@dataclass
class TranslationResult:
    """Result of a translation attempt."""
    success: bool
    translated: str      # Python-ready code string
    raw: str             # Original input
    method: str          # "regex" | "ast"
    error: str = ""      # Error message if success=False


class QueryTranslator:
    """
    Translates MongoDB shell (JS-like) syntax to valid PyMongo Python code.
    Primary: regex fallback (fast, no extra deps)
    Future:  Lark AST (Phase 5) — swappable here.
    """

    def translate(self, raw: str) -> TranslationResult:
        """
        Translate raw MongoDB shell query string.
        Returns a TranslationResult with the Python-ready code.
        """
        if not raw.strip():
            return TranslationResult(
                success=True, translated="", raw=raw, method="regex"
            )

        try:
            translated = regex_translate(raw)
            log.debug("Translation successful", method="regex",
                      raw_len=len(raw), out_len=len(translated))
            return TranslationResult(
                success=True, translated=translated,
                raw=raw, method="regex"
            )
        except Exception as e:
            log.warning("Translation failed", error=str(e))
            return TranslationResult(
                success=False, translated="", raw=raw,
                method="regex", error=str(e)
            )


# Module-level singleton
translator = QueryTranslator()
