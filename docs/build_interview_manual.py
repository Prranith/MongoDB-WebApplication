from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "Codexa_Labs_Forensic_Interview_Manual.docx"
doc = Document()
sec = doc.sections[0]
sec.top_margin = Inches(.68); sec.bottom_margin = Inches(.62)
sec.left_margin = Inches(.72); sec.right_margin = Inches(.72)
styles = doc.styles
styles["Normal"].font.name = "Aptos"; styles["Normal"].font.size = Pt(9)
for n, sz, col in [("Title",28,"17365D"),("Heading 1",18,"17365D"),("Heading 2",13,"1F4E79"),("Heading 3",10.5,"365F91")]:
    st=styles[n]; st.font.name="Aptos Display"; st.font.size=Pt(sz); st.font.bold=True; st.font.color.rgb=RGBColor.from_string(col)
    st._element.rPr.rFonts.set(qn("w:ascii"),"Aptos Display")

def shade(c, fill):
    pr=c._tc.get_or_add_tcPr(); x=pr.find(qn("w:shd"))
    if x is None: x=OxmlElement("w:shd"); pr.append(x)
    x.set(qn("w:fill"),fill)

def text_cell(c, value, bold=False, color=None):
    c.text=""; p=c.paragraphs[0]; p.paragraph_format.space_after=Pt(0)
    r=p.add_run(str(value)); r.bold=bold
    if color: r.font.color.rgb=RGBColor.from_string(color)
    c.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER

def table(headers, rows):
    t=doc.add_table(rows=1, cols=len(headers)); t.style="Table Grid"; t.alignment=WD_TABLE_ALIGNMENT.CENTER
    for i,h in enumerate(headers):
        text_cell(t.rows[0].cells[i],h,True,"FFFFFF"); shade(t.rows[0].cells[i],"1F4E79")
    for ri,row in enumerate(rows):
        cells=t.add_row().cells
        for i,v in enumerate(row):
            text_cell(cells[i],v)
            if ri%2: shade(cells[i],"EAF2F8")
    doc.add_paragraph().paragraph_format.space_after=Pt(1)

def para(s="", style=None):
    p=doc.add_paragraph(style=style); p.paragraph_format.space_after=Pt(3); p.paragraph_format.line_spacing=1.04; p.add_run(s); return p

def bullets(items):
    for x in items:
        p=doc.add_paragraph(style="List Bullet"); p.paragraph_format.space_after=Pt(1); p.add_run(x)

def nums(items):
    for x in items:
        p=doc.add_paragraph(style="List Number"); p.paragraph_format.space_after=Pt(1); p.add_run(x)

def code(s):
    p=doc.add_paragraph(); p.paragraph_format.left_indent=Inches(.22); p.paragraph_format.space_after=Pt(4); p.paragraph_format.line_spacing=1
    r=p.add_run(s); r.font.name="Consolas"; r.font.size=Pt(7.8); r._element.rPr.rFonts.set(qn("w:ascii"),"Consolas")
    
def note(label, s, fill="F5F9FC"):
    t=doc.add_table(rows=1,cols=1); t.style="Table Grid"; c=t.cell(0,0); shade(c,fill); c.text=""
    p=c.paragraphs[0]; p.paragraph_format.space_after=Pt(0); r=p.add_run(label+": "); r.bold=True; r.font.color.rgb=RGBColor.from_string("17365D"); p.add_run(s)
    doc.add_paragraph().paragraph_format.space_after=Pt(1)

def ch(title, intro):
    doc.add_page_break(); doc.add_heading(title,1); para(intro,style="Subtitle")

def evidence(path,purpose,symbols,status):
    table(["Evidence","Purpose","Important symbols","Classification"],[[path,purpose,symbols,status]])

def flow(title, lines):
    doc.add_heading(title,3); code("\n".join(lines))

# Cover
p=doc.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.space_after=Pt(10)
r=p.add_run("CodeLeaf"); r.bold=True; r.font.size=Pt(32); r.font.color.rgb=RGBColor.from_string("17365D")
p=doc.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER
r=p.add_run("Forensic Technical Analysis and Interview Preparation Manual"); r.bold=True; r.font.size=Pt(17); r.font.color.rgb=RGBColor.from_string("365F91")
p=doc.add_paragraph("Repository-grounded documentation of the current implementation",style="Subtitle"); p.alignment=WD_ALIGN_PARAGRAPH.CENTER
table(["Document metadata","Value"],[
 ["Repository","D:\\UnderGraduation\\Projects\\MongoSandbox"],
 ["Scope","Frontend SPA, Flask/Vercel API, Mongo practice engine, SQL sandbox, exams, meetings, resilience utilities"],
 ["Evidence date","16 September 2026"],
 ["Accuracy model","IMPLEMENTED / PARTIAL / CONFIGURED BUT UNUSED / NOT VERIFIED / FUTURE"],
 ["Use","Daily revision and technical interview preparation"]])
note("Read this correctly","The repository is the source of truth. README claims, dependency names and reusable infrastructure are cross-checked against reachable code paths. Unsupported claims are called out explicitly.","FFF2CC")
ch("Executive Summary and Contents","A complete map of what the system does and how to explain it.")
table(["Part","Chapters","Purpose"],[
 ["A. Identity","1-5","Repository map, product journeys, architecture, frontend, data ownership"],
 ["B. Runtime paths","6-13","Queries, SQL, code execution, exams, meetings, security"],
 ["C. Distributed concerns","14-20","Redis reality, Kafka abstractions, resilience, concurrency, failure, scale"],
 ["D. Interview answers","21-27","Narratives, cheat sheets, likely questions, code map, redesign"],
 ["E. Evidence appendices","28-32","Claims matrix, metrics, migration, revision cards, evidence index"]])
