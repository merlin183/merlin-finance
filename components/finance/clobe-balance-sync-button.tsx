"use client";

import type {Dataset} from '@/lib/finance/types';
import {ClobeDashboardSyncButton} from './use-clobe-dashboard-sync';

// Keep the cash-view contract while every entry uses the shared coordinator.
export function ClobeBalanceSyncButton({accounts}: {refresh:()=>Promise<void>;accounts:Dataset['accounts']}){
 return <ClobeDashboardSyncButton disabled={!accounts.length} showStatus/>;
}
