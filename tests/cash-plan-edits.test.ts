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