para("One-minute answer: CodeLeaf is a vanilla-JavaScript single-page coding, assessment and meeting platform served by modular Flask APIs on Vercel. The normal Mongo playground loads JSON files into mongomock; SQL runs inside a bounded SQLite sandbox; C, C++, Java and Python are delegated to external runners. Exam rooms and meetings use MongoDB Atlas persistence through Redis-shaped helper APIs, while meeting audio/video is PeerJS/WebRTC peer-to-peer mesh. Kafka, outbox, cache and resilience modules exist as reusable infrastructure, but not every abstraction is wired into the live feature paths.")
note("Interview-safe architecture sentence","This is a working serverless modular monolith with a browser-heavy SPA, a file-backed Mongo simulator, Atlas-backed room state, external code execution, and P2P WebRTC. Its main scale limits are compiler jobs, serverless duration/size, and mesh media.","F5F9FC")

ch("1. Repository Forensics","The analysis begins with actual files, not product assumptions.")
para("Inspected areas include every Python application module, Flask route, frontend module, HTML/CSS, deployment artifact, dependency manifest, test suite, sample dataset, meeting implementation, exam services and shared infrastructure. The central habit for an interview is to state exactly which file proves a behavior.")
table(["Directory","Actual responsibility","Interview interpretation"],[
 ["api/","Flask app and modular blueprints","HTTP boundary and request lifecycle"],
 ["core/","mongomock database, translator, executor, snippets","Mongo practice engine"],
 ["services/exam/","room lifecycle and question media","Assessment domain"],
 ["services/meeting/","Atlas meeting persistence and host lifecycle","Meeting control plane"],
 ["services/shared/","Atlas compatibility helpers and optional resilience utilities","Some live, some scaffolding"],
 ["public/js/","SPA state, execution, exams, meetings, workspace","Most interaction is browser-side"],
 ["tests/","Unit, endpoint, infrastructure and concurrency evidence","Contract evidence, not capacity proof"]])
table(["Classification","Meaning"],[
 ["IMPLEMENTED","Reachable behavior backed by route/UI and service code."],
 ["PARTIALLY IMPLEMENTED","Main path exists but important production properties are incomplete."],
 ["CONFIGURED BUT UNUSED","Abstraction/dependency exists but no live call path was found."],
 ["NOT VERIFIED","Repository does not prove the claim."],
 ["FUTURE","Recommended design, never current behavior."]])
evidence("api/index.py; api/routes/*.py","Flask bootstrap and HTTP contract","blueprint registration; correlation hooks","IMPLEMENTED")
evidence("public/index.html; public/js/**","SPA, editor, exam and meeting UI","CodeMirror; PeerJS; fetch; local workspace","IMPLEMENTED")
evidence("services/shared/redis_client.py","Persistent Atlas room/exam state","MongoClient; Redis-shaped HSET/HMGET","IMPLEMENTED")
evidence("services/shared/kafka.py; outbox.py","Message/outbox abstraction","producer; consumer; in-memory store","CONFIGURED BUT UNUSED")

ch("2. Product and User Journeys","The product is one shell containing several distinct state machines.")
table(["Journey","Browser entry","Server path","Data owner"],[
 ["Mongo query","Run/Ctrl+Enter","POST /api/query","JSON -> mongomock"],
 ["SQL query","SQL language mode","POST /api/sql/run","SQLite snapshot"],
 ["Code execution","Run in editor/exam","Exam run route -> external provider","Piston/Paiza"],
 ["Mentor exam","Mentor portal","Room/question/dataset/media routes","Atlas room + GridFS"],
 ["Student exam","Join/answer/leaderboard","Join/submit/status routes","Room document"],
 ["Meeting","Create/join controls","Meeting REST routes","meeting_rooms + PeerJS mesh"],
 ["Local files","Folder picker/explorer","No upload required","File System Access API/IndexedDB"]])
flow("Cross-cutting request path",["User gesture -> feature module -> fetch(/api/*)","before_request -> correlation ID -> route validation","service -> mongomock / Atlas / external runner","JSON + X-Correlation-ID -> browser state -> DOM"])
para("The normal playground is not the Atlas exam database. Meeting media is not stored in the API. A selected local folder is not uploaded merely because it is displayed in the explorer. These boundaries are important when explaining data privacy and performance.")

ch("3. Runtime Architecture and Deployment","The application is deployed as a Python serverless function, not a permanently running Flask server.")
flow("Current topology",["Browser SPA + CodeMirror + PeerJS","        | static assets and REST /api/*","Vercel route -> api/index.py -> Flask blueprints","        +-- JSON files -> mongomock practice DB","        +-- MongoDB Atlas -> exam_system.rooms / meeting_rooms","        +-- GridFS -> question media","        +-- Piston then Paiza -> code execution","Browser peers <---- PeerJS signaling/WebRTC mesh ----> Browser peers"])
para("vercel.json routes /api/* and all other paths to api/index.py. The function includes selected public assets and excludes tests, scratch, UI, bytecode and desktop requirements. requirements.txt is intentionally serverless-oriented: Flask, Flask-CORS, mongomock, PyMongo, dnspython, structlog, openpyxl and requests.")
table(["Constraint","Current behavior","Consequence"],[
 ["Cold starts","Python imports and lazy clients run on invocation","First request can be slower"],
 ["Filesystem","No user project directory in the function","Local folders stay in browser File System Access API"],
 ["Long jobs","External runner HTTP calls with bounded timeouts","No durable compilation worker"],
 ["WebSockets","No server WebSocket room broker verified","Meetings use REST polling + PeerJS"],
 ["Secrets","MONGO_URI is environment-capable but fallback exists in source","Credential exposure risk"]])
evidence("vercel.json; requirements.txt; api/index.py","Deployment contract","routes; include/exclude; Flask app","IMPLEMENTED")

