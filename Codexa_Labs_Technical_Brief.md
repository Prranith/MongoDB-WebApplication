

# Codexa Labs: Technical Architecture & Scaling Brief
*Prepared for the Founder & CEO*

---

## 1. Executive Summary & Core Story
This document outlines the technical architecture, evolution, trade-offs, and scaling roadmap of **Codexa Labs**—a multi-language coding, database assessment, and proctoring platform. 

Codexa was engineered iteratively to solve real-world testing bottlenecks, starting from a localized database practice sandbox and evolving into a fully-proctored multi-language exam suite.

```
+--------------------------+     +--------------------------+
|  Phase 1: Query Practice  | --> |   Phase 2: Exam Portal   |
|  - Custom/remote data    |     |   - Mentor room control  |
|  - In-browser sandbox    |     |   - Structured tests     |
+--------------------------+     +--------------------------+
             |                                 |
             v                                 v
+--------------------------+     +--------------------------+
| Phase 3: Multi-Language  | --> | Phase 4: Full Assessment |
|  - C, C++, Java, Python  |     |   - Proctoring controls  |
|  - Piston/Paiza APIs     |     |   - Playback & grading   |
+--------------------------+     +--------------------------+
```

### Phase 1: The Original Problem
Developers lacked a simple, zero-setup platform to practice MongoDB queries against custom or remote datasets. Codexa was initialized as a lightweight query practice sandbox. Users wrote JavaScript-style MongoDB queries in a browser editor, which were evaluated on the fly against an ephemeral, in-memory MongoDB interface.

### Phase 2: Transition to MongoDB Exam Portal
The practice model was extended to support educational assessments. Mentors needed to run structured, secure examinations. The platform introduced rooms, enabling mentors to control student registration, distribute questions, and aggregate results in real time.

### Phase 3: Multi-Language Expansion
To eliminate the single-database limitation, the compiler pipeline was expanded to execute general-purpose programming languages: **C, C++, Java, and Python**. The backend integrated third-party compilation and execution engines (Piston and Paiza APIs), enabling these languages in both practice workspaces and active exam rooms.

### Phase 4: Full-Scale Assessment & Proctoring System
Today, Codexa stands as a unified assessment portal. It combines database query evaluations, multi-language code compilation, automated test case generation, active proctoring (tab-switch tracking, clipboard isolation), real-time monitoring, and complete visual/state playbacks for post-exam auditing.

---

## 2. Product Capabilities & Technical Workflow

Codexa implements a streamlined interface for two primary user classes: **Mentors** and **Students**.

### Mentor Operations
*   **Room Lifecycle:** Mentors create rooms with unique IDs (e.g., `MNG-XXX` format) stored in MongoDB Atlas. Each room acts as a distinct tenant namespace.
*   **Question Authoring:** Mentors write Multiple-Choice Questions (MCQs), multi-language coding questions, or MongoDB query questions. Media attachments (images and MP4 videos) can be embedded directly.
*   **Zero-Setup Dataset Validation (Expected Output Freezing):** For MongoDB questions, mentors upload a custom JSON dataset. The system executes the mentor's reference query against this dataset, retrieves the output, and "freezes" it as a deterministic JSON string (`q_answer:<question_id>`). Student queries are later compared against this frozen output, removing the need for mentors to define expected outputs manually.
*   **Real-time Proctoring Dashboard:** Shows student code changes, scores, active connections, and flagged proctoring violations.
*   **Malicious User Control:** Mentors can kick students out of a live exam. The student’s state is marked as `kicked` in the database, preventing re-entry unless the mentor manually issues a `reallow` command.
*   **Reusability:** Question papers can be exported as JSON files and reloaded, eliminating setup overhead.

### Student Workspace
*   **In-Browser IDE:** A custom Single-Page Application (SPA) housing a CodeMirror editor customized for MongoDB syntax, C, C++, Java, or Python.
*   **Resiliency & Persistence:** Student solutions are debounced and auto-saved periodically via HTTP API calls. If the student's browser crashes, their state is restored instantly upon reconnection.

