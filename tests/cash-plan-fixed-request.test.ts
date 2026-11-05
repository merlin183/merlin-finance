import test from 'node:test';
import assert from 'node:assert/strict';
import {requestFixedCostSave,FixedCostRequestError} from '../lib/finance/cash-plan-fixed-request';
import {mergeFixedCostResult,createDatasetUpdates} from '../lib/finance/dataset-updates';
import {emptyDataset} from '../lib/finance/types';
import type {FixedCostForwardRequest,FixedCostSaveResult} from '../lib/finance/cash-plan-series-forward';

const business='10000000-0000-4000-8000-000000000001',seriesId='20000000-0000-4000-8000-000000000001',revisionId='30000000-0000-4000-8000-000000000001';
const request:FixedCostForwardRequest={scope:'from-month',business_id:business,month:'2027-04',series_id:seriesId,expected_series_version:1,day:15,change:{action:'save',id:'40000000-0000-4000-8000-000000000001',business_id:business,source_type:'estimated',source_key:'synthetic-source',month:'2027-04',title:'Synthetic fixed cost',account_id:null,plan_date:'2027-04-15',amount:100,memo:'',excluded:false,version:0}};
const saved:FixedCostSaveResult={edits:[],series:[{id:seriesId,business_id:business,source_type:'estimated',source_key:'synthetic-source',title:'Synthetic fixed cost',account_id:null,monthly_amount:100,start_month:'2027-04',end_month:null,day:15,kind:'operating',memo:'',amount_overrides:{},version:2}],revisions:[{id:revisionId,business_id:business,series_id:seriesId,effective_month:'2027-04',title:'Synthetic revision',monthly_amount:120,day:16,account_id:null,memo:'',excluded:false,cancelled:false,version:1,updated_at:'2027-03-01T00:00:00Z'}]};

test('recurring save sends one same-origin no-store mutation and reads the atomic response',async()=>{
 let calls=0;
 const before=JSON.stringify(request);
 const fetcher:typeof fetch=async(url,options)=>{
  calls++;assert.equal(url,'/api/cash-plan/fixed-costs');assert.equal(options?.method,'POST');assert.equal(options?.cache,'no-store');
  assert.deepEqual(JSON.parse(String(options?.body)),request);assert.deepEqual(options?.headers,{'Content-Type':'application/json'});
  return Response.json(saved);
 };
 const result=await requestFixedCostSave(request,fetcher);
 assert.equal(result.series[0].version,2);assert.equal(result.revisions[0].monthly_amount,120);assert.equal(calls,1);assert.equal(JSON.stringify(request),before);
});

test('authentication, conflict and malformed success responses preserve request and never report success',async()=>{
 const before=JSON.stringify(request);
 for(const status of [401,403,409,400])await assert.rejects(()=>requestFixedCostSave(request,async()=>Response.json({error:'Synthetic failure'},{status})),error=>error instanceof FixedCostRequestError&&error.status===status);
 for(const response of [new Response('not JSON'),Response.json({edits:[],series:[]}),Response.json({...saved,revisions:[{...saved.revisions[0],monthly_amount:-1}]})])await assert.rejects(()=>requestFixedCostSave(request,async()=>response),/최신 계획을 다시 불러와/);
 assert.equal(JSON.stringify(request),before);
 let calls=0;
 await assert.rejects(()=>requestFixedCostSave(request,async()=>{calls++;throw Error('Synthetic transport failure');}),/Synthetic transport failure/);
 assert.equal(calls,1,'an ambiguous network response must not automatically retry a financial plan mutation');
});

test('saved recurrence merges immediately without altering transactions and survives an older in-flight read',()=>{
 const data={...structuredClone(emptyDataset),cash_plan_series:[],cash_plan_series_revisions:[]};
 const merged=mergeFixedCostResult(data,saved);
 assert.equal(merged.transactions,data.transactions);assert.equal(merged.cash_plan_series?.[0].version,2);assert.equal(merged.cash_plan_series_revisions?.[0].monthly_amount,120);
 const updates=createDatasetUpdates(),read=updates.beginRead();updates.record(current=>mergeFixedCostResult(current,saved));
 assert.equal(read.apply(data).cash_plan_series?.[0].version,2);assert.equal(read.apply(data).cash_plan_series_revisions?.length,1);read.finish();
 assert.equal(data.cash_plan_series.length,0);
});

test('a newer recurrence snapshot and cancelled revisions cannot be overwritten by an older save response',()=>{
 const newer={...structuredClone(emptyDataset),cash_plan_series:[{...saved.series[0],version:3}],cash_plan_series_revisions:[{...saved.revisions[0],cancelled:true,version:2}]};
 const merged=mergeFixedCostResult(newer,saved);
 assert.equal(merged.cash_plan_series?.[0].version,3);assert.equal(merged.cash_plan_series_revisions?.[0].cancelled,true);assert.equal(merged.cash_plan_series_revisions?.[0].version,2);
});