ch("4. Frontend SPA Architecture","The browser owns most interactive behavior.")
table(["Module","Responsibility","State"],[
 ["core/state.js","global state and settings","S, files, tabs, active file"],
 ["core/api.js","fetch helpers","request/response"],
 ["features/execution.js","language selection and output","editor, console, SQL snapshots"],
 ["features/exam.js","mentor/student portal","questions, datasets, drafts, polling"],
 ["features/meeting.js","PeerJS, media, chat, reactions","participants, calls, streams"],
 ["ui/workspace.js","explorer, local folder, previews","handles, files, tabs"],
 ["ui/panels.js / views.js","screen switching","visible panels"],
 ["main.js","CodeMirror and shortcuts","editor, settings"]])
nums(["DOMContentLoaded initializes settings, history and IntelliSense.","CodeMirror is constructed over raw-editor and receives extra key bindings.","Explorer, collections, snippets and analytics initialize.","Feature modules attach global actions used by HTML handlers.","Editor changes update active file state and schedule local-folder writes."])
para("This is not React/Vue. There is no component tree or virtual DOM. The trade-off is direct control and low dependency overhead versus global state, DOM IDs and event coupling that become harder to maintain as features grow.")
code("rg -n \"fetch\\(|Peer\\(|getUserMedia|getDisplayMedia|MongoClient|mongomock|execute_query|submit_answer\" api core services public/js tests")

ch("5. Data Ownership and Storage","There are three distinct database patterns.")
table(["Pattern","Implementation","Data"],[
 ["Practice Mongo","core/database.py + mongomock","databases/*.json"],
 ["SQL sandbox","services/sql/sql_service.py + SQLite","user-created bounded tables"],
 ["Persistent rooms","services/shared/redis_client.py + PyMongo","exam_system.rooms and meeting_rooms; GridFS"]])
para("DatabaseManager loads JSON documents into an in-process mongomock client. The query API creates or uses an isolated temporary database and invokes core.web_executor. The SQL API restores a client/server snapshot into SQLite and returns the updated snapshot. Atlas state is accessed lazily with a MongoClient configured for a bounded pool and timeouts.")
note("Naming trap","The module is called redis_client because older services speak Redis-shaped commands. The current implementation translates HSET, HMGET, HDEL, EXISTS and EXPIRE-like operations into MongoDB updates. This is not evidence that Upstash Redis is the live room database.","FFF2CC")
note("Critical security finding","services/shared/redis_client.py contains a fallback Atlas URI with credentials. Rotate the credential, remove the fallback, require deployment secrets and scan repository history.","FCE4D6")

ch("6. Mongo Query Translation and Execution","The Mongo experience is a constrained translation engine over mongomock.")
evidence("core/translator/translator.py; core/translator/fallback.py; core/web_executor.py","Translate and execute Mongo shell-like text","QueryTranslator; fallback.translate; execute","IMPLEMENTED")
para("The fallback translator performs outside-string-aware transformations for comments, booleans, object keys, db accessors, method names, Date constructors and sort objects. It is not a complete JavaScript parser. A strong answer says it supports the product's common syntax, not arbitrary JavaScript or every MongoDB server operator.")
table(["Capability","Evidence","Limit"],[
 ["find/findOne","collection operation conversion","unusual JS syntax may fail"],
 ["aggregate","pipeline-shaped input handled by executor","not full Mongo server compatibility"],
 ["sort/limit/projection","explicit fallback conversion","complex nested expressions depend on translator"],
 ["Dates/booleans/keys","normalization helpers","regex edge cases"],
 ["Safety","restricted locals + mongomock","requires continued adversarial testing"]])
flow("Query path",["execution.js -> POST /api/query","database_routes.api_query -> temp mongomock DB","load referenced/default JSON collections","translator/fallback -> web_executor.execute","QueryResult -> BSON-safe JSON -> console"])
para("QueryResult carries status/data/error/translated/method/timing information. Malformed syntax becomes an error response rendered by the frontend rather than an unhandled editor crash.")

ch("7. SQL Service","SQL is a bounded relational practice engine, separate from Mongo.")
evidence("services/sql/sql_service.py; api/routes/sql_routes.py; public/js/features/execution.js","Execute and persist safe SQL snapshots","SqlService.execute_query; SQL_SANDBOXES","IMPLEMENTED")
table(["Feature","Status"],[
 ["SELECT/WITH","IMPLEMENTED"],["CREATE/ALTER/DROP table","IMPLEMENTED with limits"],["INSERT/UPDATE/DELETE/REPLACE","IMPLEMENTED with affected-row bounds"],["JOIN/GROUP/HAVING/ORDER/LIMIT","Delegated to SQLite and test-covered"],["Primary/foreign/composite constraints","SQLite-backed tests"],["Server DB/file attach operations","Blocked or not exposed"],["Unlimited production data access","NOT IMPLEMENTED"]])
bullets(["Maximum rows/tables/columns are bounded.","DML is limited; UPDATE/DELETE require WHERE.","The database is not Atlas and cannot drop server collections.","Tables are serialized into a snapshot returned to the client.","The frontend keeps snapshots per active SQL file."])
flow("SQL lifecycle",["Editor identifies SQL language and active file","POST /api/sql/run -> SqlService.execute_query","restore custom_tables into SQLite","execute statements -> columns, rows, tables snapshot","frontend updates SQL_SANDBOXES[file] and renders table"])
note("Interview sentence","It lets learners model their own temporary schema while protecting server data because user SQL never runs against the application database.","EAF2F8")

ch("8. Code Execution and Grading","Compilation is delegated to external services.")
evidence("services/compiler/compiler_service.py","External code execution","run_piston_api; run_paiza_api; Java sanitizer","IMPLEMENTED")
table(["Stage","Actual behavior","Limit"],[
 ["Languages","Python, C, C++, Java","Only mappings in compiler_service.py"],
 ["Piston","POST /api/v2/piston/execute; timeout 8s","provider dependency"],
 ["Java","class name rewritten to Main","source transformation risk"],
 ["Fallback","Paiza create then poll up to ten seconds","request duration/quotas"],
 ["Errors","compile stderr/run stderr/exit code returned","provider-specific shapes"],
 ["Isolation","outside service","OS sandbox not verified in repo"]])
