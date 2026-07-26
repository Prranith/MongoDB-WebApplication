"""
streamlit_app.py
100% Pure Python Web Deployment Entry Point for MongoSandbox.
Imports and runs all python core engines (core.database, core.executor, core.snippets, utils.analytics).
Compatible with Streamlit Community Cloud (100% Free) & Hugging Face Spaces (100% Free).
"""

import sys
from pathlib import Path
import json
import streamlit as st

# Ensure project root is in sys.path
ROOT_DIR = Path(__file__).parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Import Python Core Modules
from core.database import db_engine
from core.executor import query_executor
from core.snippets import snippets_manager
from utils.analytics import analytics_tracker

# Page Config with MongoDB Theme
st.set_page_config(
    page_title="MongoDB Practice Workspace",
    page_icon="🍃",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom MongoDB Theme Styling
st.markdown("""
<style>
    .stApp {
        background-color: #ffffff;
        color: #001e2b;
    }
    .main-title {
        font-size: 42px !important;
        font-weight: 800 !important;
        color: #001e2b !important;
        text-align: center;
    }
    .sub-title {
        font-size: 48px !important;
        font-weight: 900 !important;
        color: #00684a !important;
        text-align: center;
    }
    .tagline-text {
        font-size: 22px !important;
        font-weight: 600 !important;
        color: #334155 !important;
        text-align: center;
        margin-bottom: 20px;
    }
    .stat-text {
        font-size: 18px !important;
        font-weight: 700 !important;
        color: #001e2b !important;
    }
    .stat-green {
        color: #00684a !important;
    }
    .stButton>button {
        background-color: #00684a !important;
        color: #ffffff !important;
        font-size: 18px !important;
        font-weight: bold !important;
        border-radius: 8px !important;
        padding: 10px 24px !important;
        border: none !important;
    }
    .stButton>button:hover {
        background-color: #00ed64 !important;
        color: #001e2b !important;
    }
</style>
""", unsafe_allow_html=True)

# Record launch analytics in Python engine
analytics_tracker.record_app_launch()
stats = analytics_tracker.get_stats()

# Navigation State
if "page" not in st.session_state:
    st.session_state["page"] = "intro"

# Sidebar Controls
st.sidebar.title("🍃 MongoSandbox (Python)")
st.sidebar.markdown("**Database:** `practice_db` (In-Memory)")

page_choice = st.sidebar.radio("Navigation", ["🏠 Intro Page", "🚀 Query Editor IDE", "⧉ Schema ER Visualizer", "📖 User Manual"])

if page_choice == "🏠 Intro Page":
    st.session_state["page"] = "intro"
elif page_choice == "🚀 Query Editor IDE":
    st.session_state["page"] = "ide"
elif page_choice == "⧉ Schema ER Visualizer":
    st.session_state["page"] = "schema"
elif page_choice == "📖 User Manual":
    st.session_state["page"] = "manual"

# ── 1. INTRO PAGE VIEW ────────────────────────────────────────────────────────
if st.session_state["page"] == "intro":
    st.markdown('<div class="main-title">Welcome to  MongoDB Practise</div>', unsafe_allow_html=True)
    st.markdown('<div class="sub-title">Workspace</div>', unsafe_allow_html=True)
    st.markdown('<div class="tagline-text">A unified platform to learn mongodb precisely</div>', unsafe_allow_html=True)

    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        logo_path = ROOT_DIR / "ui" / "image.png"
        if logo_path.exists():
            st.image(str(logo_path), width=380)
        else:
            st.write("🍃 MongoDB Logo")
        
        if st.button("🚀 Enter Workspace ➔", use_container_width=True):
            st.session_state["page"] = "ide"
            st.rerun()

    st.markdown("---")
    b_col1, b_col2 = st.columns(2)
    with b_col1:
        st.markdown(f'<div class="stat-text">Active Users : {stats.get("active_users", 1)}</div>', unsafe_allow_html=True)
        st.markdown(f'<div class="stat-text stat-green">Total Visited : {stats.get("total_visits", 1)}</div>', unsafe_allow_html=True)

    with b_col2:
        st.markdown('<div class="stat-text" style="text-align: right;">Visit developer : Prranith Swargam</div>', unsafe_allow_html=True)
        st.markdown('<div style="text-align: right;"><a href="https://www.linkedin.com/in/prranith-swargam-a620a6334/" target="_blank">https://www.linkedin.com/in/prranith-swargam-a620a6334/</a></div>', unsafe_allow_html=True)

# ── 2. QUERY EDITOR IDE VIEW ──────────────────────────────────────────────────
elif st.session_state["page"] == "ide":
    st.title("🚀 MongoDB Query IDE")
    
    col_left, col_right = st.columns([3, 1])
    
    with col_left:
        # Collection Selector & Snippets
        coll_list = db_engine.list_collections()
        selected_coll = st.selectbox("Select Collection:", coll_list, index=0)
        
        default_query = f'db.{selected_coll}.find({{}})'
        query_input = st.text_area("MongoDB Shell Query (Python Executor):", value=default_query, height=180)
        
        if st.button("▶ Run Query", type="primary"):
            analytics_tracker.record_query_executed()
            analytics_tracker.record_profile_visit(selected_coll)
            
            # Execute via Python Executor engine
            result = query_executor.execute(query_input)
            
            st.markdown("### 📋 Output Console")
            if result.get("success"):
                st.success(f"Status: SUCCESS ({result.get('count', 0)} documents returned in {result.get('execution_time_ms', 0.0):.2f} ms)")
                docs = result.get("documents", [])
                st.json(docs)
            else:
                st.error(f"Execution Error: {result.get('error', 'Unknown Error')}")

    with col_right:
        st.markdown("### ⛁ Collection Stats")
        coll_info = db_engine.get_collection_stats(selected_coll)
        st.write(f"**Collection:** `{selected_coll}`")
        st.write(f"**Document Count:** `{coll_info.get('count', 0)}`")
        
        st.markdown("### 💡 Code Snippets")
        snips = snippets_manager.get_all_snippets()
        for s in snips[:5]:
            if st.button(f"Snippet: {s.get('name')}"):
                st.code(s.get("code"), language="javascript")

# ── 3. SCHEMA ER VISUALIZER ───────────────────────────────────────────────────
elif st.session_state["page"] == "schema":
    st.title("🔗 Schema ER Relations Visualizer")
    st.write("Explore collection schemas and relational mappings across practice_db.")
    
    col_a, col_b = st.columns(2)
    with col_a:
        st.subheader("Collection Schemas")
        for c_name in db_engine.list_collections():
            with st.expander(f"Collection: {c_name}"):
                sample_docs = db_engine.find(c_name, {}, limit=1)
                if sample_docs:
                    doc = sample_docs[0]
                    schema = {k: type(v).__name__ for k, v in doc.items()}
                    st.json(schema)

    with col_b:
        st.subheader("Relational Mappings ($lookup)")
        st.info("orders.user_id ➔ users._id")
        st.info("orders.items.sku ➔ inventory.sku")
        st.info("shipments.order_id ➔ orders._id")
        
        st.code("""
db.orders.aggregate([
  {
    $lookup: {
      from: "users",
      localField: "user_id",
      foreignField: "_id",
      as: "user_details"
    }
  }
])
""", language="javascript")

# ── 4. USER MANUAL ────────────────────────────────────────────────────────────
elif st.session_state["page"] == "manual":
    st.title("📖 Interactive User Manual")
    st.markdown("""
    ### 1. Overview
    MongoSandbox is a high-performance MongoDB learning environment running 100% in-memory with file-based persistence.

    ### 2. Practice Datasets
    - **users**: 132 profiles with names, emails, roles, ages.
    - **orders**: 160 transactions with status and totals.
    - **inventory**: 100 stock items with SKUs and warehouses.
    - **shipments**: 84 tracking records with carriers.
    - **elite**: 104 premium records.

    ### 3. Running Queries
    Use standard MongoDB syntax:
    - `db.users.find({ status: "active" })`
    - `db.orders.aggregate([{ $match: { status: "completed" } }])`
    - `db.inventory.countDocuments()`
    """)
