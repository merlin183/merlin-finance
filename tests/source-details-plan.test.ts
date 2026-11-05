import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSourceDetailsPlan} from '../lib/finance/source-details-plan';
import {emptyDataset,type Transaction} from '../lib/finance/types';
import type {SheetMergeRow} from '../lib/finance/sheet-merge';
import {noteSubject} from '../lib/finance/merchant-notes';

const url='https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrst/edit';
const row=(changes:Partial<Transaction>={}):Transaction=>({id:'one',business_id:'biz',account_id:'bank',upload_id:'upload',txn_date:'2026-08-31',txn_time:null,amount:500,direction:'in',description:'급여',raw_gwamok:'미매핑',category_id:'unmapped',balance:1000,tax_invoice:false,is_internal:false,dedup_hash:'original',manually_classified:true,...changes});
const source=(changes:Partial<SheetMergeRow>={}):SheetMergeRow=>({account_id:'bank',sheet:'은행',source_row:4,txn_date:'2026-08-31',txn_time:null,amount:500,direction:'in',description:'지원금 입금',raw_gwamok:'지원금',category_id:'grant',balance:1000,tax_invoice:false,is_internal:false,dedup_hash:'other',manually_classified:false,provided:{category:true,balance:true,time:false,tax:false},source_details:{basic:'지원금 8월',detail:'지역 사업 지원'},...changes});

test('supplements a unique bank match while preserving original identity, classifications and financial values',async()=>{
 const previous=row(),data={...emptyDataset,transactions:[previous]};
 const before=structuredClone(data),plan=await buildSourceDetailsPlan(data,[source()],'source',url);
 assert.deepEqual(plan.summary,{updated:1,unchanged:0,unmatched:0,ambiguous:0});
 assert.deepEqual(Object.keys(plan.changes[0]).sort(),['expected','id','source_details']);
 const updated={...previous,source_details:plan.changes[0].source_details};
 assert.deepEqual(noteSubject(updated),noteSubject(previous));
 assert.equal(updated.description,'급여');assert.equal(updated.category_id,'unmapped');assert.equal(updated.dedup_hash,'original');assert.equal(updated.upload_id,'upload');
 assert.deepEqual(updated.source_details.provenance,{sheet:'은행',row:4,url});
 assert.deepEqual(data,before);
 const replay=await buildSourceDetailsPlan({...data,transactions:[updated]},[source()],'source',url);
 assert.equal(replay.summary.unchanged,1);assert.equal(replay.changes.length,0);
});

test('requires matching balance or time and rejects conflicting evidence',async()=>{
 for(const [old,next] of [
  [row({balance:null}),source({balance:null})],
  [row({balance:900}),source()],
  [row({txn_time:'10:00:01'}),source({txn_time:'10:00:02'})],
 ] as const){const plan=await buildSourceDetailsPlan({...emptyDataset,transactions:[old]},[next],'source',url);assert.equal(plan.changes.length,0);}
 const timeOnly=await buildSourceDetailsPlan({...emptyDataset,transactions:[row({balance:null,txn_time:'10:00:01'})]},[source({balance:null,txn_time:'10:00:01'})],'source',url);
 assert.equal(timeOnly.summary.updated,1);
});

test('never crosses account, date, amount or direction',async()=>{
 for(const override of [{account_id:'other'},{txn_date:'2026-08-30'},{amount:501},{direction:'out' as const}]){
  const plan=await buildSourceDetailsPlan({...emptyDataset,transactions:[row()]},[source(override)],'source',url);assert.equal(plan.changes.length,0);
 }
});

test('ambiguous matches in either source or saved transactions are left alone',async()=>{
 const sourceDuplicates=await buildSourceDetailsPlan({...emptyDataset,transactions:[row()]},[source(),source({source_row:5})],'source',url);
 assert.equal(sourceDuplicates.summary.ambiguous,1);assert.equal(sourceDuplicates.changes.length,0);
 const savedDuplicates=await buildSourceDetailsPlan({...emptyDataset,transactions:[row(),row({id:'two'})]},[source()],'source',url);
 assert.equal(savedDuplicates.summary.ambiguous,2);assert.equal(savedDuplicates.changes.length,0);
});

test('blank source details preserve previous fields and provenance-only rows are ignored',async()=>{
 const old=row({source_details:{counterparty:'명시된 송금인',detail:'저장된 상세'}});
 const plan=await buildSourceDetailsPlan({...emptyDataset,transactions:[old]},[source({source_details:{basic:'지원금',detail:' '}})],'source',url);
 assert.equal(plan.changes[0].source_details.counterparty,'명시된 송금인');assert.equal(plan.changes[0].source_details.detail,'저장된 상세');
 const noText=await buildSourceDetailsPlan({...emptyDataset,transactions:[old]},[source({source_details:{provenance:{sheet:'은행',row:4}}})],'source',url);
 assert.equal(noText.changes.length,0);
});

test('review hash changes when either financial snapshot or source metadata changes',async()=>{
 const build=(old:Transaction,next:SheetMergeRow)=>buildSourceDetailsPlan({...emptyDataset,transactions:[old]},[next],'source',url);
 const initial=await build(row(),source());
 assert.notEqual(initial.planHash,(await build(row({category_id:'reviewed'}),source())).planHash);
 assert.notEqual(initial.planHash,(await build(row(),source({source_details:{basic:'원본 수정'}}))).planHash);
});