### Post-Exam Auditing & Playback
*   **Grade Export:** Mentors can export the final leaderboard to an Excel (`.xlsx`) sheet.
*   **State Playback:** The platform records student responses, scores, code edits, and timeline events (such as proctoring violations). Mentors can load this playback bundle to visually replay the student's timeline, which is crucial for grading validation, auditing, and resolving disputes.

---

## 3. Current System Architecture

The codebase follows clean separation of concerns, routing logic is decoupled from business engines, and state is preserved in persistent databases.

```
       +--------------------------------------------+
       |             Client Browser (SPA)           |
       |  [CodeMirror] [Proctoring] [Dashboard UI]  |
       +--------------------------------------------+
                             |
                      HTTP REST /api/*
                             v
       +--------------------------------------------+
       |        Vercel Serverless Gateway           |
       +--------------------------------------------+
                             |
                             v
       +--------------------------------------------+
       |            Flask Serverless API            |
       |  [exam_routes.py]  [database_routes.py]    |
       +--------------------------------------------+
          |                  |                 |
          | Read/Write       | Evaluate Query  | Execute Code
          v                  v                 v
+-----------------+  +---------------+  +------------------+
|  MongoDB Atlas  |  |   mongomock   |  |  Piston & Paiza  |
|  (State & Room) |  |  (In-Memory)  |  |  Compiler APIs   |
+-----------------+  +---------------+  +------------------+
```

### Key Modules & Domain Organization
1.  **Routing Layer:**
    *   [`api/routes/exam_routes.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/api/routes/exam_routes.py): Exposes endpoints for room creation, student registration, code execution, submission, proctoring alerts, and dashboard states.
    *   [`api/routes/database_routes.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/api/routes/database_routes.py): Manages schema generation, collection listings, and direct MongoDB practice query executions.
2.  **Domain & Service Layer:**
    *   [`services/exam/room_service.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/services/exam/room_service.py): Encapsulates room lifecycle, state modifications (`waiting`, `live`, `ended`), and settings updates.
    *   [`services/submission/submission_service.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/services/submission/submission_service.py): Contains grading engines for MCQs, query evaluations, and multi-language compiler runs.
    *   [`services/compiler/compiler_service.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/services/compiler/compiler_service.py): Integrates with external compiler APIs (Piston and Paiza) for compiling C, C++, Java, and Python.
    *   [`services/proctoring/proctoring_service.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/services/proctoring/proctoring_service.py): Handles violation tracking, self-kicks on limit breaches, and mentor admission controls.
3.  **Data Isolation & Session Facade:**
    *   [`services/shared/redis_client.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/services/shared/redis_client.py): Translates standard Redis commands (`HSET`, `HGET`, `HMGET`, `HDEL`, `EXISTS`) into MongoDB Atlas updates inside the `rooms` collection, providing a Redis-like key-value interface to avoid state synchronization issues across serverless Flask instances.
    *   [`utils/analytics.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/utils/analytics.py): Tracks operational visits and query volumes. Uses Upstash Redis HTTP REST endpoints with a local thread-safe JSON backup.

---

## 4. Key Technical Design Decisions & Trade-Offs

### 1. Redis Command Facade Over MongoDB Atlas
*   **Decision:** Simulated a Redis interface (`redis_client.py`) directly over a MongoDB Atlas collection (`rooms`). All `redis_cmd` and `redis_one` calls execute pymongo updates under the hood.
*   **Why:** Re-uses existing Redis call semantics while bypassing Vercel serverless DNS resolution timeouts associated with SRV connection strings. It consolidates persistence into MongoDB.
*   **Trade-off:** High-volume sessions execute multiple `update_one` or `find_one` calls. This adds CPU and write-lock latency in Mongo Atlas compared to an in-memory Redis cluster.

