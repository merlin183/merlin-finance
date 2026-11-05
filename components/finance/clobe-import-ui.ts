import type {ClobeDashboardSyncSnapshot} from '@/lib/finance/clobe-dashboard-sync-client';
import {clobeDashboardSyncBusy} from './clobe-dashboard-sync-display';

/** A saved run awaiting its read retry must not start another import write. */
export function clobeManualImportSyncBlocked(phase?:ClobeDashboardSyncSnapshot['phase']){
 return phase==='refresh-needed'||clobeDashboardSyncBusy(phase??'idle');
}
