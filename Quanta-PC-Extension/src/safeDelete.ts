import * as vscode from 'vscode';

const API_BASE = 'https://www.googleapis.com/drive/v3';

/**
 * Move a file or folder to Google Drive Trash instead of permanently deleting it.
 */
export async function trashDriveFile(accessToken: string, fileId: string): Promise<boolean> {
  const url = `${API_BASE}/files/${fileId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ trashed: true })
  });

  if (!response.ok) {
    throw new Error(`Failed to trash remote file: ${response.statusText}`);
  }
  return true;
}

/**
 * Evaluate mass-deletion safety threshold. Returns true if safe to proceed, false if rejected.
 */
export async function verifyDeletionSafety(
  deleteCount: number,
  totalTreeCount: number,
  itemNames: string[] = []
): Promise<boolean> {
  if (deleteCount === 0) return true;

  const config = vscode.workspace.getConfiguration('quanta');
  const countThreshold = config.get<number>('deleteThreshold', 20);
  const percentageThreshold = config.get<number>('deletePercentageThreshold', 30);

  const percentage = totalTreeCount > 0 ? (deleteCount / totalTreeCount) * 100 : 100;
  const isExceeded = deleteCount >= countThreshold || (percentage >= percentageThreshold && deleteCount > 5);

  if (isExceeded) {
    const previewList = itemNames.slice(0, 5).join(', ') + (itemNames.length > 5 ? ` and ${itemNames.length - 5} more...` : '');
    const choice = await vscode.window.showWarningMessage(
      `[SAFETY GUARD] Quanta detected ${deleteCount} items (${percentage.toFixed(1)}% of workspace) to be removed:\n[${previewList}]\n\nAre you sure you want to move these to Google Drive Trash?`,
      { modal: true },
      'Confirm Move to Trash',
      'Abort Deletion'
    );

    return choice === 'Confirm Move to Trash';
  }

  return true;
}

