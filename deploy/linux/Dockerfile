FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PGA_HOST=0.0.0.0 \
    PGA_PORT=8000 \
    HOME=/home/pga

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      libnotify-bin \
      poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash pga \
    && mkdir -p /data/PGA/pga /data/PGA/workspaces /data/PGA/state /data/PGA/notes /data/PGA/snapshots /data/PGA/logs \
    && chown -R pga:pga /data/PGA /home/pga

WORKDIR /data/PGA/pga

COPY pyproject.toml README.md README.zh-CN.md alembic.ini ./
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts
COPY deploy/linux/entrypoint.sh /usr/local/bin/pga-entrypoint

RUN pip install --no-cache-dir . \
    && chmod +x /usr/local/bin/pga-entrypoint \
    && chown -R pga:pga /data/PGA

USER pga
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/pga-entrypoint"]
