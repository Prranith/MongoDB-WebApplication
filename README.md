# CodeLeaf - MongoDB Web Portal 🚀

> **A multilingual coding, assessment, examination, and collaboration platform for developers, mentors, and students.**

[![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-API-green.svg)](https://flask.palletsprojects.com/)
[![Vercel](https://img.shields.io/badge/Vercel-Serverless-black.svg)](https://vercel.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## ✨ Features

- **Multilingual Coding Workspace**: Edit and execute MongoDB, SQL, Python, C, C++, and Java with CodeMirror-based tooling.
- **AI Coding Assistance**: Review the full active file, explain issues, suggest corrections, and optionally apply safe changes.
- **Proctored Examination Environment**: Prevent external copy-pasting, track full-screen exits, grade submissions, and manage question papers.
- **Mentor Real-time Dashboard**: Live view of participant leaderboards, violations, kicked users, and active submissions.
- **Coding Meetings**: Collaborate through meeting rooms, chat, reactions, workspace sharing, and editor-follow mode.
- **Robust Multi-line Copy-Paste Enforcement**: Intelligently allows copying within the application editor but heavily restricts and reports external pastes.
- **Single Page Application (SPA)**: Custom-built lightweight vanilla JavaScript framework avoiding heavy frontend dependencies.
- **Database Practice Sandboxes**: Run MongoDB queries and SQL against datasets with schema inspection and formatted output.
- **Excel Results Export**: Mentors can export the leaderboard to an `.xlsx` sheet for official records.

### Execution queues

Playground SQL and MongoDB execution can be routed through CloudAMQP when an
execution worker is available. Compiled playground and exam code use their
direct API execution callbacks and do not use the queue. Browser on-device
execution remains the primary path for supported workspace languages.

Configure the API and worker with:

```text
CLOUDAMQP_URL=amqps://user:password@host/vhost
EXECUTION_QUEUE_ENABLED=1
EXECUTION_QUEUE_WAIT_SECONDS=25
EXECUTION_WORKER_PREFETCH=1
```

With `CLOUDAMQP_URL` present, queue mode is enabled by default. Keep the API
deployment and worker on the same MongoDB database: the broker carries only a
small job envelope while source code, queries, and results stay in MongoDB.
Start the worker from the repository root with:

```bash
python -m services.execution.worker
```

The worker must run as a long-lived Python process outside Vercel. The
`Dockerfile.worker` image includes Python, GCC, G++, and the Java JDK. It is
used for queued database-query work; compiled-code requests do not depend on
it. Deploy it as a continuously running worker service (not a web service), and configure
the **same** `CLOUDAMQP_URL`, `MONGO_URI`, and `EXECUTION_JOB_COLLECTION` values
on both the Vercel API and the worker. A worker connected to a different broker
or MongoDB database cannot see the published jobs and will cause the API to
time out. Do not deploy the worker without setting its secrets in the hosting
platform's environment settings.

The admin overview reports recent worker heartbeats; a configured queue with
no online worker is shown as degraded. Timeout responses also include the
persisted job status and whether a worker was visible. The worker persists a
result before acknowledging its RabbitMQ message. Broker publish and job-ledger
failures return JSON `503` responses for queued requests; use the response
correlation ID to locate the matching API log entry instead of interpreting an
HTML platform error.
Playground SQL and MongoDB queries fall back to their bounded in-API sandbox
engines while no worker heartbeat is available.

Build and run the worker image with:

```bash
docker build -f Dockerfile.worker -t codeleaf-execution-worker .
docker run --restart unless-stopped \
  -e CLOUDAMQP_URL \
  -e MONGO_URI \
  codeleaf-execution-worker
```

No Paiza or Piston API is used.

---

## 🏗 System Architecture

The application operates heavily on a **Stateless Serverless API Model** connected with a highly available key-value store (Redis via Upstash) for real-time exam tracking.

```mermaid
graph TD
    %% Define Client Tier
    subgraph Frontend [Client Browser]
        UI[Vanilla JS SPA]
        CM[CodeMirror Editor]
        Proctor[Proctoring Listeners]
        
        UI <--> CM
        UI <--> Proctor
    end

    %% Define Network Layer
    subgraph CDN [Vercel Edge Network]
        Static[Static Assets & Compiled HTML]
        API_GW[Vercel Serverless Gateway]
    end

    %% Define Backend Tier
    subgraph Backend [Flask Serverless API]
        Index[api/index.py]
        Exam[exam_routes.py]
        DB[database_routes.py]
        Compile[Mongo to PyMongo Engine]
        
        Index --> Exam
        Index --> DB
        DB --> Compile
    end

    %% Define Data Tier
    subgraph Data [Data Persistence]
        Redis[(Upstash Redis)]
        MemDB[(In-Memory Dataset/TestCases)]
    end

    %% Wiring
    UI <-->|HTTP GET| Static
    UI <-->|HTTP REST /api/*| API_GW
    API_GW <--> Index
    
    Exam <-->|State/Leaderboard| Redis
    Compile <-->|Execute Query| MemDB
    Proctor -.->|Violation Webhook| Exam
```

---

## 🧩 Core Services Detailed

### 1. The Frontend (SPA)
The frontend is compiled into a single massive index file (`public/index.html`) using a python bundling script (`embed_frontend.py`). It orchestrates multiple DOM namespaces without the overhead of React or Vue:
- **`panels.js`**: Controls the visibility of various overlay screens (Role selection, Exam Dashboard, Submission Panel).
- **`exam.js`**: Contains the majority of the business logic. Handles exam synchronization via HTTP polling, UI updates (DOM diffing), clipboard interception, fullscreen management, and API calls.

### 2. The Flask Backend (API)
The backend acts as an ephemeral execution layer hosted on Vercel Serverless Functions (`api/index.py`):
- **`exam_routes.py`**: Manages the life cycle of the examination rooms. Creates room tokens, authenticates users, receives code submissions, manages leaderboards, and logs proctoring violations.
- **`database_routes.py`**: Interacts with the dataset models.
- **Translation Engine**: Translates Javascript-like MongoDB syntax (e.g. `db.collection.find()`) securely into Python `pymongo` syntax in sandboxed contexts to run test cases.

### 3. Upstash Redis (State Management)
Because the Flask backend is serverless (stateless), Redis is used as the centralized source of truth:
- Tracks live `participants`.
- Manages the `leaderboard` scores and metrics.
- Logs `kicked` students in dictionary maps tracing kick reasons.
- Stores historical `submissions` for mentors to review.

### 4. Proctoring Subsystem
A combination of frontend EventListeners and backend Webhooks:
- Intercepts `paste` events and ensures clipboard text strictly matches text copied internally via CodeMirror's `getSelection()` APIs. Rejects external data.
- Listens to `fullscreenchange` and reports to the Mentor Dashboard immediately if the user tabs out or minimizes the window.

---

## 🚀 Quick Start (Local Development)

### Prerequisites

- Python 3.11+
- Vercel CLI (Optional but recommended for deployment testing)
- Redis Upstash URL (Environment variables)

### Setup

```bash
# Clone the repository
git clone https://github.com/prranith-swargams-projects/practice-mongodb
cd practice-mongodb

# Install dependencies
pip install -r api/requirements.txt

# Run the local vercel development server
vercel dev
```

### Build the Frontend
To bundle the frontend JavaScript, CSS, and SVG components into the deployable `index.html`:
```bash
python embed_frontend.py
```

### Deploy to Production
```bash
vercel --prod
```

### CodeLeaf AI provider configuration

CodeLeaf AI supports Groq as the fast primary provider and Gemini as a fallback. Keep API keys server-side; do not put them in frontend files or commit them.

```bash
# Recommended: use Groq first, then Gemini if Groq is unavailable
AI_PROVIDER=auto
AI_PROVIDER_FALLBACKS=groq,gemini
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=llama-3.3-70b-versatile

# Optional tuning for concurrent requests and slow provider responses
AI_TIMEOUT_SECONDS=30
GEMINI_MAX_CONCURRENT=2
GEMINI_MIN_INTERVAL_SECONDS=1.5
```

To use only one provider, set `AI_PROVIDER=groq` or `AI_PROVIDER=gemini`. Configure these variables in the local server environment or the Vercel project settings, then restart the server.

### Authentication configuration

CodeLeaf authentication uses email/password accounts stored in MongoDB Atlas. The implementation uses server-side session records, HttpOnly/SameSite cookies, rate limiting, audit events, and scrypt password hashes.

Copy `.env.example` for local setup, or configure the same variables in Vercel. OAuth authentication is currently disabled.

```text
AUTH_DB_NAME=codeleaf_auth
AUTH_SECRET_KEY=replace-with-a-long-random-secret
AUTH_REQUIRED=1
```

Set `AUTH_REQUIRED=1` only after `MONGO_URI` and `AUTH_SECRET_KEY` are configured. The home page and `/api/auth/*` remain public so users can sign in; application APIs are then protected by the shared session gate.

---

## 🗄 Supported Query Syntax

The application translates standard MongoDB shell syntax automatically to run securely on the server:

```javascript
db.collection.find({ status: "ACTIVE" }).sort({ count: -1 }).limit(10)

db.collection.aggregate([
  { $match: { category: "ELECTRONICS" } },
  { $group: { _id: "$brand", total: { $sum: "$price" } } }
])
```

---

## 📄 License

MIT License — see [LICENSE](LICENSE).
