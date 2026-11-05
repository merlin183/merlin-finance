import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCashPlanSeriesForMonth,readCashPlanSeriesRevisions,type CashPlanSeriesRevision} from '../lib/finance/cash-plan-series-revision';
import {buildCashPlanSeriesBreakdown,buildCashPlanSeriesMonthly,type CashPlanSeries} from '../lib/finance/cash-plan-series';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanFixedCostForwardChange,buildCashPlanFixedCostForwardAddChange,readFixedCostSaveResult} from '../lib/finance/cash-plan-series-forward';
import {buildCashPlanFixedCostChange} from '../lib/finance/cash-plan-series-edit';
import {fixedCostMemo} from '../lib/finance/cash-plan-series-memo';
import {emptyDataset,type Dataset} from '../lib/finance/types';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';

const b='10000000-0000-4000-8000-000000000001',a='20000000-0000-4000-8000-000000000001',sid='30000000-0000-4000-8000-000000000001',eid='40000000-0000-4000-8000-000000000001',rid='50000000-0000-4000-8000-000000000001';
const series:CashPlanSeries={id:sid,business_id:b,source_type:'estimated',source_key:JSON.stringify([b,a,'Synthetic expense']),title:'Synthetic old plan',account_id:a,monthly_amount:100,start_month:'2026-10',end_month:null,day:31,kind:'operating',memo:'월 고정비 계획 · 급여 · Synthetic source',amount_overrides:{},version:1};
const fixture=(extra:Partial<Dataset>={}):Dataset=>({...structuredClone(emptyDataset),businesses:[{id:b,name:'Synthetic company',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:a,business_id:b,name:'Synthetic account',bank:'Synthetic bank',masked_number:'0001',opening_balance:1000,opening_balance_date:'2026-10-01'}],cash_plan_series:[series],cash_plan_series_revisions:[],...extra});
const revision=(extra:Partial<CashPlanSeriesRevision>={}):CashPlanSeriesRevision=>({id:rid,business_id:b,series_id:sid,effective_month:'2026-11',title:'Synthetic next plan',monthly_amount:150,day:31,account_id:null,memo:'Synthetic revised memo',excluded:false,cancelled:false,version:1,updated_at:'2026-10-28T00:00:00Z',...extra});
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:eid,business_id:b,source_type:series.source_type,source_key:series.source_key,month:'2027-01',title:'Synthetic explicit month',account_id:a,plan_date:'2027-01-20',amount:70,memo:'Synthetic monthly exception',excluded:false,version:1,updated_at:'2026-10-28T00:00:00Z',...extra});

test('effective revisions preserve earlier months, respect monthly exceptions and ignore superseded future profiles',()=>{
 const data=fixture({cash_plan_series_revisions:[revision(),revision({id:'50000000-0000-4000-8000-000000000002',effective_month:'2026-12',monthly_amount:999,cancelled:true})]}),before=JSON.stringify(data);
 assert.equal(resolveCashPlanSeriesForMonth(series,'2026-10',data.cash_plan_series_revisions)?.amount,100);
 const rows=buildCashPlanSeriesMonthly(data,[edit()],'2026-10',4);assert.deepEqual(rows.map(row=>row.operatingAmount),[100,150,150,70]);
 const detail=buildCashPlanSeriesBreakdown(data,[],b,'2027-02');assert.equal(detail.includedRows[0].date,'2027-02-28');assert.equal(detail.includedRows[0].nominalDay,31);assert.equal(detail.includedRows[0].accountId,null);
 assert.equal(buildEditableCashPlan(data,{from:'2027-02-01',to:'2027-02-28'},'2026-10-28',[]).items[0].amount,150);
 assert.equal(JSON.stringify(data),before);
});

