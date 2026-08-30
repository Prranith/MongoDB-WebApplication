import os
import sys
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfgen import canvas

# NumberedCanvas for dynamic "Page X of Y" and header/footer rules
class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, page_count):
        # Header (suppressed on page 1)
        if self._pageNumber > 1:
            self.setFont("Helvetica-Bold", 8)
            self.setFillColor(colors.HexColor("#0F766E"))
            self.drawString(54, 750, "Codexa Labs: Technical Architecture & Scaling Brief")
            self.setStrokeColor(colors.HexColor("#E2E8F0"))
            self.setLineWidth(0.5)
            self.line(54, 742, 558, 742)
            
        # Footer
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#64748B"))
        page_text = f"Page {self._pageNumber} of {page_count}"
        self.drawRightString(558, 40, page_text)
        self.drawString(54, 40, "Confidential - For Founder & CEO Only")
        self.setStrokeColor(colors.HexColor("#E2E8F0"))
        self.setLineWidth(0.5)
        self.line(54, 52, 558, 52)


def generate_brief():
    pdf_path = r"c:\Users\swarg\Desktop\MongoSandbox\Codexa_Labs_Technical_Brief.pdf"
    
    # 54 points = 0.75 in margin. Printable width = 612 - 108 = 504 pt. Printable height = 792 - 144 = 648 pt.
    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=letter,
        leftMargin=54,
        rightMargin=54,
        topMargin=72,
        bottomMargin=72
    )

    styles = getSampleStyleSheet()
    
    # Custom Palette Definitions
    primary_color = colors.HexColor('#1E293B')  # Slate
    secondary_color = colors.HexColor('#0F766E') # Teal accent
    text_color = colors.HexColor('#334155')     # Dark grey
    
    # Typography Styles
    title_style = ParagraphStyle(
        'DocTitle',
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=24,
        textColor=colors.white,
        alignment=1
    )
    
    subtitle_style = ParagraphStyle(
        'DocSubTitle',
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=16,
        textColor=colors.HexColor('#E2E8F0'),
        alignment=1
    )
    
    h1_style = ParagraphStyle(
        'Heading1_Custom',
        fontName='Helvetica-Bold',
        fontSize=14,
        leading=18,
        textColor=primary_color,
        spaceBefore=14,
        spaceAfter=6,
        keepWithNext=True
    )
    
    h2_style = ParagraphStyle(
        'Heading2_Custom',
        fontName='Helvetica-Bold',
        fontSize=11,
        leading=15,
        textColor=secondary_color,
        spaceBefore=10,
        spaceAfter=4,
        keepWithNext=True
    )
    
    body_style = ParagraphStyle(
        'Body_Custom',
        fontName='Helvetica',
        fontSize=9.5,
        leading=13.5,
        textColor=text_color,
        spaceAfter=8
    )
    
    bullet_style = ParagraphStyle(
        'Bullet_Custom',
        parent=body_style,
        leftIndent=15,
        firstLineIndent=-10,
        spaceAfter=4
    )
    
    code_style = ParagraphStyle(
        'Code_Custom',
        fontName='Courier',
        fontSize=8,
        leading=11,
        textColor=colors.HexColor('#1E293B'),
        spaceAfter=6
    )

    table_header_style = ParagraphStyle(
        'TableHeader',
        fontName='Helvetica-Bold',
        fontSize=9,
        leading=12,
        textColor=colors.white
    )

    table_body_style = ParagraphStyle(
        'TableBody',
        fontName='Helvetica',
        fontSize=8.5,
        leading=11,
        textColor=text_color
    )

    story = []

    # Utility Functions
    def add_h1(text):
        story.append(Paragraph(text, h1_style))
        story.append(Spacer(1, 4))
        
    def add_h2(text):
        story.append(Paragraph(text, h2_style))
        story.append(Spacer(1, 2))

    def add_p(text):
        story.append(Paragraph(text, body_style))

    def add_bullet(text):
        story.append(Paragraph(f"&bull; {text}", bullet_style))

    def make_callout(text, bg_color='#F1F5F9', border_color='#0F766E'):
        p = Paragraph(text, ParagraphStyle('CalloutText', fontName='Helvetica-Oblique', fontSize=9, leading=13, textColor=primary_color))
        t = Table([[p]], colWidths=[504])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), colors.HexColor(bg_color)),
            ('LEFTPADDING', (0,0), (-1,-1), 12),
            ('RIGHTPADDING', (0,0), (-1,-1), 12),
            ('TOPPADDING', (0,0), (-1,-1), 8),
            ('BOTTOMPADDING', (0,0), (-1,-1), 8),
            ('LINELEFT', (0,0), (0,0), 3, colors.HexColor(border_color)),
        ]))
        story.append(t)
        story.append(Spacer(1, 8))

    # --- PAGE 1: TITLE BLOCK & CORE STORY ---
    # Dark Title Header Block
    title_p = Paragraph("CODEXA LABS:<br/>TECHNICAL ARCHITECTURE & SCALING BRIEF", title_style)
    subtitle_p = Paragraph("Prepared for the Founder & CEO | August 2026", subtitle_style)
    title_table = Table([[title_p], [Spacer(1, 6)], [subtitle_p]], colWidths=[504])
    title_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), primary_color),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 16),
        ('TOPPADDING', (0,0), (-1,-1), 16),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
    ]))
    story.append(title_table)
    story.append(Spacer(1, 15))

    add_h1("1. Executive Summary & Core Story")
    add_p("Codexa Labs is a multi-language coding, database assessment, and proctoring platform. The architecture was engineered iteratively to transition from a localized query practice environment to a high-concurrency multi-tenant exam engine.")
    
    add_h2("Phase 1: The Original Problem (Query Practice)")
    add_p("I noticed there was no lightweight, zero-setup platform allowing developers to practice MongoDB queries against custom or remote datasets. I built Codexa's initial version as a sandboxed web playground where users executed JavaScript-style MongoDB query commands directly against custom JSON schemas, evaluated in-memory on the fly.")

    add_h2("Phase 2: Transition to MongoDB Exam Portal")
    add_p("I then extended this practice platform to accommodate educational assessments. Mentors needed to run structured, secure MongoDB examinations. We introduced room namespaces, student rosters, timers, and real-time score updates to support multi-student testing workflows.")

    add_h2("Phase 3: Multi-Language Compiler Support")
    add_p("I asked: 'If the platform translates and evaluates MongoDB query logic, why restrict it to databases?' I expanded the compiler pipeline to support general-purpose programming languages: C, C++, Java, and Python. We integrated external execution APIs (Piston and Paiza) to run code inside practice files and live exams.")

    add_h2("Phase 4: Full-Scale Assessment & Proctoring System")
    add_p("Codexa today is a comprehensive testing portal combining database aggregations, language compilers, auto-grading, proctoring isolation (fullscreen change logging, copy-paste guards), and full-state event playback for review and auditing.")

    story.append(PageBreak())

    # --- PAGE 2: PRODUCT CAPABILITIES & WORKFLOW ---
    add_h1("2. Product Capabilities & Technical Workflow")
    add_p("Codexa separates operations into two distinct web spaces designed for speed, resilience, and exam security:")

    add_h2("Mentor Workspace Operations")
    add_bullet("<b>Room Namespace:</b> Mentors generate rooms with unique IDs (e.g. <code>MNG-XXX</code> format). The rooms act as sandbox partition namespaces.")
    add_bullet("<b>Question Structuring:</b> Mentors create MCQs, multi-language coding questions, and MongoDB queries. Support for media attachments (images and MP4 video context) is embedded.")
    add_bullet("<b>Zero-Setup Dataset Validation (Expected Output Freezing):</b> For MongoDB questions, the mentor uploads a custom JSON dataset. The system executes the mentor's reference query, captures the query output, and freezes it as the ground-truth expected JSON result (stored under <code>q_answer:&lt;question_id&gt;</code>). Student queries are validated against this frozen output, removing the manual task of writing assertions.")
    add_bullet("<b>Real-Time Proctoring Dashboard:</b> Mentors monitor active participants, connection status, raw code, scores, and proctoring flag logs.")
    add_bullet("<b>Malicious User Handling:</b> Real-time kicks flag students and block re-entry. Kicked states are stored in the database. Mentors can override flags and issue <code>reallow</code> commands if violations are resolved.")
    add_bullet("<b>Roster & Paper Reusability:</b> Mentors can export question papers to JSON files and reload them later, eliminating repeated configuration costs.")

    add_h2("Student Workspace & Auditing")
    add_bullet("<b>In-Browser IDE:</b> CodeMirror instances are loaded inside a custom vanilla JS Single-Page Application (SPA) compiled via <code>embed_frontend.py</code>. Code highlighting and syntax checking are customized for each language.")
    add_bullet("<b>Resiliency & Auto-Save:</b> Student solutions are debounced and auto-saved periodically via HTTP API calls, allowing instant recovery in case of connection loss.")
    add_bullet("<b>Results & Visual Playback:</b> Leaderboards can be exported to Excel sheets. Playbacks log student keystrokes, answers, and proctoring events, allowing mentors to review the complete timeline for marking verification and dispute resolution.")

    story.append(PageBreak())

    # --- PAGE 3: CURRENT ARCHITECTURE & SERVICE DECOUPLING ---
    add_h1("3. Current System Architecture")
    add_p("The current production codebase is deployed as a Serverless Flask API on Vercel, connecting to MongoDB Atlas for persistence.")

    # ASCII Architecture block
    arch_code = (
        "  +-------------------------------------------------------------+\n"
        "  |                   Client Browser (SPA)                      |\n"
        "  |        [CodeMirror]  [Proctoring]  [Dashboard UI]           |\n"
        "  +-------------------------------------------------------------+\n"
        "                                 |\n"
        "                          HTTP REST /api/*\n"
        "                                 v\n"
        "  +-------------------------------------------------------------+\n"
        "  |                  Vercel Serverless Gateway                  |\n"
        "  +-------------------------------------------------------------+\n"
        "                                 |\n"
        "                                 v\n"
        "  +-------------------------------------------------------------+\n"
        "  |                    Flask Serverless API                     |\n"
        "  |             [exam_routes.py]  [database_routes.py]          |\n"
        "  +-------------------------------------------------------------+\n"
        "       |                     |                          |\n"
        "       | Read/Write          | Evaluate Query           | Compile Code\n"
        "       v                     v                          v\n"
        " +-----------------+   +---------------+          +------------------+\n"
        " |  MongoDB Atlas  |   |   mongomock   |          |  Piston & Paiza  |\n"
        " | (State & Room)  |   |  (In-Memory)  |          |  Compiler APIs   |\n"
        " +-----------------+   +---------------+          +------------------+\n"
    )
    
    t_arch = Table([[Paragraph(f"<pre>{arch_code.replace(' ', '&nbsp;').replace('', '')}</pre>", code_style)]], colWidths=[504])
    t_arch.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#F8FAFC')),
        ('BOX', (0,0), (-1,-1), 0.5, colors.HexColor('#E2E8F0')),
        ('PADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(t_arch)
    story.append(Spacer(1, 10))

    add_h2("Domain Isolation & Codebase Structure")
    add_p("The codebase enforces domain-driven service boundaries. Key file paths and their responsibilities include:")
    add_bullet("<b>Routing Layers:</b> <code>api/routes/exam_routes.py</code> processes exam room setups, student submissions, and proctoring endpoints. <code>api/routes/database_routes.py</code> lists collections and executes practice queries.")
    add_bullet("<b>Room Management:</b> <code>services/exam/room_service.py</code> implements room lifecycle states, admitting students, and updating timer configurations.")
    add_bullet("<b>Compiler Services:</b> <code>services/compiler/compiler_service.py</code> coordinates with external APIs (Piston at <code>emkc.org</code> and Paiza at <code>api.paiza.io</code>) for C/C++/Java/Python executions.")
    add_bullet("<b>Proctoring Services:</b> <code>services/proctoring/proctoring_service.py</code> writes proctoring warnings and manages kicked rosters.")
    add_bullet("<b>Session Mapping Facade:</b> <code>services/shared/redis_client.py</code> translates Redis commands (<code>HSET</code>, <code>HGET</code>, etc.) into MongoDB Atlas update statements, allowing the serverless functions to share a consistent session state without actual Redis infrastructure.")

    story.append(PageBreak())

    # --- PAGE 4: TECHNICAL DESIGN DECISIONS ---
    add_h1("4. Key Technical Design Decisions & Trade-Offs")
    add_p("Every architectural element in Codexa was chosen to balance speed of delivery, cost constraints, and system reliability. Below are the five core decisions and their corresponding trade-offs:")

    add_h2("1. Redis Command Facade mapped directly to MongoDB Atlas")
    add_bullet("<b>Decision:</b> Implemented a Redis command simulation layer (<code>redis_client.py</code>) converting HSET/HDEL/EXISTS commands into pymongo updates inside MongoDB Atlas.")
    add_bullet("<b>Why:</b> Avoided complex DNS resolution timeouts (SRV timeouts) common on Vercel Serverless connections to external Redis databases, while reusing existing session-saving syntax.")
    add_bullet("<b>Trade-off:</b> Every session check or status update forces a database roundtrip to MongoDB Atlas. This leads to higher read/write contention and lock queues compared to in-memory Redis keys under heavy student concurrency.")

    add_h2("2. In-Memory Mock Aggregations (mongomock)")
    add_bullet("<b>Decision:</b> Created isolated <code>mongomock.MongoClient</code> database environments inside server threads to execute student MongoDB queries.")
    add_bullet("<b>Why:</b> Provides a safe sandboxed environment. Prevents students from executing malicious commands (like <code>db.dropDatabase()</code>) or reading and editing other students' databases.")
    add_bullet("<b>Trade-off:</b> <code>mongomock</code> does not support 100% of MongoDB's aggregation operators, resulting in validation edge-cases for highly advanced queries.")

    add_h2("3. Third-Party Compiler Integration (Piston + Paiza)")
    add_bullet("<b>Decision:</b> Handed C/C++/Java/Python code execution to public execution services. We run compilation requests inside a concurrent <code>ThreadPoolExecutor</code>.")
    add_bullet("<b>Why:</b> Spares us the expense and complexity of building, hosting, and sandboxing C++ and Java compiler nodes during the initial build phase.")
    add_bullet("<b>Trade-off:</b> Renders the application dependent on third-party service availability. Network latency, strict execution timeouts, and rate limits affect our grading speeds.")

    add_h2("4. Lightweight Single-Page Architecture")
    add_bullet("<b>Decision:</b> Bundled JavaScript, CSS, and assets into a single deployable <code>index.html</code> template using <code>embed_frontend.py</code>.")
    add_bullet("<b>Why:</b> Prevents build-chain friction and provides instant load times for students on slow networks.")
    add_bullet("<b>Trade-off:</b> As proctoring features grow, managing a single massive JS file becomes increasingly complex and error-prone compared to component-based frameworks.")

    story.append(PageBreak())

    # --- PAGE 5: PROTOTYPE VS PRODUCTION & 10,000+ USER SCALING ---
    add_h1("5. Prototype vs. Production: 10,000+ Concurrent Students")
    make_callout("<b>Engineering Choice:</b> I intentionally kept the first implementation economical to reduce operational costs, avoid cloud infrastructure complexity, and move quickly to validate the core product idea. However, the system is now approaching scale limits where prototype trade-offs must be replaced.", bg_color='#FFFBEB', border_color='#D97706')

    add_h2("The 10,000+ Concurrent Student Problem")
    add_p("Under normal testing, students submit code compilation requests simultaneously. If 10,000+ students submit code, the following cascading bottlenecks will occur:")
    add_bullet("<b>Synchronous HTTP Blocks:</b> In <code>SubmissionService.submit_answer</code>, the serverless Flask thread blocks while making HTTP requests to external APIs. Under load, Flask processes will exhaust Vercel's concurrency limit, causing 504 Gateway Timeouts.")
    add_bullet("<b>Compiler API Expiry:</b> Public execution services will instantly block us due to rate-limit triggers. All subsequent student evaluations will fail.")
    add_bullet("<b>Atlas Write Lock Queue:</b> 10,000 student browsers triggering debounced auto-saves (every few seconds) will overload MongoDB Atlas with concurrent <code>$set</code> updates, queuing writes and freezing the database.")

    add_h2("Dedicated Code Execution Architecture (Proposed)")
    add_p("To scale, we must transition from synchronous API compilation to an isolated, asynchronous execution queue:")

    # Queue layout
    queue_code = (
        "Student Submission -> API Gateway -> Queue (Celery/BullMQ) -> Enqueued Job\n"
        "                                                                   |\n"
        " Worker Pool (MicroVMs) <-- Pull Job <-- Isolated Compiler Worker <-\n"
        "         |\n"
        "         v\n"
        " Evaluate Test Cases -> Persist Score -> Notify Client via WebSockets / SSE\n"
    )
    t_q = Table([[Paragraph(f"<pre>{queue_code.replace(' ', '&nbsp;').replace('', '')}</pre>", code_style)]], colWidths=[504])
    t_q.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#F8FAFC')),
        ('BOX', (0,0), (-1,-1), 0.5, colors.HexColor('#E2E8F0')),
        ('PADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(t_q)

    story.append(PageBreak())

    # --- PAGE 6: NEXT ENGINEERING WORK & ROADMAP ---
    add_h1("6. Next Engineering Work & Scaling Roadmap")
    add_p("Below is the planned engineering work required to harden Codexa for large-scale enterprise exam delivery:")

    add_h2("1. Multi-Device & Session Lockouts")
    add_bullet("<b>Problem:</b> Students can open multiple tabs or share workspace URLs to collaborate.")
    add_bullet("<b>Proposed Change:</b> Map each student token to a single active session ID in Redis. Evict and flag older sessions on new logins.")
    add_bullet("<b>Why it Matters:</b> Guarantees exam integrity and prevents simple tab-based collaboration.")

    add_h2("2. Submission Rate Limiting")
    add_bullet("<b>Problem:</b> Students clicking 'Run Code' repeatedly will exhaust worker pools.")
    add_bullet("<b>Proposed Change:</b> Apply a token-bucket rate limiter at the gateway, enforcing a minimum 10-second gap between submissions.")
    add_bullet("<b>Why it Matters:</b> Prevents simple Denial of Service (DoS) conditions on compiler workers.")

    add_h2("3. Submission Idempotency Keys")
    add_bullet("<b>Problem:</b> Flaky student networks lead to duplicate submit requests, double-grading, or trace corruption.")
    add_bullet("<b>Proposed Change:</b> Client attaches a UUID token to every submission. Workers verify if the UUID is already evaluated before executing.")
    add_bullet("<b>Why it Matters:</b> Ensures deterministic execution and prevents duplicate worker loads.")

    add_h2("4. Cursor-Based Leaderboard Pagination")
    add_bullet("<b>Problem:</b> Fetching the entire leaderboard document for 10,000 students causes high serialization lag.")
    add_bullet("<b>Proposed Change:</b> Implement cursor-based page queries for mentor dashboards.")
    add_bullet("<b>Why it Matters:</b> Keeps dashboard response times under 100ms regardless of class size.")

    add_h2("5. Circuit Breakers for External Compilers")
    add_bullet("<b>Problem:</b> Outages at Piston or Paiza crash the exam execution pipeline.")
    add_bullet("<b>Proposed Change:</b> Wrap external calls in a circuit breaker. Redirect execution to basic static analysis validation checks during outages.")
    add_bullet("<b>Why it Matters:</b> Keeps the portal available and prevents cascading timeouts.")

    story.append(PageBreak())

    # --- PAGE 7: CURRENT VS FUTURE COMPARISON & FINAL PAGE ---
    add_h1("7. System Comparison & Final Summary")
    
    # Comparison table
    comp_data = [
        [Paragraph("<b>Feature Component</b>", table_header_style), Paragraph("<b>Current Prototype</b>", table_header_style), Paragraph("<b>Proposed Production</b>", table_header_style)],
        [Paragraph("Database Storage", table_body_style), Paragraph("MongoDB Atlas (Single Instance)", table_body_style), Paragraph("MongoDB Atlas (Sharded Cluster)", table_body_style)],
        [Paragraph("Session & Cache Store", table_body_style), Paragraph("Mongo Atlas (Redis Command Facade)", table_body_style), Paragraph("Distributed Redis Cluster (Upstash/AWS)", table_body_style)],
        [Paragraph("Execution Path", table_body_style), Paragraph("Synchronous HTTP Blocking Threads", table_body_style), Paragraph("Asynchronous Task Queue (Celery/Redis)", table_body_style)],
        [Paragraph("Compiler Infrastructure", table_body_style), Paragraph("Public Shared Compiler APIs", table_body_style), Paragraph("Isolated Worker Nodes (Docker/Firecracker)", table_body_style)],
        [Paragraph("Real-Time Synchronization", table_body_style), Paragraph("Client-side HTTP Polling (10s)", table_body_style), Paragraph("WebSockets / Server-Sent Events (SSE)", table_body_style)],
        [Paragraph("Rate Limiting", table_body_style), Paragraph("No limiting on executions", table_body_style), Paragraph("Gateway Token-Bucket Rate Limiter", table_body_style)],
        [Paragraph("Idempotency Controls", table_body_style), Paragraph("Standard API endpoints", table_body_style), Paragraph("UUID Submission Verification", table_body_style)],
        [Paragraph("Dashboard Pagination", table_body_style), Paragraph("Full document scan and retrieval", table_body_style), Paragraph("Cursor-based paginated aggregations", table_body_style)]
    ]
    
    t_comp = Table(comp_data, colWidths=[120, 192, 192])
    t_comp.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), secondary_color),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#F8FAFC')]),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#E2E8F0')),
    ]))
    story.append(t_comp)
    story.append(Spacer(1, 15))

    add_h2("What I Have Built")
    add_bullet("Iterative database practice sandbox with in-memory execution logic.")
    add_bullet("Fully proctored test environment with automated output freezing.")
    add_bullet("Multi-language ThreadPool-managed compiler integrations.")
    add_bullet("Activity proctoring logging and full visual timeline playback review.")

    add_h2("What I Am Solving Next")
    add_bullet("Decoupled asynchronous execution pipelines using Celery queues.")
    add_bullet("Isolated, secure microVM sandbox compilation environments.")
    add_bullet("Distributed session caches for extreme workloads.")

    story.append(Spacer(1, 15))
    
    # Highlighted final philosophy sentence
    make_callout(
        "<b>Build the simplest system that proves the idea. Then identify exactly where it breaks and replace only the part that needs to scale.</b>",
        bg_color='#ECFDF5',
        border_color='#10B981'
    )

    doc.build(story, canvasmaker=NumberedCanvas)
    print("PDF generated successfully.")

if __name__ == "__main__":
    generate_brief()
