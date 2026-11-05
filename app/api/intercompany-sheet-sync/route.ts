import {authenticated} from '@/lib/supabase/server';
import {intercompanySheetSyncHandlers} from '@/lib/finance/intercompany-sheet-sync-route';
import {readIntercompanySheetSource,stampIntercompanySourceIdentifiers,reconcileIntercompanySourceRows,normalizeIntercompanySourceFormulas,syncIntercompanySheetEntry} from '@/lib/finance/intercompany-sheet';

export const maxDuration=180;
export const POST=intercompanySheetSyncHandlers({authenticate:authenticated,readSource:readIntercompanySheetSource,stampIdentifiers:stampIntercompanySourceIdentifiers,reconcileSource:reconcileIntercompanySourceRows,normalizeFormulas:normalizeIntercompanySourceFormulas,syncEntry:syncIntercompanySheetEntry}).POST;
