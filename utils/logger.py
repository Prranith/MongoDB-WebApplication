"""
utils/logger.py
Structured logging setup using structlog.
All modules import get_logger from here.
"""

import logging
import sys
import structlog
from pathlib import Path


def setup_logging(level: str = "INFO", log_file: Path | None = None) -> None:
    """Configure structlog with console (and optional file) output."""

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="%H:%M:%S"),
            structlog.dev.ConsoleRenderer(colors=True),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(level.upper())
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
    )

    # Optional file handler
    if log_file:
        log_file = Path(log_file)
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        root = logging.getLogger()
        root.addHandler(file_handler)
        root.setLevel(logging.DEBUG)


def get_logger(name: str = __name__) -> structlog.BoundLogger:
    """Return a bound structlog logger for the given module name."""
    return structlog.get_logger(name)
