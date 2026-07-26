"""
streamlit_app.py
Pure Python Web Interface for MongoSandbox.
Runs your exact Python backend, analytics tracker, and query execution engine on free cloud servers (Streamlit Cloud / Render / Hugging Face).
"""

import streamlit as st
import json
from pathlib import Path
from utils.analytics import analytics_tracker
from core.database import db_engine
from core.executor import query_executor

# Page Configuration
st.set_page_config(
    page_title="Welcome to MongoDB Practise Workspace",
    page_icon="🍃",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom MongoDB Styling
st.markdown("""
<style>
    .main { background-color: #ffffff; color: #001e2b; }
    .stApp { background-color: #ffffff; color: #001e2b; }
    .title-l1 { font-size: 48px; font-weight: 800; color: #001e2b; text-align: center; }
    .title-l2 { font-size: 56px; font-weight: 900; color: #00684a; text-align: center; }
    .subtitle { font-size: 28px; font-weight: 600; color: #334155; text-align: center; margin-bottom: 20px; }
    .stat-text { font-size: 22px; font-weight: 700; color: #001e2b; }
    .stat-green { color: #00684a; font-weight: 800; }
</style>
""", unsafe_allow_html=True)

# Navigation
st.sidebar.title("🍃 MongoSandbox (Python)")
nav = st.sidebar.radio("Navigation", ["🏠 Intro Page", "⚡ Query IDE Workspace", "⛁ Schema ER Visualizer", "📖 User Manual"])

stats = analytics_tracker.get_stats()

if nav == "🏠 Intro Page":
    st.markdown('<div class="title-l1">Welcome to MongoDB Practise</div>', unsafe_allow_html=True)
    st.markdown('<div class="title-l2">Workspace</div>', unsafe_allow_html=True)
    st.markdown('<div class="subtitle">A unified platform to learn mongodb precisely</div>', unsafe_allow_html=True)
    
    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        logo_path = Path(__file__).parent / "ui" / "image.png"
        if logo_path.exists():
            st.image(str(logo_path), use_column_width=True)
        if st.button("🚀 Enter Workspace ➔", use_container_width=True):
            st.session_state["nav"] = "⚡ Query IDE Workspace"
            st.rerun()

    st.divider()
    b_col1, b_col2 = st.columns(2)
    with b_col1:
        st.markdown(f'<div class="stat-text">Active Users : <span class="stat-green">{stats.get("active_users", 1)}</span></div>', unsafe_allow_html=True)
        st.markdown(f'<div class="stat-text">Total Visited : <span class="stat-green">{stats.get("total_visits", 1)}</span></div>', unsafe_allow_html=True)
    with b_col2:
        st.markdown('<div style="text-align: right;" class="stat-text">Visit developer : Prranith Swargam</div>', unsafe_allow_html=True)
        st.markdown('<div style="text-align: right;"><a href="https://www.linkedin.com/in/prranith-swargam-a620a6334/" target="_blank">https://www.linkedin.com/in/prranith-swargam-a620a6334/</a></div>', unsafe_allow_html=True)

elif nav == "⚡ Query IDE Workspace":
    st.title("⚡ Python MongoDB Query Workspace")
    
    col_select = st.selectbox("Select Collection Profile:", ["users", "orders", "inventory", "shipments", "elite"])
    query_input = st.text_area("MongoDB Query (Python Engine):", value=f"db.{col_select}.find({{}})", height=150)
    
    if st.button("▶ Run Query"):
        res = query_executor.execute(query_input)
        st.subheader("Console Output:")
        st.json(res.documents)
        st.caption(f"Execution time: {res.execution_time_ms} ms | Status: {res.status}")

elif nav == "⛁ Schema ER Visualizer":
    st.title("⛁ Schema ER Relations Visualizer")
    st.markdown("""
    - **orders.user_id ➔ users._id**
    - **orders.items.sku ➔ inventory.sku**
    - **shipments.order_id ➔ orders._id**
    """)

elif nav == "📖 User Manual":
    st.title("📖 User Manual")
    st.markdown("""
    1. **Intro Page**: Live real-time stats & profile tracking.
    2. **Query IDE**: In-memory MongoDB sandbox Python engine.
    3. **Schema Visualizer**: Schema relationships and join generator.
    """)