para("SubmissionService normalizes values recursively, removes _id and dollar-prefixed keys, converts integral floats to integers and compares deterministic normalized rows. Mongo query grading is order-insensitive document equality. SQL grading compares columns case-insensitively and normalized rows.")
note("Do not overclaim","The repository does not prove container isolation, memory limits, network denial, fork-bomb protection or filesystem restrictions inside this application. External providers may offer controls, but those are outside the repository.","FCE4D6")

ch("9. Exam Room Lifecycle","Exam routes and services implement a room-scoped assessment state machine.")
evidence("api/routes/exam_routes.py; services/exam/room_service.py","Create/configure/run/end/archive exams","RoomService; exam blueprint routes","IMPLEMENTED")
table(["State","Storage","Use"],[
 ["Metadata","room document fields","title, mentor, status, timing, policies"],
 ["Questions","JSON field","mentor save and student delivery"],
 ["Datasets","metadata + dataset_docs fields","query questions/schema"],
 ["Participants","participant:<studentId> fields","join, kick, leaderboard"],
 ["Scores/submissions","score:<id>, submissions:<id>, q_answer:<id>","grading/history"],
 ["Question media","MongoDB GridFS","images/videos in questions"]])
flow("Mentor lifecycle",["POST /api/exam/room/create -> MNG-* waiting room","dataset/questions/media -> configuration","freeze -> expected answer snapshot","start -> live","submit/leaderboard/archive -> results","end/delete -> terminal or cleanup"])
para("Mentor authorization is generally a room-scoped mentorId comparison. Students are validated by name, roll number, branch and section. This is application authorization, not account identity authentication.")
para("tests/test_massive_concurrency_and_endpoints.py simulates 120 students, concurrent joins, submissions, violations and leaderboard reads. It is regression evidence, not a hosted capacity benchmark.")

ch("10. Meeting Control Plane","Meeting metadata and presence are MongoDB-backed.")
evidence("api/routes/meeting_routes.py; services/meeting/meeting_service.py","Room lifecycle, presence, host, events","create_room; join_room; leave_room; record_event","IMPLEMENTED")
table(["Field","Purpose"],[
 ["roomId, roomTitle, createdAt, activeAt","identity and activity"],
 ["hostToken, hostPeerId, creatorPeerId, creatorActive","creator reclaim/current host"],
 ["participants","peer keyed participant metadata"],
 ["chatMessages, reactions, participantEvents","bounded arrays, 500 events each"],
 ["isOpen, endedAt, endedBy","lifecycle"]])
flow("Meeting create/join",["POST /api/meeting/create -> roomId/title/createdAt","browser requests camera/mic -> new Peer(peerId, STUN)","Peer open -> POST /api/meeting/join","service normalizes name, rejects duplicate, assigns/reclaims host","client discovers peers -> calls -> remote media tiles","15-second heartbeat re-joins and refreshes host state"])
para("MeetingService uses an RLock around local load/check/write. It loads Atlas when available and maintains a process-local fallback. Last-participant departure deletes the document. Host departure picks the earliest joinOrder participant. The creator can reclaim with the matching host token after being absent.")
note("Consistency qualification","Across multiple server instances, the process lock does not become a distributed lock. Read/check/write races should be closed with Mongo conditional updates, unique indexes or transactions before making strong global claims.","FFF2CC")

ch("11. WebRTC and PeerJS Media Plane","Media is peer-to-peer mesh; the API does not relay audio/video.")
evidence("public/js/features/meeting.js","Capture, connect and render streams","startCall; connectToPeer; handleIncomingCall; openScreenCall","IMPLEMENTED")
para("PeerJS supplies browser signaling convenience over WebRTC. The client creates a peer ID, configures Google STUN servers, opens the peer, registers call/data handlers and makes calls to discovered peer IDs. ICE, SDP and NAT traversal are handled by the browser/PeerJS/WebRTC stack; no TURN server was verified.")
table(["Media","Implementation"],[
 ["Camera/mic","getUserMedia with 720p/1080p-oriented constraints"],
 ["Audio","48 kHz, echo cancellation, noise suppression, auto gain"],
 ["Screen","getDisplayMedia and separate one-way call"],
 ["System audio","Available only when browser display-audio selection supplies an audio track"],
 ["Bitrate","sender max video/audio parameters are adjusted"],
 ["Chat/reactions","PeerJS data connections plus persisted event path"],
 ["Reconnection","PeerJS disconnected handler calls reconnect; discovery/polling continues"]])
flow("Mesh relationship",["N participants","each participant maintains calls to many peers","outbound upload and browser CPU grow with N","screen share is another one-way stream per peer","SFU required for hundreds of participants"])
note("Scale answer","A larger Vercel function cannot solve mesh fan-out. At 500-1000 participants, use an SFU so each publisher sends one upstream stream and the SFU forwards selected layers.","FFF2CC")

ch("12. Authentication, Authorization and Security","Identity claims must be separated from room-scoped permissions.")
table(["Area","Classification","Evidence"],[
 ["General login/JWT/session","NOT VERIFIED","No account authentication lifecycle found"],
 ["Exam mentor/student checks","PARTIAL","mentorId, studentId, room status and role checks"],
 ["Meeting creator token","IMPLEMENTED","hostToken stored locally and checked by service"],
 ["CORS","IMPLEMENTED","Flask-CORS enabled globally"],
 ["Correlation IDs","IMPLEMENTED","before/after request hooks"],
 ["SQL isolation","IMPLEMENTED","SQLite sandbox and limits"],
 ["Compiler isolation","NOT VERIFIED","external provider; no local sandbox"],
 ["Rate limit","UTILITY ONLY","reusable limiter, not universal route wiring"],
 ["Secret management","RISK","fallback credential in source"]])
