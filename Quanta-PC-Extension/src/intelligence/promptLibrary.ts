/**
 * Reusable Prompt Library and Template Engine
 * Authors: Akira-official & dark-yoddha
 */

export interface PromptTemplate {
  id: string;
  title: string;
  category: 'code' | 'testing' | 'security' | 'git' | 'explain';
  description: string;
  template: string;
  variables: string[];
}

export const BUILTIN_PROMPTS: PromptTemplate[] = [
  {
    id: 'explain-error',
    title: 'Explain Error & Suggest Fix',
    category: 'explain',
    description: 'Diagnose runtime error or stack trace and propose minimal, verified resolution',
    template: 'I am getting the following error in {{file}}:\n\n```\n{{error}}\n```\n\nPlease explain the root cause and provide a clean, minimal fix.',
    variables: ['file', 'error']
  },
  {
    id: 'write-unit-test',
    title: 'Author Unit Tests',
    category: 'testing',
    description: 'Write robust, framework-aligned unit tests covering edge cases',
    template: 'Write comprehensive unit tests for this code in {{file}}:\n\n```\n{{selection}}\n```\n\nEnsure edge cases, error boundaries, and null safety are thoroughly tested.',
    variables: ['file', 'selection']
  },
  {
    id: 'security-audit',
    title: 'Security & Vulnerability Review',
    category: 'security',
    description: 'Audit code for injection, secret leaks, path traversal, and privilege escalation',
    template: 'Perform a strict security audit on this code snippet:\n\n```\n{{selection}}\n```\n\nCheck for path traversal, command injection, secret leakage, unescaped queries, and input validation vulnerabilities.',
    variables: ['selection']
  },
  {
    id: 'git-commit-msg',
    title: 'Conventional Commit Message',
    category: 'git',
    description: 'Generate conventional commit message based on staged diff',
    template: 'Generate a concise, conventional git commit message (e.g. feat:, fix:, refactor:) for the following diff on branch {{branch}}:\n\n```diff\n{{diff}}\n```',
    variables: ['branch', 'diff']
  },
  {
    id: 'refactor-clean',
    title: 'Refactor for Clarity & Performance',
    category: 'code',
    description: 'Refactor code cleanly preserving all comments, docstrings, and contracts',
    template: 'Refactor this code from {{file}} to improve clarity and performance while strictly preserving existing behavior and docstrings:\n\n```\n{{selection}}\n```',
    variables: ['file', 'selection']
  }
];

export class PromptLibrary {
  private customTemplates: Map<string, PromptTemplate> = new Map();

  constructor(customList: PromptTemplate[] = []) {
    for (const t of customList) {
      this.customTemplates.set(t.id, t);
    }
  }

  public registerTemplate(template: PromptTemplate): void {
    this.customTemplates.set(template.id, template);
  }

  public getTemplate(id: string): PromptTemplate | undefined {
    return this.customTemplates.get(id) || BUILTIN_PROMPTS.find(p => p.id === id);
  }

  public listTemplates(): PromptTemplate[] {
    const all = [...BUILTIN_PROMPTS];
    for (const custom of this.customTemplates.values()) {
      const idx = all.findIndex(t => t.id === custom.id);
      if (idx >= 0) {
        all[idx] = custom;
      } else {
        all.push(custom);
      }
    }
    return all;
  }

  public extractVariables(templateStr: string): string[] {
    const matches = templateStr.match(/{{\s*([a-zA-Z0-9_\-]+)\s*}}/g) || [];
    const vars = new Set<string>();
    for (const m of matches) {
      const name = m.replace(/[{}]/g, '').trim();
      vars.add(name);
    }
    return Array.from(vars);
  }

  /**
   * Renders a template with provided parameter map.
   */
  public render(id: string, params: Record<string, string>): string {
    const tmpl = this.getTemplate(id);
    if (!tmpl) {
      throw new Error(`Template not found: ${id}`);
    }

    return tmpl.template.replace(/{{\s*([a-zA-Z0-9_\-]+)\s*}}/g, (_, varName) => {
      if (params[varName] !== undefined && params[varName] !== null) {
        return params[varName];
      }
      return `{{${varName}}}`; // Keep placeholder if not provided
    });
  }
}

