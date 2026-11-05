import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buildCashPlanFixedSyncChanges} from '../lib/finance/cash-plan-fixed-sync';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {cashPlanChangesSchema,type CashPlanChange,type CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {fixedCostMemo,readFixedCostMemo} from '../lib/finance/cash-plan-series-memo';
import type {CashPlanSeries} from '../lib/finance/cash-plan-series';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import {CashPlanSeriesSummary} from '../components/finance/cash-plan-series-summary';

const bid='10000000-0000-4000-8000-000000000001',otherBid='10000000-0000-4000-8000-000000000002';
const aid='20000000-0000-4000-8000-000000000001',otherAid='20000000-0000-4000-8000-000000000002';
const month='2026-11',asOf='2026-11-20',range={from:'2026-11-01',to:'2026-11-30'};
const id=(n:number)=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ids=()=>{let n=100;return()=>id(n++);};
const tx=(date:string,description='Synthetic cloud',amount=100,extra:Partial<Transaction>={}):Transaction=>({id:`${date}-${description}`,business_id:bid,account_id:aid,txn_date:date,amount,balance:null,direction:'out',description,upload_id:null,raw_gwamok:'',category_id:'fee',is_internal:false,tax_invoice:false,dedup_hash:`${date}-${description}`,manually_classified:false,...extra});
const history=(description='Synthetic cloud',amount=100)=>['08','09','10'].map(m=>tx(`2026-${m}-15`,description,amount));
const fixture=(extra:Partial<Dataset>={}):Dataset=>({...structuredClone(emptyDataset),
 businesses:[{id:bid,name:'Synthetic company',representative:'',kind:'법인',reserve:0,color:'#123456'},{id:otherBid,name:'Other synthetic company',representative:'',kind:'법인',reserve:0,color:'#654321'}],
 accounts:[{id:aid,business_id:bid,name:'Synthetic account',bank:'Synthetic bank',masked_number:'0001',opening_balance:1000,opening_balance_date:'2026-10-31'},{id:otherAid,business_id:otherBid,name:'Other synthetic account',bank:'Synthetic bank',masked_number:'0002',opening_balance:1000,opening_balance_date:'2026-10-31'}],
 categories:[{id:'fee',name:'지급수수료',group_name:'영업비용',is_internal:false,is_operating:true}],transactions:history(),...extra});
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:id(1),business_id:bid,source_type:'manual',source_key:id(1),month,title:'Synthetic manual item',amount:200,account_id:null,plan_date:'2026-11-20',memo:'Synthetic note',excluded:false,version:2,updated_at:'2026-10-29T00:00:00Z',...extra});
const apply=(edits:CashPlanEdit[],changes:CashPlanChange[])=>{
 const result=structuredClone(edits);
 for(const change of changes){assert.equal(change.action,'save');if(change.action!=='save')continue;const {action,...value}=change;void action;const index=result.findIndex(row=>row.id===change.id);const next={...(index>=0?result[index]:{}),...value,version:change.version+1,updated_at:'2026-10-29T01:00:00Z'} as CashPlanEdit;if(index>=0)result[index]=next;else result.push(next);}
 return result;
};
const budget=(data:Dataset,edits:CashPlanEdit[],selected=range)=>{const editable=buildEditableCashPlan(data,selected,asOf,edits);return buildCashPlanWorksheetModel({data,editable,basis:'estimated',range:selected,asOf}).businesses.map(business=>({businessId:business.businessId,rows:business.rows.map(row=>({title:row.title,key:row.key,date:row.date,account:row.accountId,amount:row.originalAmount,remaining:row.remainingAmount,recorded:row.recordedAmount})),total:business.originalTotal}));};

