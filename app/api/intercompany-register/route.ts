import {authenticated} from '@/lib/supabase/server';
import {intercompanyRegisterHandlers} from '@/lib/finance/intercompany-register-route';
import {syncIntercompanySheetEntry} from '@/lib/finance/intercompany-sheet';

export const maxDuration=60;
const handlers=intercompanyRegisterHandlers({authenticate:authenticated,syncEntry:syncIntercompanySheetEntry});
export const GET=handlers.GET;
export const POST=handlers.POST;