test('an onward exclusion remains excluded despite a later false revision and explicit future month override',()=>{
 const data=fixture({cash_plan_series_revisions:[revision({excluded:true}),revision({id:'50000000-0000-4000-8000-000000000002',effective_month:'2026-12',monthly_amount:200,excluded:false})]});
 const exception=edit({amount:999,excluded:false}),detail=buildCashPlanSeriesBreakdown(data,[exception],b,'2027-01');
 assert.equal(detail.operatingAmount,0);assert.equal(detail.excludedRows[0].exclusionReason,'이 달부터 계속 제외');assert.equal(detail.excludedRows[0].revisionExcludedFrom,'2026-11');
 const model=buildEditableCashPlan(data,{from:'2027-01-01',to:'2027-01-31'},'2026-10-28',[exception]);
 assert.equal(model.items[0].excluded,true);assert.equal(model.items[0].seriesExcludedFrom,'2026-11');assert.equal(model.estimates.businesses[0].total,0);assert.equal(model.plan.businesses[0].expenses,0);
 assert.throws(()=>buildCashPlanFixedCostChange({data,edits:[exception],businessId:b,month:'2027-01',rowId:sid,expectedEditId:eid,expectedVersion:1,action:'save',draft:{title:'Synthetic',amount:300,date:null,accountId:null,memo:''}}),/제외된/);
 assert.equal(buildCashPlanSeriesMonthly(data,[],'2026-10',1)[0].operatingAmount,100);
});

test('promoting a manual month to the same recurring source preserves old months and does not double-count the new start',()=>{
 const manualSeries={...series,source_type:'manual' as const,source_key:sid,start_month:'2026-12',monthly_amount:40,memo:fixedCostMemo('임차료','Synthetic group')};
 const old=edit({source_type:'manual',source_key:sid,month:'2026-11',amount:25,plan_date:null,memo:fixedCostMemo('임차료','Synthetic old month')});
 const data=fixture({cash_plan_series:[manualSeries]});
 const oldDetail=buildCashPlanSeriesBreakdown(data,[old],b,'2026-11');assert.equal(oldDetail.includedRows.length,1);assert.equal(oldDetail.operatingAmount,25);assert.equal(oldDetail.includedRows[0].groupLabel,'임차료');
 assert.equal(buildEditableCashPlan(data,{from:'2026-11-01',to:'2026-11-30'},'2026-10-28',[old]).estimates.businesses[0].total,25);
 const next=buildCashPlanSeriesBreakdown(data,[old],b,'2026-12');assert.equal(next.includedRows.length,1);assert.equal(next.operatingAmount,40);assert.equal(next.groups[0].label,'임차료');
});

test('forward helpers carry the full series CAS and preserve day31 when editing a short-month amount only',()=>{
 const data=fixture(),request=buildCashPlanFixedCostForwardChange({data,edits:[],businessId:b,month:'2027-02',rowId:sid,expectedVersion:0,expectedEditId:null,expectedSeriesVersion:1,newEditId:eid,action:'save',draft:{title:series.title,amount:170,date:'2027-02-28',accountId:a,memo:''}});
 assert.equal(request.day,31);assert.equal(request.change.plan_date,'2027-02-28');assert.equal(request.expected_series_version,1);
 assert.throws(()=>buildCashPlanFixedCostForwardChange({data:{...data,cash_plan_series:[{...series,version:2}]},edits:[],businessId:b,month:'2027-02',rowId:sid,expectedVersion:0,expectedEditId:null,expectedSeriesVersion:1,action:'remove'}),/다른 관리자/);
 const add=buildCashPlanFixedCostForwardAddChange({data,edits:[],businessId:b,month:'2026-11',id:eid,draft:{title:'Synthetic recurring extra',amount:30,date:null,accountId:null,memo:'',groupLabel:'기타 고정비'}});
 assert.equal(add.series_id,eid);assert.equal(add.expected_series_version,0);assert.equal(add.day,null);assert.equal(add.change.source_key,eid);
});

test('revision transport keeps the old strict series shape separate and rejects foreign or malformed snapshots',()=>{
 const data=fixture();assert.deepEqual(readCashPlanSeriesRevisions([revision()],{series:data.cash_plan_series,accounts:data.accounts}),[revision()]);
 for(const bad of [undefined,[revision({cancelled:true,excluded:true})],[revision({series_id:eid})],[revision({account_id:eid})],[revision(),revision()]])assert.throws(()=>readCashPlanSeriesRevisions(bad,{series:data.cash_plan_series,accounts:data.accounts}));
 const result=readFixedCostSaveResult({edits:[],series:[series],revisions:[revision()]});assert.equal(result.series[0].version,1);assert.equal(result.revisions[0].effective_month,'2026-11');
 assert.throws(()=>readFixedCostSaveResult({edits:[],series:[series]}));
});