test('sync enrolls exact monthly sources once with whole budgets and preserves saved ids, versions and payment evidence',()=>{
 const key=cashEstimateSourceKey(history()[0]);
 const saved=edit({source_type:'estimated',source_key:key,account_id:aid,title:'Edited synthetic cloud',amount:250,plan_date:null,confirmed_amount:80,confirmed_date:'2026-11-05',confirmation_complete:false,confirmation_memo:'Synthetic confirmation'});
 const manual=edit({id:id(2),source_key:id(2),title:'신용카드 결제대금'});
 const data=fixture({transactions:[...history(),tx('2026-11-05','Synthetic cloud',80)]}),before=JSON.stringify({data,edits:[saved,manual]});
 const result=buildCashPlanFixedSyncChanges({data,edits:[saved,manual],month,asOf,createId:ids()});
 assert.equal(result.changes.length,2);assert.ok(cashPlanChangesSchema.safeParse({changes:result.changes}).success);
 const forecast=result.changes.find(change=>change.id===saved.id)!;assert.equal(forecast.action,'save');if(forecast.action!=='save')return;
 assert.equal(forecast.version,2);assert.equal(forecast.source_type,'estimated');assert.equal(forecast.source_key,key);assert.equal(forecast.amount,250);assert.equal(forecast.plan_date,null);
 assert.equal(Object.hasOwn(forecast,'confirmed_amount'),false);assert.equal(Object.hasOwn(forecast,'confirmed_date'),false);assert.equal(Object.hasOwn(forecast,'confirmation_complete'),false);
 assert.equal(readFixedCostMemo(forecast.memo)?.groupLabel,'지급수수료');
 const card=result.changes.find(change=>change.id===manual.id);assert.equal(card?.action,'save');if(card?.action==='save')assert.equal(readFixedCostMemo(card.memo)?.groupLabel,'카드대금');
 const applied=apply([saved,manual],result.changes),persisted=applied.find(row=>row.id===saved.id)!;
 assert.equal(persisted.confirmed_amount,80);assert.equal(persisted.confirmed_date,saved.confirmed_date);assert.equal(persisted.confirmation_complete,false);assert.equal(persisted.confirmation_memo,saved.confirmation_memo);
 assert.deepEqual(budget(data,[saved,manual]),budget(data,applied));
 assert.equal(buildCashPlanFixedSyncChanges({data,edits:applied,month,asOf,createId:ids()}).changes.length,0);
 assert.equal(JSON.stringify({data,edits:[saved,manual]}),before);
});

test('new estimated enrollment retains its source instead of duplicating a manual expense and is limited to its selected month',()=>{
 const data=fixture(),before=budget(data,[]),dec={from:'2026-12-01',to:'2026-12-31'},oct={from:'2026-10-01',to:'2026-10-31'};
 const result=buildCashPlanFixedSyncChanges({data,edits:[],month,asOf,createId:ids()});assert.equal(result.changes.length,1);
 const change=result.changes[0];assert.equal(change.action,'save');if(change.action!=='save')return;
 assert.equal(change.source_type,'estimated');assert.equal(change.source_key,cashEstimateSourceKey(history()[0]));assert.equal(change.version,0);assert.equal(change.amount,100);assert.equal(change.month,month);
 const applied=apply([],result.changes);assert.deepEqual(budget(data,applied),before);assert.deepEqual(budget(data,applied,dec),budget(data,[],dec));assert.deepEqual(budget(data,applied,oct),budget(data,[],oct));
 assert.equal(data.cash_plan_series,undefined);
});

test('existing recurrence, installments, excluded rows, tax and provider card records are never re-enrolled or restored',()=>{
 const key=cashEstimateSourceKey(history()[0]),sid=id(20),installmentId=id(21);
 const series:CashPlanSeries={id:sid,business_id:bid,source_type:'estimated',source_key:key,title:'Synthetic recurring service',account_id:aid,monthly_amount:100,start_month:month,end_month:null,day:15,kind:'operating',memo:'',amount_overrides:{}};
 const installment:CashPlanSeries={...series,id:installmentId,source_type:'manual',source_key:installmentId,title:'Synthetic finite installment',kind:'installment',monthly_amount:30,end_month:'2027-01'};
 const data=fixture({cash_plan_series:[series,installment]});
 const edits=[edit({excluded:true}),edit({id:id(3),source_key:id(3),title:'Synthetic tax',payment_kind:'tax',payment_status:'pending'}),edit({id:id(4),source_key:id(4),title:'Synthetic paid tax',payment_kind:'tax',payment_status:'paid'}),edit({id:id(5),source_key:id(5),title:'Synthetic provider bill',memo:'[clobe-card-bill:synthetic]\nProvider note'})];
 const before=JSON.stringify({data,edits}),result=buildCashPlanFixedSyncChanges({data,edits,month,asOf,createId:ids()});assert.equal(result.changes.length,0);assert.equal(JSON.stringify({data,edits}),before);
});