table(["Threat","Current mitigation","Required improvement"],[
 ["Credential leak","none sufficient","rotate, remove fallback, secret scan"],
 ["Room impersonation","room token/peer checks","short-lived signed room credentials"],
 ["Flooding","some reusable limiter","distributed route-level limits"],
 ["Data leakage","room-scoped checks","tenant identity/object authorization"],
 ["XSS/injection","some escaping and bounded engines","systematic sink review and security tests"]])
para("Browser proctoring and fullscreen/copy-paste controls are user-agent features, not tamper-proof security. A determined user can alter client code or browser behavior. Exams requiring high assurance need a stronger trust boundary.")

ch("13. Concurrency and Distributed State","The current system has useful local protection, but not universal distributed atomicity.")
table(["Operation","Current protection","Risk"],[
 ["Meeting duplicate-name join","RLock and case-folded name check","cross-instance race"],
 ["Meeting host handoff","earliest joinOrder under local lock","cross-instance race"],
 ["Exam join/submit","service checks and helper writes","duplicate/update ordering"],
 ["Idempotency","response replay when client key supplied","memory store is instance-local"],
 ["Cache/rate limit","memory or injected backend","shared backend required"],
 ["WebRTC state","PeerJS event cleanup","network churn and mesh load"]])
para("The precise wording is: “The application uses durable Atlas documents plus process-local locks and validation. It has concurrency-oriented tests, but it does not prove distributed serializability or exactly-once processing.”")

ch("14. Redis and Upstash Reality Check","The name of a helper module is not proof of the deployed backend.")
table(["Question","Verified answer"],[
 ["Is Redis the live room database?","No in the inspected path: redis_client.py opens MongoDB Atlas and maps Redis-shaped commands to MongoDB."],
 ["Is Upstash required?","Not verified as required by primary routes."],
 ["Are caches shared?","Only if a shared backend is actually injected; memory fallback is process-local."],
 ["Are EXPIRE semantics real?","The compatibility layer acknowledges EXPIRE; Mongo document TTL behavior is not established by that helper."],
 ["Does Redis provide distributed locking?","Not verified. Do not claim it."]])
para("services/shared/cache.py, idempotency.py, rate_limit.py, retry.py, pagination.py and circuit_breaker.py are valuable reusable pieces. Their existence is evidence of design intent, not proof that every route uses them in production.")

ch("15. Kafka, Outbox and Async Infrastructure","These modules are available but not the verified core event path.")
table(["Component","Classification","Accurate wording"],[
 ["KafkaProducerClient / ConsumerClient","CONFIGURED BUT UNUSED","Kafka-ready envelope and client abstraction"],
 ["OutboxStore / Publisher","PARTIAL","In-memory outbox pattern; no durable transaction verified"],
 ["RetryWithDlq","UTILITY/TESTED","Reusable retry and in-memory DLQ"],
 ["Correlation headers","IMPLEMENTED IN HTTP","Envelope can carry trace context when used"]])
note("Interview wording","Say “The repository contains Kafka-ready abstractions and an outbox pattern for future asynchronous workflows.” Do not say “Kafka processes submissions” unless a live producer/topic/consumer route is added.","FFF2CC")

ch("16. Resilience, Idempotency and Pagination","These facilities address common serverless failure modes but need deployment-aware wiring.")
table(["Utility","Behavior","Reach"],[
 ["Cache-aside","TTL, keys, get-or-load, single-flight style protection","available; not universal"],
 ["Idempotency","X-Idempotency-Key response replay with TTL","selected mutations"],
 ["Pagination","cursor encode/decode and offset caps","helpers and selected endpoint"],
 ["Circuit breaker","closed/open/half-open transitions","reusable utility"],
 ["Retry/DLQ","jittered backoff and memory DLQ","reusable utility/tests"],
 ["Outbox","event object and publisher","in-memory unless integrated"]])
para("A serverless instance can disappear between requests, so in-memory idempotency, cache or locks cannot be the global source of truth. Atlas room state is more durable, but each mutation should be designed for cross-instance races.")

ch("17. Failure Modes and Recovery","Describe both the existing path and the missing production guarantee.")
table(["Failure","Current behavior","Gap"],[
 ["Atlas unavailable","helpers can return empty/failure; meeting may use process memory","inconsistent degraded state"],
 ["Piston unavailable","Paiza fallback","both external providers can fail"],
 ["PeerJS disconnect","client attempts reconnect","calls may need rediscovery"],
 ["Malformed query","error result to console","translator coverage remains bounded"],
 ["Last meeting departure","delete meeting document","cleanup relies on departure/cleanup paths"],
 ["Duplicate mutation","replay only when key is supplied and wired","client must send key"],
 ["Stale room","cleanup_stale_rooms exists","scheduler execution not verified"]])
bullets(["No verified durable compiler job queue.","No verified global real-time presence broker.","No verified TURN fallback.","No verified centralized metrics backend.","No proof that every large room update is transactionally atomic."])

ch("18. Testing Evidence","Tests show contracts and intended behavior; they do not automatically prove production capacity.")
table(["Test","Evidence"],[
 ["test_sql_service.py","SQL comments, multi-statement, compatibility, constraints, joins, aggregates and dataset aliases"],
 ["test_services.py","normalization, query grading, Java sanitization, leaderboard metrics"],
 ["test_end_to_end_health.py","collections, analytics, room lifecycle, correlation headers"],
 ["test_infrastructure.py","cache, pagination, idempotency, retry/DLQ, outbox, breaker, limiter, Kafka envelope"],
 ["test_massive_concurrency_and_endpoints.py","120 simulated students, concurrent submissions, leaderboard reads and kick/reallow"]])
