import fs from 'fs';
import path from 'path';
import { eventBus } from '../core/eventBus.js';
import { auditLogger } from '../security/auditLogger.js';

export class PluginHost {
  constructor(options = {}) {
    this.plugins = new Map(); // name -> { manifest, instance, context }
    this.pluginDirs = options.pluginDirs || [
      path.join(process.cwd(), 'plugins')
    ];
    this.quickActionRegistrar = null;
  }

  setQuickActionRegistrar(registrar) {
    this.quickActionRegistrar = registrar;
  }

  createContext(pluginName) {
    return {
      name: pluginName,
      eventBus: {
        on: (event, handler) => {
          eventBus.on(event, (data) => {
            try {
              handler(data);
            } catch (err) {
              console.error(`[Plugin:${pluginName}] Error in event handler '${event}':`, err.message);
            }
          });
        },
        emit: (event, data) => eventBus.emit(event, data)
      },
      registerQuickAction: (action) => {
        if (this.quickActionRegistrar) {
          this.quickActionRegistrar.registerAction({
            ...action,
            id: `plugin.${pluginName}.${action.id}`
          });
        }
      },
      log: (...args) => console.log(`[Plugin:${pluginName}]`, ...args),
      auditLogger: {
        log: (action, meta) => auditLogger.log(`PLUGIN_${pluginName.toUpperCase()}_${action}`, meta)
      }
    };
  }

  async loadPluginFromModule(modulePath) {
    try {
      const mod = await import(`file://${path.resolve(modulePath)}`);
      const plugin = mod.default || mod;

      if (!plugin.name) {
        throw new Error(`Plugin in ${modulePath} missing required 'name' field`);
      }

      console.log(`[PluginHost] Loading plugin: ${plugin.name} v${plugin.version || '1.0.0'}`);
      const context = this.createContext(plugin.name);

      if (typeof plugin.init === 'function') {
        await plugin.init(context);
      }

      this.plugins.set(plugin.name, {
        name: plugin.name,
        version: plugin.version || '1.0.0',
        instance: plugin,
        context,
        path: modulePath
      });

      auditLogger.log('PLUGIN_LOADED', { name: plugin.name, version: plugin.version });
      return true;
    } catch (err) {
      console.error(`[PluginHost] Failed to load plugin from ${modulePath}:`, err.message);
      return false;
    }
  }

  async loadPluginsFromDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        await this.loadPluginFromModule(path.join(dirPath, entry.name));
      } else if (entry.isDirectory()) {
        const indexFile = path.join(dirPath, entry.name, 'index.js');
        if (fs.existsSync(indexFile)) {
          await this.loadPluginFromModule(indexFile);
        }
      }
    }
  }

  listPlugins() {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.name,
      version: p.version,
      path: p.path
    }));
  }

  async unloadAll() {
    for (const [name, p] of this.plugins.entries()) {
      try {
        if (typeof p.instance.dispose === 'function') {
          await p.instance.dispose();
        }
      } catch (e) {
        console.warn(`[PluginHost] Error disposing ${name}:`, e.message);
      }
    }
    this.plugins.clear();
  }
}

export const pluginHost = new PluginHost();

