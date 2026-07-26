"""
launcher.py
Entry point for MongoSandbox.
Run with: python launcher.py
"""

import sys
from pathlib import Path

# Ensure project root is on the Python path
sys.path.insert(0, str(Path(__file__).parent))

from utils.logger import setup_logging
from utils.config import config
from app import create_app


def main() -> int:
    # Setup logging first
    setup_logging(level=config.get("log_level", "INFO"))

    app, window = create_app()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
