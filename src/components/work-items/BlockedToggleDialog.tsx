'use client';

// Unified תקלות/משימות module (11/10/2026) — "תקוע" is a single boolean +
// reason, set manually from the card/row. A Dialog (not a Sheet) per DESIGN
// LAW: single-field edits are the one case a Dialog is allowed outside
// confirmations.

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function BlockedToggleDialog({
  open,
  onOpenChange,
  kind,
  id,
  currentlyBlocked,
  currentReason,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: 'issue' | 'task';
  id: string;
  currentlyBlocked: boolean;
  currentReason: string | null;
  onDone: (blocked: boolean, reason: string | null) => void;
}) {
  const [reason, setReason] = useState(currentReason ?? '');
  const [busy, setBusy] = useState(false);

  async function save(blocked: boolean) {
    setBusy(true);
    try {
      const r = await fetch(`/api/${kind === 'issue' ? 'issues' : 'tasks'}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ blocked, blocked_reason: blocked ? (reason.trim() || null) : null }),
      });
      if (!r.ok) throw new Error('העדכון נכשל');
      toast.success(blocked ? 'סומן כתקוע' : 'הסימון בוטל');
      onDone(blocked, blocked ? (reason.trim() || null) : null);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{currentlyBlocked ? 'ביטול סימון "תקוע"' : 'סימון "תקוע"'}</DialogTitle>
        </DialogHeader>
        {!currentlyBlocked && (
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="סיבה (רשות)…"
            className="min-h-20"
            maxLength={500}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>ביטול</Button>
          {currentlyBlocked ? (
            <Button onClick={() => void save(false)} disabled={busy}>הסר סימון תקוע</Button>
          ) : (
            <Button onClick={() => void save(true)} disabled={busy} className="bg-red-600 hover:bg-red-700">סמן כתקוע</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
