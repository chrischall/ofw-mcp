import type { OFWClient } from './client.js';
import { setMeta } from './cache.js';

export interface FolderIds {
  inbox: string;
  sent: string;
  drafts: string;
}

interface FoldersResponse {
  systemFolders?: Array<{ id: string; folderType: string; name: string }>;
  userFolders?: Array<{ id: string; folderType: string; name: string }>;
}

export async function resolveFolderIds(client: OFWClient): Promise<FolderIds> {
  const data = await client.request<FoldersResponse>(
    'GET',
    '/pub/v1/messageFolders?includeFolderCounts=true'
  );
  const sys = data.systemFolders ?? [];
  const find = (type: string): string => {
    const f = sys.find((x) => x.folderType === type);
    if (!f) throw new Error(`OFW system folder not found: ${type}`);
    return f.id;
  };
  const ids: FolderIds = {
    inbox: find('INBOX'),
    sent: find('SENT_MESSAGES'),
    drafts: find('DRAFTS'),
  };
  setMeta('drafts_folder_id', ids.drafts);
  return ids;
}
