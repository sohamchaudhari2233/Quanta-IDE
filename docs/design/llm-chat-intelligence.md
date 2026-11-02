# LLM Chat Intelligence & Transcript Digest Design Document (P2 Feature)

**Authors:** Akira-official & dark-yoddha  
**Status:** Proposed / Draft (P2)  
**Target:** Quanta IDE Intelligence Subsystem

---

## 1. Executive Summary

During lengthy pairing sessions, Antigravity generates hundreds of transcript turns spanning command executions, file modifications, reasoning chains, and tool responses. While Quanta PC Extension indexes these locally using an inverted keyword index (`ChatSearchIndex`), semantic understanding, cross-session concept retrieval, and high-level session summaries require LLM-driven intelligence.

This design document outlines a privacy-preserving architecture for semantic search, automatic session digests, and intent-aware git commit synthesis.

---

## 2. Privacy & Threat Model

Transcripts routinely contain proprietary source code, internal host paths, and local configuration details. Therefore:

1. **Local-First Default:**
   - Embeddings and summaries should execute on-device whenever possible using lightweight local runtimes (e.g. Ollama with `llama3.2:1b` or ONNX-based MiniLM embeddings).
2. **Strict Pre-Redaction:**
   - No transcript turn may be submitted to any LLM (local or cloud) without first passing through Quanta's regex-based secret and PII redactor (`Quanta-PC-Extension/src/redaction.ts`).
3. **Explicit Cloud Opt-In:**
   - Cloud LLM summarization (e.g. via Gemini 1.5 Flash) must require explicit configuration of an API key and user consent in settings (`quanta.intelligence.enableCloudLlm: true`).

---

## 3. Architecture & Components

```
[ Antigravity transcript.jsonl ]
               │
               ▼
   [ Transcript Redactor ]
               │
       ┌───────┴───────────────────────┐
       ▼                               ▼
[ Vector Embedding Engine ]    [ Session Digest Engine ]
 (Local Ollama / ONNX)         (Summarizes active sprint)
       │                               │
       ▼                               ▼
[ Vector Store (.quanta/vectors) ] [ SPRINT_SUMMARY.md ]
       │                               │
       ▼                               ▼
[ Semantic Query Search ]      [ Git Commit Synthesizer ]
```

---

## 4. Key Subsystems

### 4.1 Local Semantic Embeddings
- Model: `nomic-embed-text` (384 dimensions) or `all-MiniLM-L6-v2`.
- Storage: Flat binary index or SQLite with `sqlite-vec` extension in `.quanta/cache/embeddings.db`.
- Chunking: Chunk turns into `(role, content_summary, tools)` triples capped at 512 tokens.

### 4.2 Automated Session Digest
- Triggers: On `quanta.syncChats` or when a task queue batch completes.
- Output: Markdown summary detailing:
  - Primary goal
  - Files modified
  - Tests executed and pass/fail status
  - Outstanding questions or unresolved errors

### 4.3 Intent-Aware Git Commit Message Generation
- Combines `git diff --staged` with the last 3 turns of user prompts from the transcript.
- Generates Conventional Commits formatted text (`feat(auth): add PKCE challenge support`).

---

## 5. Milestone & Implementation Plan

1. **Phase P2.1:** Implement Ollama REST client wrapper with health checks.
2. **Phase P2.2:** Build offline embedding pipeline with fallback to keyword index when Ollama is unavailable.
3. **Phase P2.3:** Add `Quanta: Generate Commit Message from Chat` command to VS Code Command Palette.

