import 'server-only';
import { buildProxyUrl, type PrivateBucket, PRIVATE_BUCKETS } from '@/lib/storage/server';
import type { CampaignAttachmentSummary, CampaignAttachmentView } from '@/lib/wa-queue/types';

// Fills in the authenticated proxy URL (/api/files/<bucket>/<key>) for every
// attachment of a history row / details header. The DB layer returns bucket +
// object_key only, so the one sanctioned URL builder decides the shape here.

function isPrivateBucket(b: string): b is PrivateBucket {
  return (PRIVATE_BUCKETS as readonly string[]).includes(b);
}

export function withAttachmentUrls<T extends { attachments: CampaignAttachmentSummary[] }>(
  c: T,
): Omit<T, 'attachments'> & { attachments: CampaignAttachmentView[] } {
  const attachments: CampaignAttachmentView[] = (c.attachments ?? []).map((a) => ({
    ...a,
    url: isPrivateBucket(a.bucket) ? buildProxyUrl(a.bucket, a.object_key) : '',
  }));
  return { ...c, attachments };
}
