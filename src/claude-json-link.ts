import fs from 'node:fs';

export type ClaudeJsonLinkResult =
  | 'already-linked'
  | 'symlink'
  | 'hardlink'
  | 'copy';

export type ClaudeJsonFileSystem = Pick<
  typeof fs,
  | 'lstatSync'
  | 'statSync'
  | 'readlinkSync'
  | 'unlinkSync'
  | 'symlinkSync'
  | 'linkSync'
  | 'copyFileSync'
>;

function pointsToTarget(
  fileSystem: ClaudeJsonFileSystem,
  localPath: string,
  targetPath: string,
): boolean {
  try {
    const localStat = fileSystem.lstatSync(localPath);
    const targetStat = fileSystem.statSync(targetPath);
    if (localStat.isSymbolicLink()) {
      return fileSystem.readlinkSync(localPath) === targetPath;
    }
    return localStat.dev === targetStat.dev && localStat.ino === targetStat.ino;
  } catch {
    return false;
  }
}

/**
 * Claude identifies a host installation through `.claude.json`. A link keeps
 * that identity shared with the session config. Windows often forbids symlink
 * creation without Developer Mode or symlink privilege, so use a same-volume
 * hard link first and a content copy as the final portable fallback.
 */
export function ensureClaudeJsonLink(
  localPath: string,
  targetPath: string,
  fileSystem: ClaudeJsonFileSystem = fs,
): ClaudeJsonLinkResult {
  if (pointsToTarget(fileSystem, localPath, targetPath)) {
    return 'already-linked';
  }

  try {
    fileSystem.unlinkSync(localPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    fileSystem.symlinkSync(targetPath, localPath);
    return 'symlink';
  } catch {
    // Continue to the Windows-safe fallbacks.
  }

  try {
    fileSystem.linkSync(targetPath, localPath);
    return 'hardlink';
  } catch {
    // Different volumes and restricted filesystems still support a copy.
  }

  fileSystem.copyFileSync(targetPath, localPath);
  return 'copy';
}
