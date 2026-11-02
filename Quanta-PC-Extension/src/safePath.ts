import * as fs from 'fs';
import * as path from 'path';

export function resolveWorkspacePath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath || /[\\:\x00]/.test(relativePath) ||
      path.posix.isAbsolute(relativePath) || relativePath.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('Unsafe workspace path');
  }
  const target = path.resolve(root, relativePath);
  const outside = (base: string, candidate: string) => {
    const relative = path.relative(base, candidate);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  if (outside(path.resolve(root), target)) throw new Error('Path leaves workspace');
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Workspace does not exist');
    ancestor = parent;
  }
  if (outside(fs.realpathSync(root), fs.realpathSync(ancestor))) throw new Error('Symlink leaves workspace');
  return target;
}
