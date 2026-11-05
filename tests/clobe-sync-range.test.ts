import test from 'node:test';
import assert from 'node:assert/strict';
import {clobeSyncRange} from '../lib/finance/clobe-sync-range';
import {clobeSyncMonthRange} from '../lib/clobe/import-service';

test('recent bank synchronization uses last month and the current Seoul day',()=>{
 assert.deepEqual(clobeSyncRange(Date.parse('2026-10-14T04:00:00Z')),{from:'2026-09-01',to:'2026-10-14',months:['2026-09','2026-10']});
 assert.deepEqual(clobeSyncRange(Date.parse('2026-09-30T14:59:59Z')),{from:'2026-08-01',to:'2026-09-30',months:['2026-08','2026-09']});
 assert.deepEqual(clobeSyncRange(Date.parse('2026-09-30T15:00:00Z')),{from:'2026-09-01',to:'2026-10-01',months:['2026-09','2026-10']});
});

test('January crosses the year boundary and month ends remain valid for leap years',()=>{
 const now=Date.parse('2026-01-05T12:00:00+09:00');
 assert.deepEqual(clobeSyncRange(now),{from:'2025-12-01',to:'2026-01-05',months:['2025-12','2026-01']});
 assert.deepEqual(clobeSyncMonthRange('2025-12',now),{start_date:'2025-12-01',end_date:'2025-12-31'});
 assert.deepEqual(clobeSyncMonthRange('2028-02',Date.parse('2028-03-03T12:00:00+09:00')),{start_date:'2028-02-01',end_date:'2028-02-29'});
});

test('invalid clock values and automatic months outside the two-month window are rejected',()=>{
 for(const now of [NaN,Infinity,-Infinity,Number.MAX_VALUE])assert.throws(()=>clobeSyncRange(now),/기준 날짜/);
 const now=Date.parse('2026-10-14T12:00:00+09:00');
 for(const month of ['2026-08','2026-11','2025-12','2026-9','2026-13'])assert.throws(()=>clobeSyncMonthRange(month,now),{code:'invalid_request'});
});