test('business selection isolates changes and mismatched effective or source accounts abort before saving',()=>{
 const other=edit({id:id(8),source_key:id(8),business_id:otherBid,account_id:otherAid,title:'Other synthetic item'}),data=fixture();
 const changes=buildCashPlanFixedSyncChanges({data,edits:[other],month,asOf,businessId:bid,createId:ids()}).changes;
 assert.equal(changes.length,1);assert.ok(changes.every(change=>change.action==='save'&&change.business_id===bid));
 assert.throws(()=>buildCashPlanFixedSyncChanges({data,edits:[],month,asOf,businessId:'unknown',createId:ids()}),/사업자/);
 const wrongEffective=edit({account_id:otherAid});assert.throws(()=>buildCashPlanFixedSyncChanges({data,edits:[wrongEffective],month,asOf,createId:ids()}),/계좌/);
 const wrongKey=JSON.stringify([bid,otherAid,'description:synthetic']);assert.throws(()=>buildCashPlanFixedSyncChanges({data,edits:[edit({source_type:'estimated',source_key:wrongKey,account_id:aid})],month,asOf,createId:ids()}),/계좌/);
});

test('classification uses explicit categories, card or loan labels and does not infer a person’s purpose',()=>{
 const data=fixture({transactions:[]}),edits=[edit({title:'Synthetic person'}),edit({id:id(2),source_key:id(2),title:'중진공대출원리'}),edit({id:id(3),source_key:id(3),title:'기업bc카드대금'})];
 const changes=buildCashPlanFixedSyncChanges({data,edits,month,asOf,createId:ids()}).changes;
 const groups:[string,string|undefined][]=changes.flatMap(change=>change.action==='save'?[[change.title,readFixedCostMemo(change.memo)?.groupLabel] as [string,string|undefined]]:[]);
 assert.deepEqual(new Map(groups),new Map([['Synthetic person','기타 계획'],['중진공대출원리','대출원리금'],['기업bc카드대금','카드대금']]));
 const marked=edit({memo:fixedCostMemo('사용자 분류','Synthetic note')});assert.equal(buildCashPlanFixedSyncChanges({data,edits:[marked],month,asOf,createId:ids()}).changes.length,0);
});

test('sync uses one atomic batch and rejects a batch exceeding the API limit',()=>{
 const edits=Array.from({length:101},(_,index)=>edit({id:id(index+1),source_key:id(index+1),title:`Synthetic manual ${index}`}));
 assert.throws(()=>buildCashPlanFixedSyncChanges({data:fixture({transactions:[]}),edits,month,asOf,createId:ids()}),/100건/);
});

test('sync button identifies the exact month and blocks saving while loading or reports a save error',()=>{
 const base={rows:[{businessId:bid,businessName:'Synthetic company',month,operatingAmount:100,installmentAmount:0,total:100,notes:[]}],fromMonth:month,selectedMonth:month,onMonthChange:()=>{},onSelectMonth:()=>{},onOpenBreakdown:()=>{}};
 const ready=renderToStaticMarkup(createElement(CashPlanSeriesSummary,{...base,onSync:()=>{}}));assert.match(ready,/aria-label="2026년 11월 지출계획표 반영"/);assert.match(ready,/이 달 고정비에만 반영합니다/);
 const pending=renderToStaticMarkup(createElement(CashPlanSeriesSummary,{...base,onSync:()=>{},syncing:true,syncError:'Synthetic save error'}));assert.match(pending,/<button(?=[^>]*aria-label="2026년 11월 지출계획표 반영")(?=[^>]*disabled="")[^>]*>/);assert.match(pending,/반영 중…/);assert.match(pending,/role="alert">Synthetic save error/);
});