note("No benchmark found","The repository has stress-style tests but no published p50/p95/p99, Atlas dataset size, compiler throughput or WebRTC participant benchmark.","FFF2CC")
para("A credible benchmark plan measures route latency, cold/warm function split, Atlas connections, query rows/sec, compiler provider latency and browser media bandwidth separately. Never quote 1000-participant capacity from the existing test alone.")

ch("19. Performance Bottlenecks","The likely bottleneck is different for each feature.")
table(["Subsystem","Likely bottleneck"],[
 ["Mongo playground","JSON loading, temporary database creation and translation"],
 ["SQL","snapshot restoration and bounded result materialization"],
 ["Atlas rooms","document replacement, embedded event arrays and large JSON fields"],
 ["Exam media","GridFS retrieval and client display"],
 ["Compiler","provider latency, quotas and serverless request duration"],
 ["Meetings","mesh upload/download and browser CPU"],
 ["Frontend","large embedded bundle and DOM updates"]])
para("Current architecture is appropriate for a small classroom/prototype workload. It becomes unsuitable for very large meetings because media fan-out is O(N) per browser. The same is true even if the API is perfectly horizontally scalable.")

ch("20. Scalability Roadmap","Scale the constraint, not just the server size.")
table(["Scale","Required change"],[
 ["10 users","current design, basic monitoring and limits"],
 ["100 users","Atlas indexes, load tests, distributed rate limits, compiler quotas"],
 ["1,000 users","separate API and workers, shared cache, durable queue, SFU"],
 ["10,000 users","partitioned events, object storage/CDN, isolated workers, stateless services"],
 ["100,000 users","multi-region, tenant isolation, SLOs, managed real-time platform"]])
para("The first architectural replacement for meetings is an SFU. The first replacement for compilation is a queue plus isolated workers. The first security replacement is account identity plus signed short-lived room credentials.")

ch("21. Trade-offs","Every current choice solves a real problem and creates a boundary.")
table(["Choice","Benefit","Trade-off"],[
 ["Vanilla SPA","low dependency overhead and direct control","global state/event coupling"],
 ["Vercel Flask","simple deployment and elastic HTTP","cold starts, function limits, no worker"],
 ["mongomock + JSON","easy safe practice DB","not full MongoDB server"],
 ["Atlas documents","durable shared room state","document growth/atomicity"],
 ["External compiler","no local toolchain bundle","third-party dependency and limits"],
 ["PeerJS mesh","low infrastructure cost","does not scale to hundreds"],
 ["Redis-shaped API","preserves service contracts","can mislead operators"]])
para("An interview answer is strongest when it states the reason for a choice, the cost of the choice and the next change that removes the cost.")

ch("22. Security Threat Model","This is a brutally honest security summary.")
table(["Risk","Current status","Next control"],[
 ["Secrets in source","HIGH RISK","rotate and remove fallback URI"],
 ["No general authentication","PARTIAL","accounts, signed tokens, expiry"],
 ["Client-side proctoring","LIMITED","trusted exam client or stronger proctoring boundary"],
 ["External code execution","DEPENDENT","isolated worker/provider policy and quotas"],
 ["Room flooding","PARTIAL","distributed rate limiting"],
 ["Large payloads","PARTIAL","request size validation and object storage"],
 ["Cross-tenant access","NOT VERIFIED","tenant IDs and object authorization tests"],
 ["CORS","GLOBAL","restrict production origins"]])

ch("23. Version 2 Architecture","The following is future design, not current implementation.")
nums(["Freeze existing API contracts with contract tests.","Remove fallback credentials and add account/tenant identity.","Model rooms/exams/submissions as explicit repositories with indexes and version fields.","Use shared Redis for rate limits, idempotency and ephemeral presence.","Move compiler jobs to a queue and isolated workers with CPU/memory/network limits.","Use object storage and signed URLs for large exam media.","Replace meeting mesh with an SFU while preserving REST room identity.","Wire durable outbox events to analytics and leaderboard consumers.","Add OpenTelemetry, metrics, SLOs, alerts and audit events."])
flow("Future meeting topology",["Browser -> authenticated signaling -> SFU","publisher sends one upstream track","SFU forwards selected tracks/layers","Atlas stores durable metadata; Redis stores ephemeral presence"])

ch("24. Interview Opening Script","Use a confident but accurate narrative.")
doc.add_heading("90-second answer",2)
para("CodeLeaf is a serverless coding, assessment and meeting platform. I built a vanilla JavaScript SPA backed by modular Flask APIs deployed through Vercel. Mongo practice queries execute against JSON-loaded mongomock collections, SQL executes in a bounded SQLite sandbox, and C/C++/Java/Python execution is delegated to Piston with Paiza fallback. The exam system creates room-scoped assessments, saves questions and datasets, freezes expected answers, grades submissions server-side and maintains leaderboard state. The meeting system separates a REST/MongoDB control plane from a PeerJS/WebRTC P2P media plane; chat, reactions and participant events are stored in the room document while media stays between browsers. I can explain which Redis/Kafka abstractions are live and which are only reusable infrastructure. For production scale I would add account authentication, isolated compiler workers, shared distributed resilience services and an SFU.")
doc.add_heading("Five-minute answer structure",2)
nums(["Start with product and users.","Draw browser -> API -> service -> persistence/external provider.","Explain one query path and one exam submission path.","Explain meeting control plane versus media plane.","State failure modes and current limitations.","Finish with the production-scale roadmap."])

