"""
api/index.py
Flask-based Vercel serverless API bootstrap.
Zero PySide6 dependency. Registers modular blueprints.
"""

import sys
from pathlib import Path

# Add project root so all core/ and utils/ imports work
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from flask import Flask
from flask_cors import CORS

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Import blueprints from the modular routes folder
from api.routes.static_routes import static_bp
from api.routes.database_routes import database_bp
from api.routes.file_routes import file_bp
from api.routes.analytics_routes import analytics_bp

# Register blueprints to keep code structure modular and maintainable
app.register_blueprint(static_bp)
app.register_blueprint(database_bp)
app.register_blueprint(file_bp)
app.register_blueprint(analytics_bp)

# Vercel calls this 'app' variable via handler
handler = app
