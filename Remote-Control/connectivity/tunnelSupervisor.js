import { spawn } from 'child_process';
import { eventBus } from '../core/eventBus.js';
import { auditLogger } from '../security/auditLogger.js';

export class TunnelSupervisor {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.providers = options.providers || ['cloudflare', 'ngrok', 'pinggy', 'loclx'];
    this.currentProviderIndex = 0;
    this.currentProcess = null;
    this.currentUrl = null;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs || 15000;
    this.consecutiveFailures = 0;
    this.failureThreshold = 2; // Hysteresis: 2 consecutive failures before switching
    this.timer = null;
    this.isSupervising = false;
  }

  getCurrentStatus() {
    return {
      active: !!this.currentProcess,
      provider: this.providers[this.currentProviderIndex] || null,
      url: this.currentUrl,
      consecutiveFailures: this.consecutiveFailures,
      providersAvailable: [...this.providers]
    };
  }

  async startSupervisor() {
    if (this.isSupervising) return;
    this.isSupervising = true;
    console.log('[TunnelSupervisor] Starting tunnel supervisor with providers:', this.providers.join(' -> '));
    await this.startCurrentProvider();

    this.timer = setInterval(() => this.checkHealth(), this.healthCheckIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stopSupervisor() {
    this.isSupervising = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.killCurrentProcess();
  }

  killCurrentProcess() {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGTERM');
      } catch (e) {}
      this.currentProcess = null;
    }
    this.currentUrl = null;
  }

  async startCurrentProvider() {
    this.killCurrentProcess();
    const provider = this.providers[this.currentProviderIndex];
    if (!provider) {
      console.error('[TunnelSupervisor] All tunnel providers exhausted.');
      eventBus.emit('tunnel:error', { error: 'All tunnel providers exhausted' });
      return false;
    }

    console.log(`[TunnelSupervisor] Launching tunnel provider: ${provider}...`);
    auditLogger.log('TUNNEL_SPAWN_ATTEMPT', { provider, port: this.port });

    return new Promise((resolve) => {
      let proc = null;
      let resolved = false;

      const finish = (url) => {
        if (resolved) return;
        resolved = true;
        if (url) {
          const oldUrl = this.currentUrl;
          this.currentUrl = url;
          this.currentProcess = proc;
          this.consecutiveFailures = 0;
          console.log(`[TunnelSupervisor] Active tunnel established on ${provider}: ${url}`);
          eventBus.emit('tunnel:changed', { provider, url, previousUrl: oldUrl });
          auditLogger.log('TUNNEL_READY', { provider, url });
          resolve(true);
        } else {
          resolve(false);
        }
      };

      try {
        if (provider === 'cloudflare') {
          proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
          const onData = (data) => {
            const str = data.toString();
            const match = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (match) finish(match[0]);
          };
          proc.stdout.on('data', onData);
          proc.stderr.on('data', onData);
        } else if (provider === 'ngrok') {
          proc = spawn('ngrok', ['http', `${this.port}`, '--log=stdout'], { stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout.on('data', (data) => {
            const str = data.toString();
            const match = str.match(/url=(https:\/\/[a-zA-Z0-9-]+\.ngrok-free\.app|https:\/\/[a-zA-Z0-9-]+\.ngrok\.io)/);
            if (match) finish(match[1]);
          });
        } else if (provider === 'pinggy') {
          proc = spawn('ssh', ['-p', '443', '-R0:localhost:' + this.port, 'a.pinggy.io'], { stdio: ['ignore', 'pipe', 'pipe'] });
          proc.stdout.on('data', (data) => {
            const str = data.toString();
            const match = str.match(/https:\/\/[a-zA-Z0-9-]+\.a\.free\.pinggy\.link/);
            if (match) finish(match[0]);
          });
        } else {
          console.warn(`[TunnelSupervisor] Unsupported provider ${provider}, skipping`);
          finish(null);
          return;
        }

        proc.on('error', (err) => {
          console.warn(`[TunnelSupervisor] Failed to launch ${provider}:`, err.message);
          finish(null);
        });

        proc.on('exit', (code) => {
          if (!resolved) {
            console.warn(`[TunnelSupervisor] ${provider} exited prematurely with code ${code}`);
            finish(null);
          } else {
            console.warn(`[TunnelSupervisor] Tunnel ${provider} closed.`);
            this.handleTunnelDrop();
          }
        });

        // Timeout 15 seconds to establish
        setTimeout(() => {
          if (!resolved) {
            console.warn(`[TunnelSupervisor] Tunnel handshake timed out for ${provider}`);
            if (proc) proc.kill();
            finish(null);
          }
        }, 15000);

      } catch (err) {
        console.error(`[TunnelSupervisor] Exception spawning ${provider}:`, err.message);
        finish(null);
      }
    });
  }

  async handleTunnelDrop() {
    this.consecutiveFailures++;
    console.warn(`[TunnelSupervisor] Tunnel failure count: ${this.consecutiveFailures}/${this.failureThreshold}`);

    if (this.consecutiveFailures >= this.failureThreshold) {
      console.warn(`[TunnelSupervisor] Threshold reached. Switching to next tunnel fallback...`);
      auditLogger.log('TUNNEL_FALLBACK_TRIGGERED', {
        previousProvider: this.providers[this.currentProviderIndex],
        failureCount: this.consecutiveFailures
      });

      this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
      await this.startCurrentProvider();
    }
  }

  async checkHealth() {
    if (!this.currentUrl) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${this.currentUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        this.consecutiveFailures = 0;
      } else {
        await this.handleTunnelDrop();
      }
    } catch (e) {
      await this.handleTunnelDrop();
    }
  }
}

export const tunnelSupervisor = new TunnelSupervisor();