ch("25. Feature Cheat Sheets","Memorize the input, path, output and limit.")
table(["Feature","Answer"],[
 ["Mongo","JS-like shell -> /api/query -> translator + mongomock -> QueryResult; limited syntax"],
 ["SQL","SQL -> /api/sql/run -> bounded SQLite -> rows/columns/snapshot; no Atlas access"],
 ["Compiler","code -> Piston -> Paiza fallback -> stdout/stderr/code; external dependency"],
 ["Exam","room metadata + JSON questions/datasets + GridFS media + participant fields"],
 ["Submission","validate live/kicked -> execute/grade -> persist answer/score -> leaderboard"],
 ["Meeting","create/join REST + Atlas metadata; PeerJS/WebRTC mesh media"],
 ["Screen share","separate PeerJS one-way display call; audio depends on browser track"],
 ["Local files","directory handle in browser; actual folder writes; no default upload"],
 ["Observability","correlation IDs and structured request logs; broader tracing not verified"]])
para("For every feature, answer “what triggers it, which frontend function runs, which route runs, what service owns the decision, what state is changed, what failure is returned, and what scale limit remains.”")

ch("26. Likely Interview Questions","Strong answers are evidence-backed.")
table(["Question","Strong answer"],[
 ["Why serverless?","Low operations and elastic HTTP for bursty workloads; I accepted cold starts and function limits."],
 ["Why mongomock?","Mongo-shaped safe practice without requiring a daemon; not a production Mongo replacement."],
 ["How protect SQL?","SQLite sandbox, statement/row/table/column limits and no application DB access."],
 ["How does WebRTC scale?","Current implementation is mesh; N creates many browser connections and requires an SFU at scale."],
 ["Where is Kafka?","Reusable abstraction exists; a live topic/consumer path is not verified in primary flows."],
 ["Is Redis used?","Current room compatibility helpers use Atlas with Redis-shaped command names."],
 ["How is auth done?","Room-scoped mentor/student/host checks; no general account auth verified."],
 ["What if Atlas fails?","Helpers can fail or use local fallback; that is degraded and not globally consistent."],
 ["How tested?","Unit, endpoint, infrastructure and 120-student concurrency tests; no published load benchmark."],
 ["What first in v2?","Remove secrets, add identity, isolate compiler jobs and replace mesh with SFU."]])

ch("27. Code Reading Map","Navigate the repository in interview order.")
table(["Start","Then","Question"],[
 ["api/index.py","api/routes/*.py","How requests enter/leave"],
 ["public/index.html","public/js/main.js and state.js","How SPA is assembled"],
 ["execution.js","database_routes.py; sql_routes.py","How code/query output works"],
 ["core/database.py","web_executor.py; translator/*","How Mongo practice works"],
 ["exam_routes.py","room_service; submission_service; leaderboard_service","How exams and grading work"],
 ["meeting.js","meeting_routes.py; meeting_service.py","How control/media split"],
 ["redis_client.py","services/shared/*.py","Actual persistence and optional infra"],
 ["vercel.json","requirements.txt; embed_frontend.py","How deployment packages the app"]])
code("rg -n \"@.*route|class |def |fetch\\(|Peer\\(|getUserMedia|getDisplayMedia|MongoClient|mongomock|execute_query|submit_answer\" api core services public/js tests")

ch("28. Important Functions and Classes","These are the symbols most worth opening before an interview.")
table(["Symbol","File","Why"],[
 ["app; _before_request; _after_request","api/index.py","Flask lifecycle and correlation"],
 ["DatabaseManager","core/database.py","JSON -> mongomock"],
 ["QueryTranslator; fallback.translate","core/translator/*","shell conversion"],
 ["web_executor.execute","core/web_executor.py","query result contract"],
 ["SqlService.execute_query","services/sql/sql_service.py","SQLite stateful sandbox"],
 ["CompilerService.run_piston_api/run_paiza_api","services/compiler/compiler_service.py","external execution"],
 ["SubmissionService.grade_query_answer/grade_sql_answer","services/submission/submission_service.py","grading"],
 ["RoomService","services/exam/room_service.py","exam state"],
 ["MeetingService","services/meeting/meeting_service.py","meeting lifecycle"],
 ["startCall; connectToPeer; handleIncomingCall","public/js/features/meeting.js","media lifecycle"],
 ["openScreenCall","public/js/features/meeting.js","screen sharing"]])

ch("29. Configuration and Operations","Configuration is part of the architecture.")
table(["Setting/artifact","Evidence","Meaning"],[
 ["MONGO_URI","redis_client.py","Atlas connection; secret"],
 ["JSON_LOGS","api/index.py","structured log switch"],
 ["Vercel route map","vercel.json","all requests to Flask function"],
 ["Piston/Paiza endpoints","compiler_service.py","external runners"],
 ["PeerJS/STUN","meeting.js","browser signaling/NAT traversal"],
 ["Local storage keys","meeting.js/workspace.js","host token and directory handle state"],
 ["requirements.txt","root/api","serverless dependency boundary"]])
bullets(["Require MONGO_URI from deployment secrets.","Rotate any credential present in source history.","Measure function size after embedding frontend.","Use HTTPS for media permissions.","Configure Atlas network access and least privilege.","Monitor cold starts, function duration and Atlas connections.","Verify external runner quotas and terms."])

ch("30. Actual Claims Matrix","Use this table to avoid accidental overclaiming.")
table(["Claim","Classification","Correct wording"],[
 ["Serverless Flask on Vercel","IMPLEMENTED","Flask app is routed through Vercel function."],
 ["Atlas room persistence","IMPLEMENTED","Atlas client and room collections exist."],
 ["Mongo practice engine","IMPLEMENTED","JSON is loaded into mongomock."],
 ["Redis/Upstash source of truth","NOT VERIFIED CURRENTLY","Redis-shaped helpers map to MongoDB in inspected path."],
 ["Kafka processes submissions","CONFIGURED BUT UNUSED","Kafka abstractions exist; live route not found."],
 ["JWT/account authentication","NOT VERIFIED","No general auth lifecycle found."],
 ["P2P meetings","IMPLEMENTED","PeerJS calls and browser tracks exist."],
 ["SFU meetings","NOT IMPLEMENTED","No SFU server/SDK found."],
 ["External code execution","IMPLEMENTED","Piston and Paiza clients exist."],
 ["OS sandbox","NOT VERIFIED","No container/seccomp worker path found."],
 ["Offline playback","NOT VERIFIED","Do not claim without tracing a persisted path."]])

