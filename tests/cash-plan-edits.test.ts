import assert from 'node:assert/strict';
import test from 'node:test';
import {cashPlanChangesSchema} from '../lib/finance/cash-plan-edits';

const saved={action:'save' as const,id:'10000000-0000-4000-8000-000000000001',business_id:'20000000-0000-4000-8000-000000000001',source_type:'estimated' as const,source_key:'synthetic-group',month:'2026-10',title:'Synthetic expense',account_id:null,plan_date:'2026-10-15',amount:100,memo:'',excluded:false,version:0};
const valid=(change:unknown)=>cashPlanChangesSchema.safeParse({changes:[change]}).success;

test('cash plan edit validation accepts monthly changes and global exclusions',()=>{
 assert.ok(valid(saved));
 assert.ok(valid({...saved,month:'*',plan_date:null,excluded:true}));
 assert.ok(valid({...saved,source_type:'manual',source_key:saved.id,plan_date:null}));
 assert.ok(valid({action:'delete',id:saved.id,version:1}));
});

test('cash plan edit validation rejects impossible dates, cross-month dates and unsafe amounts',()=>{
 for(const patch of [{plan_date:'2026-02-30',month:'2026-02'},{plan_date:'2026-11-01'},{month:'2026-13'},{amount:-1},{amount:0.5},{amount:Number.MAX_SAFE_INTEGER+1},{title:'  '},{memo:'x'.repeat(2001)},{version:-1}])assert.equal(valid({...saved,...patch}),false);
});

test('category memo metadata accepts one valid marker and rejects duplicate malformed or unknown versions',()=>{
 const marker='[cash-plan-category:v1:30000000-0000-4000-8000-000000000001]';
 assert.equal(valid({...saved,memo:marker+'\nSynthetic user note'}),true);
 for(const memo of [marker+'\n'+marker,'[cash-plan-category:v1:broken]',marker.replace(':v1:',':v2:'),'[cash-plan-category]','Note '+marker])assert.equal(valid({...saved,memo}),false);
});

test('global edits only exclude existing sources, and payload cannot spoof ownership',()=>{
 assert.equal(valid({...saved,month:'*',plan_date:null}),false);
 assert.equal(valid({...saved,month:'*',excluded:true}),false);
 assert.equal(valid({...saved,month:'*',plan_date:null,excluded:true,source_type:'manual',source_key:saved.id}),false);
 assert.equal(valid({...saved,owner_id:saved.business_id}),false);
 assert.equal(valid({...saved,source_type:'registered'}),false);
 assert.equal(valid({action:'delete',id:saved.id,version:0}),false);
});

test('cash plan batches reject duplicate ids or duplicate original month and large batches',()=>{
 assert.equal(cashPlanChangesSchema.safeParse({changes:[saved,saved]}).success,false);
 assert.equal(cashPlanChangesSchema.safeParse({changes:[saved,{...saved,id:'10000000-0000-4000-8000-000000000002'}]}).success,false);
 assert.equal(cashPlanChangesSchema.safeParse({changes:[]}).success,false);
 assert.equal(cashPlanChangesSchema.safeParse({changes:Array.from({length:101},()=>saved)}).success,false);
});

test('tax metadata requires a dated one-time manual obligation and payment action uses a saved version',()=>{
 const tax={...saved,source_type:'manual',source_key:saved.id,payment_kind:'tax',payment_status:'pending'};
 assert.ok(valid(tax));
 assert.ok(valid({...tax,payment_status:'paid'}));
 for(const patch of [{plan_date:null},{source_type:'estimated'},{source_type:'registered'},{amount:0}])assert.equal(valid({...tax,...patch}),false);
 assert.equal(valid({...saved,payment_kind:'general',payment_status:'paid'}),false);
 assert.ok(valid({action:'payment_status',id:saved.id,version:1,payment_status:'paid'}));
 assert.ok(valid({action:'payment_status',id:saved.id,version:2,payment_status:'pending'}));
 assert.equal(valid({action:'payment_status',id:saved.id,version:0,payment_status:'paid'}),false);
 assert.equal(valid({action:'payment_status',id:saved.id,version:1,payment_status:'paid',amount:100}),false);
 const parsed=cashPlanChangesSchema.parse({changes:[saved]});
 assert.equal('payment_kind' in parsed.changes[0],false,'omitted metadata must reach the database as omission, not a default reset');
});

test('payment confirmation API accepts explicit return metadata and rejects malformed or future credit evidence',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,13,0,0,0)});
 const payment={...saved,action:'payment_confirmation',confirmed_amount:80,confirmed_date:'2026-10-10',confirmation_complete:false,confirmation_memo:'Receipt checked'};
 const marker=(value:unknown,version='v1')=>`[cash-plan-return:${version}:${encodeURIComponent(JSON.stringify(value))}]`;
 const explicit=marker({amount:30,date:'2026-10-12'})+'\nReceipt checked';
 assert.equal(valid(payment),true);assert.equal(valid({...payment,confirmation_memo:explicit}),true);
 assert.equal(cashPlanChangesSchema.parse({changes:[{...payment,confirmation_memo:explicit}]}).changes[0].action,'payment_confirmation');
 const invalid=[marker({amount:30,date:'2026-10-14'}),marker({amount:81,date:'2026-10-12'}),marker({amount:-1,date:'2026-10-12'}),marker({amount:30,date:'2026-09-30'}),marker({amount:30,date:'2026-10-32'}),marker({amount:30,date:'2026-10-12'},'v2'),'[cash-plan-return:v1:bad-json]',explicit+'\n'+marker({amount:30,date:'2026-10-12'})];
 for(const memo of invalid){
  const parsed=cashPlanChangesSchema.safeParse({changes:[{...payment,confirmation_memo:memo}]});
  assert.equal(parsed.success,false);
  if(!parsed.success)assert.ok(parsed.error.issues.some(issue=>issue.path.at(-1)==='confirmation_memo'));
 }
});
