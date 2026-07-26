"""
api/index.py
Vercel Serverless Python Entrypoint for MongoSandbox.
Runs Flask WSGI application on @vercel/python runtime.
Imports Python core modules: core.database, core.executor, core.snippets, utils.analytics.
"""

import sys
from pathlib import Path
from flask import Flask, jsonify, request, render_template_string

# Ensure project root is in Python path
ROOT_DIR = Path(__file__).parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Import Python Core Engine Modules
from core.database import db_engine
from core.executor import query_executor
from core.snippets import snippets_manager
from utils.analytics import analytics_tracker

app = Flask(__name__)

INDEX_HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to MongoDB Practise Workspace</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background-color: #ffffff;
      color: #001e2b;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 40px 48px;
    }
    .header-box { text-align: center; }
    .title-l1 { font-size: 48px; font-weight: bold; color: #001e2b; }
    .title-l2 { font-size: 56px; font-weight: 900; color: #00684a; margin-top: 4px; }
    .subtitle { font-size: 28px; font-weight: 600; color: #334155; margin-top: 10px; }
    
    .center-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 24px 0;
      gap: 24px;
    }
    .logo-img { width: 380px; height: 380px; object-fit: contain; }
    .cta-btn {
      background-color: #00684a;
      color: #ffffff;
      font-size: 18px;
      font-weight: bold;
      padding: 16px 36px;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
    }
    .cta-btn:hover { background-color: #00ed64; color: #001e2b; }

    .footer-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding-top: 24px;
      border-top: 1px solid #e2e8f0;
    }
    .stat-label { font-size: 18px; font-weight: bold; color: #001e2b; }
    .stat-green { color: #00684a; }
    .dev-link { color: #0284c7; text-decoration: underline; font-weight: bold; }
  </style>
</head>
<body>
  <div class="header-box">
    <div class="title-l1">Welcome to  MongoDB Practise</div>
    <div class="title-l2">Workspace</div>
    <div class="subtitle">A unified platform to learn mongodb precisely</div>
  </div>

  <div class="center-box">
    <svg class="logo-img" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M100 15L173.205 57.3V142.7L100 185L26.7949 142.7V57.3L100 15Z" fill="#00684A" stroke="#00ED64" stroke-width="4"/>
      <path d="M100 45C100 45 75 75 75 105C75 125 88 140 100 155C112 140 125 125 125 105C125 75 100 45 100 45Z" fill="#FFFFFF"/>
      <path d="M100 45V155" stroke="#00684A" stroke-width="3"/>
    </svg>
    <a href="/workspace" class="cta-btn">🚀 Enter Workspace ➔</a>
  </div>

  <div class="footer-row">
    <div>
      <div class="stat-label">Active Users : {{ active_users }}</div>
      <div class="stat-label stat-green">Total Visited : {{ total_visits }}</div>
    </div>
    <div style="text-align: right;">
      <div class="stat-label">Visit developer : Prranith Swargam</div>
      <a href="https://www.linkedin.com/in/prranith-swargam-a620a6334/" target="_blank" class="dev-link">https://www.linkedin.com/in/prranith-swargam-a620a6334/</a>
    </div>
  </div>
</body>
</html>
"""

WORKSPACE_HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>MongoSandbox IDE Workspace</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', monospace; background-color: #1e1e1e; color: #ffffff; height: 100vh; display: flex; flex-direction: column; }
    .nav { height: 40px; background-color: #252526; display: flex; align-items: center; padding: 0 16px; gap: 16px; border-bottom: 1px solid #3c3c3c; font-size: 13px; }
    .nav a { color: #38bdf8; text-decoration: none; font-weight: bold; }
    .main { flex: 1; display: flex; }
    .sidebar { width: 220px; background-color: #252526; padding: 16px; border-right: 1px solid #3c3c3c; font-size: 13px; }
    .editor-pane { flex: 1; display: flex; flex-direction: column; padding: 16px; gap: 12px; }
    textarea { width: 100%; height: 180px; background-color: #2d2d2d; color: #00ed64; font-family: monospace; font-size: 15px; border: 1px solid #3c3c3c; padding: 12px; border-radius: 6px; }
    button { background-color: #00684a; color: white; padding: 10px 20px; border: none; font-weight: bold; border-radius: 6px; cursor: pointer; }
    button:hover { background-color: #00ed64; color: #001e2b; }
    .console { flex: 1; background-color: #111111; color: #38bdf8; padding: 12px; font-family: monospace; font-size: 13px; overflow-y: auto; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/">🏠 Intro Page</a>
    <span>● MongoDB Practice Workspace (Python Serverless Engine)</span>
  </div>
  <div class="main">
    <div class="sidebar">
      <h4 style="color:#00ed64; margin-bottom:12px;">⛁ Collections</h4>
      {% for coll in collections %}
        <div style="margin-bottom:8px;">📄 {{ coll }}</div>
      {% endfor %}
    </div>
    <div class="editor-pane">
      <form method="POST" action="/query">
        <textarea name="query_str" spellcheck="false">{{ query_str or 'db.users.find({})' }}</textarea><br/><br/>
        <button type="submit">▶ Run Query (Python Engine)</button>
      </form>
      <h3>OUTPUT CONSOLE</h3>
      <div class="console">{{ result_json }}</div>
    </div>
  </div>
</body>
</html>
"""

@app.route('/')
def home():
    analytics_tracker.record_app_launch()
    stats = analytics_tracker.get_stats()
    return render_template_string(
        INDEX_HTML_TEMPLATE,
        active_users=stats.get("active_users", 1),
        total_visits=stats.get("total_visits", 1)
    )

@app.route('/workspace')
def workspace():
    colls = db_engine.list_collections()
    return render_template_string(WORKSPACE_HTML_TEMPLATE, collections=colls, query_str='db.users.find({})', result_json='[info] Python Execution Engine Ready.')

@app.route('/query', methods=['POST'])
def execute_query():
    q_str = request.form.get('query_str', 'db.users.find({})')
    res = query_executor.execute(q_str)
    colls = db_engine.list_collections()
    import json
    return render_template_string(
        WORKSPACE_HTML_TEMPLATE,
        collections=colls,
        query_str=q_str,
        result_json=json.dumps(res, indent=2)
    )
