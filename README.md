# MongoSandbox 🍃

> **The LeetCode of MongoDB Practice** — A professional, open-source desktop IDE for mastering MongoDB queries.

[![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://python.org)
[![PySide6](https://img.shields.io/badge/PySide6-6.7+-green.svg)](https://pypi.org/project/PySide6/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## ✨ Features

| Feature | Status |
|---|---|
| 🎨 Dark/Light themes (5 built-in) | ✅ |
| 💡 Syntax highlighting (MongoDB Shell, JSON) | ✅ |
| ⚡ Query execution with timing stats | ✅ |
| 📁 Multi-tab editor | ✅ |
| 🗄 Database Explorer (collections, indexes, schema) | ✅ |
| ⏰ Query history (SQLite, full-text search) | ✅ |
| 🔧 MongoDB snippets library (22 built-in) | ✅ |
| 🎯 Command Palette (Ctrl+Shift+P) | ✅ |
| 📄 JSON tree view for results | ✅ |
| 🌐 JavaScript→PyMongo translator | ✅ |
| 📊 Execution statistics (time, doc count) | ✅ |
| 🔔 Toast notifications | ✅ |
| 💾 Save/load queries | ✅ |
| 📂 Load dataset from JSON | ✅ |

---

## 🚀 Quick Start

### Prerequisites

- Python 3.11+
- No local MongoDB daemon required (uses built-in file-based JSON database engine)

### Install

```bash
git clone https://github.com/yourusername/mongosandbox
cd mongosandbox
pip install -r requirements.txt
```

### Run

```bash
python launcher.py
```

---

## 📁 Project Structure

```
MongoSandbox/
├── launcher.py              # Entry point
├── app.py                   # QApplication bootstrap
├── requirements.txt
│
├── ui/                      # All PySide6 UI components
│   ├── main_window.py       # Root window
│   ├── toolbar.py           # Top action toolbar
│   ├── statusbar.py         # Status bar
│   ├── command_palette.py   # Ctrl+Shift+P palette
│   ├── notifications.py     # Toast notifications
│   ├── connect_dialog.py    # Connection + settings dialogs
│   ├── editor/
│   │   ├── editor_widget.py # Code editor
│   │   └── tab_manager.py   # Multi-tab manager
│   ├── console/
│   │   ├── console_widget.py # Output console
│   │   └── result_tree.py   # JSON tree view
│   └── sidebar/
│       ├── sidebar_widget.py # Sidebar container
│       ├── db_explorer.py   # Database explorer
│       ├── history_panel.py # Query history
│       └── snippets_panel.py # Snippets
│
├── core/                    # Business logic (no UI imports)
│   ├── database.py          # MongoDB connection manager
│   ├── executor.py          # Query execution engine
│   ├── formatter.py         # Result formatting
│   ├── history.py           # SQLite history
│   ├── snippets.py          # Snippet registry
│   ├── autocomplete.py      # IntelliSense engine
│   └── translator/
│       ├── translator.py    # Translation orchestrator
│       └── fallback.py      # Regex-based translator
│
├── utils/                   # Cross-cutting utilities
│   ├── theme.py             # 5 built-in themes + QSS
│   ├── config.py            # JSON config (~/.mongosandbox/)
│   ├── signals.py           # Global Qt signal bus
│   ├── logger.py            # Structured logging
│   └── helpers.py           # Utility functions
│
└── assets/
    ├── snippets/mongodb.json # 22 built-in snippets
    └── themes/              # Custom theme JSON files
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Run Query |
| `Ctrl+Shift+P` | Command Palette |
| `Ctrl+Shift+F` | Format Document |
| `Ctrl+S` | Save Query |
| `Ctrl+T` | New Tab |
| `Ctrl+W` | Close Tab |
| `Ctrl+D` | Duplicate Line |
| `Ctrl+Shift+K` | Delete Line |
| `Alt+Up` | Move Line Up |
| `Alt+Down` | Move Line Down |
| `Ctrl+/` | Toggle Comment |

---

## 🌙 Themes

- **Dark+** (default) — VS Code inspired
- **Monokai** — Classic dark
- **Dracula** — Purple & pink
- **One Dark** — Atom inspired
- **GitHub Light** — Clean light theme

---

## 🗄 Supported Query Syntax

MongoSandbox translates MongoDB shell syntax to PyMongo automatically:

```javascript
// These all work:
db.elite_data.find({ status: "PAID" }).sort({ amount: -1 }).limit(5)

db.elite_data.aggregate([
  { $match: { status: "PAID" } },
  { $group: { _id: "$provider", total: { $sum: "$amount" } } },
  { $sort: { total: -1 } }
])

db.elite_data.countDocuments({ provider: "stripe" })
db.elite_data.distinct("status")
db.elite_data.findOne({ userId: "u1" })
```

---

## 🤝 Contributing

See [CONTRIBUTING.md](docs/contributing.md). All contributions welcome!

---

## 📄 License

MIT License — see [LICENSE](LICENSE).
