# Dockerfile for streaming native PySide6 desktop window (launcher.py) over web (noVNC)
FROM linuxserver/webtop:ubuntu-xfce

ENV TITLE="MongoSandbox - MongoDB Practice IDE"
ENV CUSTOM_PORT=7860

WORKDIR /app
COPY . /app

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    libxcb-cursor0 \
    libxkbcommon-x11-0 \
    libxcb-icccm4 \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-randr0 \
    libxcb-render-util0 \
    libxcb-xinerama0 \
    libxcb-xfixes0 \
    libgl1-mesa-glx \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir -r requirements.txt

# Start launcher.py on container desktop startup
RUN echo "python3 /app/launcher.py &" >> /defaults/autostart
