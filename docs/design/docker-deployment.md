# Docker Containerization & Deployment Design Document (P2 Feature)

**Authors:** Akira-official & dark-yoddha  
**Status:** Proposed / Draft (P2)  
**Target:** Quanta IDE Remote-Control Sandboxed Deployment

---

## 1. Executive Summary

Running Quanta Remote-Control directly on a developer workstation allows fast pairing with Google Antigravity. However, when deploying Quanta Remote-Control in headless environments, dedicated dev-servers, or cloud VMs, containerization ensures process isolation, automated health recovery, and sandboxed execution of subagent terminal commands.

This document outlines the container architecture, security boundaries, and sample deployment configurations.

---

## 2. Container Architecture

```
┌────────────────────────────────────────────────────────┐
│ Host Operating System (Linux / macOS / Windows WSL2)    │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Docker Engine / Podman                           │  │
│  │                                                  │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │ Container: quanta-remote-control           │  │  │
│  │  │ User: node (UID 1000, non-root)            │  │  │
│  │  │ Filesystem: Read-only root (/)             │  │  │
│  │  │                                            │  │  │
│  │  │ Mounted Volumes:                           │  │  │
│  │  │  • /workspace (Dev project, rw)           │  │  │
│  │  │  • /home/node/.quanta (Config/logs, rw)    │  │  │
│  │  │  • /app/certs (SSL certificates, ro)       │  │  │
│  │  │                                            │  │  │
│  │  │ Exposed Ports:                             │  │  │
│  │  │  • 3000 (HTTPS & WebSocket)                │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## 3. Hardened Multi-Stage Dockerfile

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Hardened Runtime
FROM node:20-alpine
LABEL maintainer="Akira-official & dark-yoddha"

# Install curl for healthchecks and git for shadow checkpoints
RUN apk add --no-cache curl git

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Run as non-privileged node user
USER node

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -k -f https://localhost:3000/health || exit 1

EXPOSE 3000

CMD ["node", "server.js"]
```

---

## 4. Docker Compose Orchestration (`docker-compose.yml`)

```yaml
version: '3.8'

services:
  quanta-remote:
    build:
      context: ./Remote-Control
      dockerfile: Dockerfile
    container_name: quanta-remote-control
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - APP_PASSWORD=${APP_PASSWORD}
      - COOKIE_SECRET=${COOKIE_SECRET}
      - SESSION_SECRET=${SESSION_SECRET}
      - NODE_ENV=production
    volumes:
      - ./workspace:/workspace:rw
      - quanta-data:/home/node/.quanta:rw
      - ./Remote-Control/certs:/app/certs:ro
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID

volumes:
  quanta-data:
    driver: local
```

---

## 5. Security & Isolation Controls

1. **Non-Root Execution:** The container explicitly drops root privileges, executing under user `node` (UID 1000).
2. **Capability Dropping:** All Linux capabilities (`ALL`) are dropped by default, preventing raw socket manipulation or privilege escalation.
3. **Workspace Isolation:** Only explicitly mounted host directories are accessible via the FileBrowser. Path traversal attempts (`../`) are bounded by the container's virtual root.
4. **Secrets via Environment / Secrets Engine:** Credentials are never baked into container layers.

