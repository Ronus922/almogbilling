'use client';

// The confirmation before a list row is deleted (DESIGN §12 "AlertDialog"). The row's trash icon only
// reports the document; nothing is deleted until "מחק" here. A draft never had a number and goes for
// good; an issued document is closed — its number stays used and, for a request, the personal links
// that went to the suppliers stop answering (the route's rule, spelled out so nobody is surprised).

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { docHeading } from '@/lib/purchasing/model';
import type { DocumentListItem } from './types';

interface Props {
  /** The document to delete; null = closed. */
  doc: DocumentListItem | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function wording(doc: DocumentListItem): { title: string; description: string } {
  if (doc.status === 'draft') {
    return { title: 'למחוק את הטיוטה?', description: 'הטיוטה תימחק לצמיתות. לא הוקצה לה מספר, ולכן אין מה לשחזר.' };
  }
  const keep = 'המספר לא ישוחזר ולא ייעשה בו שימוש שוב.';
  return {
    title: `למחוק את ${docHeading(doc.doc_type, doc.number ?? 0)}?`,
    description: doc.doc_type === 'rfq' ? `${keep} הקישורים האישיים שנשלחו לספקים יפסיקו לעבוד.` : keep,
  };
}

export function DeleteDocumentDialog({ doc, busy, onCancel, onConfirm }: Props) {
  const text = doc ? wording(doc) : null;
  return (
    <AlertDialog open={doc !== null} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <AlertDialogContent dir="rtl" data-delete-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle>{text?.title}</AlertDialogTitle>
          <AlertDialogDescription>{text?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>ביטול</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm} disabled={busy} data-delete-confirm
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            מחק
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
