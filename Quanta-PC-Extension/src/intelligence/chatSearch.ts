/**
 * Chat Knowledge Base & Local Transcript Search Engine
 * Provides fast in-memory inverted index searching over redacted Antigravity transcripts.
 * Authors: Akira-official & dark-yoddha
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  toolCalls?: Array<{ name: string; args?: any }>;
}

export interface ChatSession {
  sessionId: string;
  title?: string;
  createdAt?: string;
  messages: ChatMessage[];
}

export interface SearchResult {
  sessionId: string;
  messageIndex: number;
  role: string;
  score: number;
  snippet: string;
  matchedTokens: string[];
}

export class ChatSearchIndex {
  private sessions: Map<string, ChatSession> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map(); // token -> Set of "sessionId:msgIndex"

  /**
   * Tokenize and normalize text for indexing.
   */
  private tokenize(text: string): string[] {
    if (!text || typeof text !== 'string') return [];
    return text
      .toLowerCase()
      .replace(/[^\w\s\-\.\/]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && t.length < 50);
  }

  /**
   * Index a collection of chat sessions.
   */
  public indexSessions(sessions: ChatSession[]): void {
    this.sessions.clear();
    this.invertedIndex.clear();

    for (const session of sessions) {
      this.sessions.set(session.sessionId, session);
      session.messages.forEach((msg, idx) => {
        const docRef = `${session.sessionId}:${idx}`;
        const tokens = new Set(this.tokenize(msg.content));
        
        // Also index tool calls if present
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            this.tokenize(tc.name).forEach(t => tokens.add(t));
            if (tc.args && typeof tc.args === 'object') {
              this.tokenize(JSON.stringify(tc.args)).forEach(t => tokens.add(t));
            }
          }
        }

        for (const token of tokens) {
          if (!this.invertedIndex.has(token)) {
            this.invertedIndex.set(token, new Set());
          }
          this.invertedIndex.get(token)!.add(docRef);
        }
      });
    }
  }

  /**
   * Query indexed transcripts using BM25-lite keyword scoring.
   */
  public search(query: string, limit: number = 20): SearchResult[] {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return [];

    const hitScores: Map<string, { score: number; matched: Set<string> }> = new Map();

    for (const token of queryTokens) {
      // Find matching tokens in index (exact and prefix)
      for (const [idxToken, docRefs] of this.invertedIndex.entries()) {
        let weight = 0;
        if (idxToken === token) {
          weight = 3.0; // exact match
        } else if (idxToken.startsWith(token) || token.startsWith(idxToken)) {
          weight = 1.0; // partial match
        }

        if (weight > 0) {
          for (const docRef of docRefs) {
            if (!hitScores.has(docRef)) {
              hitScores.set(docRef, { score: 0, matched: new Set() });
            }
            const item = hitScores.get(docRef)!;
            item.score += weight;
            item.matched.add(token);
          }
        }
      }
    }

    const results: SearchResult[] = [];

    for (const [docRef, { score, matched }] of hitScores.entries()) {
      const [sessionId, msgIdxStr] = docRef.split(':');
      const msgIdx = parseInt(msgIdxStr, 10);
      const session = this.sessions.get(sessionId);
      if (!session || !session.messages[msgIdx]) continue;

      const msg = session.messages[msgIdx];
      const snippet = this.createSnippet(msg.content, Array.from(matched));

      results.push({
        sessionId,
        messageIndex: msgIdx,
        role: msg.role,
        score,
        snippet,
        matchedTokens: Array.from(matched)
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private createSnippet(content: string, matchedTokens: string[], maxLen: number = 200): string {
    if (!content) return '';
    const clean = content.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;

    const lower = clean.toLowerCase();
    let bestPos = -1;

    for (const token of matchedTokens) {
      const pos = lower.indexOf(token);
      if (pos !== -1) {
        bestPos = pos;
        break;
      }
    }

    if (bestPos === -1) {
      return clean.slice(0, maxLen) + '...';
    }

    const start = Math.max(0, bestPos - 40);
    const end = Math.min(clean.length, bestPos + maxLen - 40);
    return (start > 0 ? '...' : '') + clean.slice(start, end) + (end < clean.length ? '...' : '');
  }
}