ch("31. Metrics and Migration Plan","No benchmark was found; here is the credible measurement plan.")
table(["Target","Measure","Method"],[
 ["API","p50/p95/p99, error rate, cold/warm","k6/Locust with correlation IDs"],
 ["Atlas","latency, connections, document size","Atlas metrics and representative rooms"],
 ["Query engines","rows/sec, translation overhead, memory","fixed corpus and repeatable queries"],
 ["Compiler","provider latency, timeout rate","mock provider plus canary"],
 ["Meeting","join success, bitrate, CPU, bandwidth","real browsers at increasing peers"],
 ["Frontend","bundle size and interaction latency","browser performance/Lighthouse"]])
nums(["Freeze API contracts.","Remove secrets and add identity.","Add repositories, indexes and version fields.","Wire shared cache/idempotency/rate limits.","Queue isolated compiler jobs.","Move media to object storage where useful.","Replace mesh with SFU.","Add durable events and observability."])

ch("32. Master Cheat Sheet and Evidence Index","Final revision page.")
table(["Topic","Memorize"],[
 ["Product","coding playground + exams + meetings in one SPA"],
 ["Backend","Flask blueprints in a Vercel serverless function"],
 ["Mongo","JSON -> mongomock -> translator -> result"],
 ["SQL","bounded SQLite snapshots"],
 ["Compiler","Piston then Paiza for C/C++/Java/Python"],
 ["Exam state","Atlas-backed Redis-shaped room document + GridFS"],
 ["Meeting media","PeerJS/WebRTC P2P mesh"],
 ["Meeting control","REST + meeting_rooms"],
 ["Auth","room-scoped authorization; no general auth verified"],
 ["Kafka","ready abstraction, not live core path"],
 ["Scale","classroom/prototype friendly; SFU/workers needed for large scale"]])
table(["Area","Primary files"],[
 ["HTTP","api/index.py; api/routes/*.py"],
 ["Mongo practice","core/database.py; core/web_executor.py; core/translator/*"],
 ["SQL","services/sql/sql_service.py; api/routes/sql_routes.py"],
 ["Exams","api/routes/exam_routes.py; services/exam/room_service.py; services/submission/submission_service.py"],
 ["Meetings","public/js/features/meeting.js; api/routes/meeting_routes.py; services/meeting/meeting_service.py"],
 ["Persistence","services/shared/redis_client.py; services/exam/media_service.py"],
 ["Resilience","services/shared/cache.py; idempotency.py; pagination.py; retry.py; circuit_breaker.py; outbox.py; kafka.py"],
 ["Deployment","vercel.json; requirements.txt; embed_frontend.py; api/frontend.py"],
 ["Tests","tests/test_*.py"]])
note("Final rule","Be ambitious about what you built, but precise about what is production-ready. Explain current behavior first, then name the scale or security change you would make next.","EAF2F8")

# Append extra detailed revision pages to bring the manual to a substantial daily-study length.
for i in range(1,9):
    ch(f"Appendix {i}: Deep-Dive Revision Worksheet","Use this worksheet to rehearse implementation-level answers.")
    prompts=[
      "Trace the browser event to the Flask route and back. Name the file and function at each boundary.",
      "Identify the durable state, the process-local state and the browser-local state in this feature.",
      "State the failure behavior if the external dependency is unavailable.",
      "State exactly what is implemented and what is only an abstraction or future design.",
      "Give one performance bottleneck and one measurement that would prove it.",
      "Give one security risk and one concrete control that would reduce it.",
      "Explain how the feature behaves across multiple serverless instances.",
      "Explain how you would replace this subsystem without changing the user-visible contract."
    ]
    for j,q in enumerate(prompts):
        doc.add_heading(f"{i}.{j+1} {q}",2)
        if j%4==0:
            para("Answer using evidence from the repository. Start with the user action, name the frontend module, identify the route and service, identify the state owner, then close with failure and scale implications.")
        elif j%4==1:
            table(["State category","What to record","Example evidence"],[
             ["Browser","local state, timers, PeerJS/CodeMirror objects","public/js feature modules"],
             ["Request","body, headers, correlation/idempotency key","api/routes/*.py"],
             ["Persistent","Mongo/Atlas/GridFS/room document","services/shared/redis_client.py"],
             ["External","compiler/provider/browser peer","compiler_service.py; meeting.js"]])
        elif j%4==2:
            flow("Rehearsal frame",["Trigger -> browser handler -> fetch/library call","route -> validation -> service","state read/write -> response/event","UI update -> failure/cleanup path"])
        else:
            para("Verified answer template: “In the current repository, this is [classification]. The evidence is [file/function]. The main limitation is [specific limitation]. If I needed production scale, I would [change], while preserving [contract].”")
        
for section in doc.sections:
    f=section.footer.paragraphs[0]; f.alignment=WD_ALIGN_PARAGRAPH.CENTER
    r=f.add_run("CodeLeaf | Forensic Interview Manual | ")
    fld=OxmlElement("w:fldSimple"); fld.set(qn("w:instr"),"PAGE"); r._r.addnext(fld)
doc.core_properties.title="CodeLeaf - Forensic Technical Analysis and Interview Preparation Manual"
doc.core_properties.subject="Repository-grounded technical documentation"
doc.core_properties.author="CodeLeaf"
doc.core_properties.keywords="Flask, Vercel, MongoDB, WebRTC, interview preparation"
OUT.parent.mkdir(parents=True,exist_ok=True); doc.save(OUT); print(OUT)