### 2. In-Memory Mocking (`mongomock`) for MongoDB Queries
*   **Decision:** Implemented isolated, per-request `mongomock.MongoClient` instances inside the backend when executing practice queries and grading submissions.
*   **Why:** Prevents students from writing malicious queries that could drop collections or modify global database state. It provides execution isolation without the cost of spawning actual database containers per student.
*   **Trade-off:** `mongomock` does not support 100% of MongoDB's aggregation operators, resulting in translation edge-cases for highly complex queries.

### 3. External Compiler Integration (Piston + Paiza)
*   **Decision:** Integrated public REST APIs of Piston (`emkc.org`) and Paiza (`api.paiza.io`) for C/C++/Java/Python compilation. Spawns threads (`ThreadPoolExecutor`) to execute test cases concurrently.
*   **Why:** Enabled multi-language compiler support without having to build, secure, and maintain dedicated execution containers.
*   **Trade-off:** Dependency on external endpoints introduces network latency, rate limits, and security vulnerabilities if students submit infinite loops or memory exhaustion scripts.

### 4. CodeMirror with Query Parser in Frontend
*   **Decision:** Used CodeMirror inside a custom Vanilla JS framework (`public/js/features/exam.js`) compiled via [`embed_frontend.py`](file:///c:/Users/swarg/Desktop/MongoSandbox/embed_frontend.py).
*   **Why:** Minimizes web footprint, allowing fast page loads on weak student network connections.
*   **Trade-off:** Building custom UI lifecycle routines in vanilla JS increases codebase complexity compared to modern state-driven libraries (e.g., React or Svelte).

---

## 5. Prototype vs. Production: Scaling to 10,000+ Concurrent Students

The initial codebase was optimized for cost and prototype speed. However, running a live exam with **10,000+ concurrent students** will cause several architectural bottlenecks:

```
[Current Codebase: Synchronous Execution]
Student Submission --> Flask API (Sync) --> Piston API (External HTTP) --> Blocked Thread

[Proposed Future: Asynchronous Queueing]
Student Submission --> API Gateway --> Redis Queue (Job Enqueue) --> Response (202 Accepted)
                                                                           |
   +-----------------------------------------------------------------------+
   v
Worker Pool (Docker/Firecracker) --> Pull Job --> Execute Sandboxed Code --> Update Mongo Atlas / SSE
```

### Identified Scale Bottlenecks
1.  **Synchronous HTTP Blocks:** The backend handles code execution synchronously. In `SubmissionService.submit_answer`, each student submission blocks the serverless Flask handler while it makes multiple HTTP requests to Piston or Paiza. This will exhaust Vercel’s concurrent function limits.
2.  **External API Rate Limits:** Public APIs cannot handle 10,000+ parallel requests. They will rate-limit or fail, blocking all student evaluations.
3.  **Database Thread Locks:** Storing every keystroke auto-save as an update operation against a single MongoDB room document (`rooms`) will lead to high write contention and database lockups.

---

## 6. Next Engineering Work: Dedicated Execution Infrastructure

To handle 10,000+ concurrent users, we must decouple code execution from the main HTTP API request-response cycle.

### Proposed Architecture Changes
1.  **Asynchronous Execution Queue:** Move compilation and execution to an asynchronous backend. Introduce a Redis-backed queue (e.g., Celery or BullMQ) to receive submissions.
2.  **Dedicated Execution Workers:** Spawn stateless execution workers inside isolated environments (Docker containers or AWS Firecracker microVMs).
3.  **Language-Specific Isolation:** Each worker pulls a job, executes the student's code against predefined test cases, and stores the outcome in a Redis result cache.
4.  **Real-time Notification:** Inform the client of completion via WebSockets or Server-Sent Events (SSE), resolving the synchronous blocking issue.

```
+---------------------------------------------------------------------------------+
|                               NEXT ENGINEERING WORK                             |
+---------------------------------------------------------------------------------+
| Feature                  | Implementation Strategy                              |
+--------------------------+------------------------------------------------------+
| Submissions Queueing     | Redis-backed task queue (RQ / Celery)                |
| Sandbox Execution        | Docker / AWS Firecracker microVMs                    |
| Real-time Client Sync    | Server-Sent Events (SSE) or WebSockets               |
| Rate Limiting            | Token Bucket algorithm at Vercel/Nginx gateway       |
| Idempotency              | UUID-based idempotency keys on student submissions   |
| Database Scaling         | Read-replicas, document partitioning by Student ID   |
| Database Scaling         | Read-replicas, document partitioning by Student ID   |
+---------------------------------------------------------------------------------+
```

---

## 7. Next-Step Scaling Roadmap

### 1. Multi-Device & Session Lockouts
*   **Problem:** Students can open multiple tabs or share credentials to bypass proctoring controls.
*   **Proposed Change:** Bind each room token to a single active session ID in Redis. Terminate old sessions upon new logins.
*   **Why it Matters:** Guarantees academic integrity by preventing students from running exams on multiple devices.

### 2. submission Rate Limiting
*   **Problem:** Spammed compilation clicks can overload execution workers.
*   **Proposed Change:** Apply a token-bucket rate limiter at the gateway, limiting students to one compilation run every 10 seconds.
*   **Why it Matters:** Protects execution infrastructure from Denial of Service (DoS) events.

### 3. Submission Idempotency
*   **Problem:** Network retries can run test cases twice, skewing scoring history.
*   **Proposed Change:** Attach a unique client-generated UUID to every submission. Verify if the UUID has already been evaluated before executing.
*   **Why it Matters:** Ensures deterministic scoring and prevents duplicate worker execution.

### 4. Leaderboard Pagination
*   **Problem:** Fetching a 10,000-student leaderboard in one request causes high memory overhead.
*   **Proposed Change:** Implement cursor-based pagination for the dashboard.
*   **Why it Matters:** Lowers database query times and reduces payload sizes.

### 5. Circuit Breaker for Fallbacks
*   **Problem:** Cascading failures when external APIs fail.
*   **Proposed Change:** Wrap compiler calls in a circuit breaker. Fallback to a local static checker if execution engines fail.
*   **Why it Matters:** Keeps the platform responsive during compiler service outages.

---

## 8. Current System vs. Proposed Future

| Feature | Current Prototype System | Proposed Production System |
| :--- | :--- | :--- |
| **Database Storage** | MongoDB Atlas (Single Instance) | MongoDB Atlas (Sharded Cluster) |
| **Session Cache** | MongoDB Redis Client Facade | Distributed Redis Cluster |
| **Execution Path** | Synchronous REST Calls | Asynchronous Task Queue |
| **Compiler Service** | Piston & Paiza APIs (Shared) | Isolated Worker Pool (MicroVMs) |
| **Real-time Sync** | HTTP Polling (10s intervals) | WebSockets / Server-Sent Events (SSE) |
| **Request Limit** | No Rate Limiting | Gateway Rate Limiting |
| **Dashboard Grading** | Full Document Scans | Cursor-paginated Aggregations |
| **Idempotency** | Standard HTTP POST | UUID-based Idempotency Keys |

---

## 9. Final Summary

```
+-----------------------------------------------------------------------------------+
|                               WHAT I HAVE BUILT                                   |
+-----------------------------------------------------------------------------------+
| 1. Iterative query practice portal with sandboxed in-memory execution.            |
| 2. Secure exam environments with custom dataset validation & output freezing.    |
| 3. Integrated multi-language compilation using ThreadPool execution.             |
| 4. Proctoring suite tracking fullscreen exits & copy-paste attempts.              |
| 5. Interactive timeline recording & full-state playback.                         |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
|                              WHAT I AM SOLVING NEXT                               |
+-----------------------------------------------------------------------------------+
| 1. High-concurrency async execution queueing.                                    |
| 2. Self-hosted sandbox isolation using Docker/Firecracker.                        |
| 3. Distributed Redis session caching to support high workloads.                   |
| 4. Enhanced proctoring security via device session locks.                        |
+-----------------------------------------------------------------------------------+
```

> **Build the simplest system that proves the idea. Then identify exactly where it breaks and replace only the part that needs to scale.**
