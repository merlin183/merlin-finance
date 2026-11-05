import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCashPlanFixedCostAddChange,buildCashPlanFixedCostChange,type FixedCostDraft} from '../lib/finance/cash-plan-series-edit';
import {buildCashPlanSeriesBreakdown,buildCashPlanSeriesMonthly,isMonthlyFixedCostEdit,type CashPlanSeries} from '../lib/finance/cash-plan-series';
import {fixedCostMemo,readFixedCostMemo} from '../lib/finance/cash-plan-series-memo';
import {cashPlanMemoDisplay,cashPlanUserMemo,mergeCashPlanUserMemo} from '../lib/finance/cash-plan-memo';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {cashPlanChangesSchema,type CashPlanEdit,type CashPlanChange} from '../lib/finance/cash-plan-edits';
import {emptyDataset,type Dataset} from '../lib/finance/types';
import {buildCashPlanFixedCostForwardAddChange,buildCashPlanFixedCostForwardChange,fixedCostForwardRequestSchema} from '../lib/finance/cash-plan-series-forward';

const businessId='10000000-0000-4000-8000-000000000001',accountId='20000000-0000-4000-8000-000000000001',secondAccount='20000000-0000-4000-8000-000000000002';
const seriesId='30000000-0000-4000-8000-000000000001',newId='40000000-0000-4000-8000-000000000001',saveId='40000000-0000-4000-8000-000000000002';
const month='2026-11',range={from:'2026-11-01',to:'2026-11-30'},asOf='2026-10-28';
const sourceKey=JSON.stringify([businessId,accountId,'Synthetic supplier']);
const series:CashPlanSeries={id:seriesId,business_id:businessId,source_type:'estimated',source_key:sourceKey,title:'Synthetic fixed plan',account_id:accountId,monthly_amount:120,start_month:month,end_month:null,day:15,kind:'operating',memo:'월 고정비 계획 · 급여 · 합성 원본',amount_overrides:{}};
const fixture=(extra:Partial<Dataset>={}):Dataset=>({...structuredClone(emptyDataset),businesses:[{id:businessId,name:'Synthetic company',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[
 {id:accountId,business_id:businessId,name:'Synthetic account',bank:'Synthetic bank',masked_number:'0001',opening_balance:1000,opening_balance_date:'2026-10-01'},
 {id:secondAccount,business_id:businessId,name:'Synthetic next account',bank:'Synthetic bank',masked_number:'0002',opening_balance:1000,opening_balance_date:'2026-10-01'},
],cash_plan_series:[series],...extra});
const draft=(extra:Partial<FixedCostDraft>={}):FixedCostDraft=>({title:'Synthetic fixed plan',amount:140,date:'2026-11-22',accountId:secondAccount,memo:'Synthetic changed note',...extra});
function persisted(change:CashPlanChange,version=1):CashPlanEdit{
 if(change.action!=='save')throw Error('Expected save');
 const {action,...values}=change;void action;
 return {...values,version,updated_at:'2026-10-28T00:00:00Z'};
}
const existingInput=(data=fixture(),edits:CashPlanEdit[]=[])=>({data,edits,businessId,month,rowId:seriesId,expectedVersion:0,expectedEditId:null,newEditId:saveId,action:'save' as const,draft:draft()});
const additionInput=(data=fixture(),edits:CashPlanEdit[]=[])=>({data,edits,businessId,month,id:newId,draft:draft({title:'Synthetic monthly extra',amount:25,date:null,accountId:null,groupLabel:'기타 고정비'})});

test('selected-month save keeps source identity and snapshot CAS while amount/date/account changes feed both views',()=>{
 const data=fixture(),before=JSON.stringify(data),input=existingInput(data),change=buildCashPlanFixedCostChange(input);
 assert.equal(change.action,'save');assert.deepEqual(buildCashPlanFixedCostChange(input),change);
 const edit=persisted(change),detail=buildCashPlanSeriesBreakdown(data,[edit],businessId,month),row=detail.includedRows[0];
 assert.equal(edit.source_type,'estimated');assert.equal(edit.source_key,sourceKey);assert.equal(edit.id,saveId);assert.equal(edit.month,month);assert.equal(change.version,0);
 assert.equal(row.currentAmount,140);assert.equal(row.date,'2026-11-22');assert.equal(row.accountId,secondAccount);assert.equal(row.groupLabel,'급여');
 assert.equal(buildCashPlanSeriesMonthly(data,[edit],month,2)[0].operatingAmount,140);assert.equal(buildCashPlanSeriesMonthly(data,[edit],month,2)[1].operatingAmount,120);
 const editable=buildEditableCashPlan(data,range,asOf,[edit]);
 for(const basis of ['estimated','registered'] as const){const view=buildCashPlanWorksheetModel({data,editable,basis,range,asOf});assert.equal(view.businesses[0].originalTotal,140);assert.equal(view.businesses[0].rows[0].date,'2026-11-22');}
 assert.equal(Object.hasOwn(change,'confirmed_amount'),false);assert.ok(cashPlanChangesSchema.safeParse({changes:[change]}).success);assert.equal(JSON.stringify(data),before);
});

test('remove saves a one-month exclusion instead of deleting an override or restoring an excluded person',()=>{
 const data=fixture(),change=buildCashPlanFixedCostChange({...existingInput(data),action:'remove',draft:undefined});
 assert.equal(change.action,'save');const edit=persisted(change);assert.equal(edit.excluded,true);assert.equal(edit.month,month);
 const detail=buildCashPlanSeriesBreakdown(data,[edit],businessId,month);
 assert.equal(detail.operatingAmount,0);assert.equal(detail.excludedRows[0].exclusionReason,'이번 달 제외');assert.equal(detail.excludedRows[0].currentAmount,120);
 assert.equal(buildCashPlanSeriesMonthly(data,[edit],month,2)[1].operatingAmount,120);
 assert.throws(()=>buildCashPlanFixedCostChange({...existingInput(data,[edit]),expectedVersion:1,expectedEditId:saveId}),/제외된/);
 assert.throws(()=>buildCashPlanFixedCostAddChange({...additionInput(data,[edit]),draft:draft({title:series.title,groupLabel:'급여'})}),/제외한 항목/);
 const global={...edit,month:'*',plan_date:null,excluded:true};
 assert.throws(()=>buildCashPlanFixedCostChange(existingInput(data,[global])),/제외된/);
 assert.equal(global.month,'*');
});

test('a fresh marked manual month is counted once even without any recurring series, and ends after that month',()=>{
 const data=fixture({cash_plan_series:[]}),input=additionInput(data),change=buildCashPlanFixedCostAddChange(input);
 assert.deepEqual(buildCashPlanFixedCostAddChange(input),change);const edit=persisted(change);
 assert.equal(edit.source_type,'manual');assert.equal(edit.id,newId);assert.equal(edit.source_key,newId);assert.equal(edit.payment_kind,'general');assert.equal(edit.version,1);
 assert.equal(isMonthlyFixedCostEdit(edit),true);assert.equal(readFixedCostMemo(edit.memo)?.groupLabel,'기타 고정비');
 const monthly=buildCashPlanSeriesMonthly(data,[edit],month,2);assert.deepEqual(monthly.map(row=>row.operatingAmount),[25,0]);assert.equal(monthly[0].registered,true);
 const detail=buildCashPlanSeriesBreakdown(data,[edit],businessId,month);assert.equal(detail.includedRows.length,1);assert.equal(detail.groups[0].amount,25);
 const editable=buildEditableCashPlan(data,range,asOf,[edit]);assert.equal(editable.items.length,1);assert.equal(editable.items[0].seriesKind,'operating');
 assert.equal(editable.estimates.businesses[0].total,25);assert.equal(editable.plan.businesses[0].expenses,25);
 assert.throws(()=>buildCashPlanFixedCostAddChange(additionInput(data,[edit])),/이미 등록/);
});

test('generic memo editing and clearing preserve the explicit classification without exposing markers',()=>{
 const edit=persisted(buildCashPlanFixedCostAddChange(additionInput()));
 assert.equal(cashPlanMemoDisplay(edit.memo),'Synthetic changed note');assert.equal(cashPlanUserMemo(edit.memo),'Synthetic changed note');
 for(const visible of ['Updated note','']){
  const memo=mergeCashPlanUserMemo(edit.memo,visible),saved={...edit,memo};
  assert.equal(readFixedCostMemo(memo)?.groupLabel,'기타 고정비');assert.equal(cashPlanMemoDisplay(memo),visible);assert.equal(cashPlanUserMemo(memo),visible);
  assert.equal(buildCashPlanSeriesMonthly(fixture(),[saved],month,1)[0].operatingAmount,145);
 }
 const pasted=mergeCashPlanUserMemo(edit.memo,`${fixedCostMemo('급여','')}\nVisible text`);
 assert.equal(readFixedCostMemo(pasted)?.groupLabel,'기타 고정비');assert.equal(cashPlanUserMemo(pasted),'Visible text');
 assert.throws(()=>mergeCashPlanUserMemo(edit.memo,'[clobe-card-bill:synthetic]'),/카드 연동/);
 assert.equal(isMonthlyFixedCostEdit({...edit,payment_kind:'tax'}),false);assert.equal(isMonthlyFixedCostEdit({...edit,payment_status:'paid'}),false);
 assert.equal(isMonthlyFixedCostEdit({...edit,memo:`[clobe-card-bill:synthetic]\n${edit.memo}`}),false);
 assert.equal(isMonthlyFixedCostEdit({...edit,confirmed_amount:10,confirmed_date:'2026-11-20',confirmation_complete:true}),true);
 assert.throws(()=>buildCashPlanFixedCostAddChange({...additionInput(),draft:draft({title:'Extra',memo:'[clobe-card-bill:synthetic]'})}),/카드 연동/);
});

test('newest identity/version is mandatory and an excluded row never becomes included through stale save',()=>{
 const data=fixture(),initial=persisted(buildCashPlanFixedCostChange(existingInput(data))),later={...initial,version:2,amount:160};
 assert.throws(()=>buildCashPlanFixedCostChange({...existingInput(data,[later]),expectedVersion:1,expectedEditId:saveId}),/다른 관리자/);
 const next=buildCashPlanFixedCostChange({...existingInput(data,[later]),expectedVersion:2,expectedEditId:saveId});
 assert.equal(next.id,saveId);assert.equal(next.version,2);
 assert.throws(()=>buildCashPlanFixedCostChange({...existingInput(data,[{...later,excluded:true}]),expectedVersion:2,expectedEditId:saveId}),/제외된/);
});

test('invalid dates, foreign accounts, duplicate additions and payment metadata cannot enter a fixed-cost save',()=>{
 const data=fixture();
 for(const patch of [{date:'2026-12-01'},{date:'2026-11-31'},{amount:-1},{title:''},{accountId:'20000000-0000-4000-8000-000000000009'}])assert.throws(()=>buildCashPlanFixedCostAddChange({...additionInput(data),draft:draft({title:'Extra',...patch})}));
 assert.throws(()=>buildCashPlanFixedCostAddChange({...additionInput(data),draft:draft({title:series.title})}),/같은 이름/);
 assert.throws(()=>buildCashPlanFixedCostAddChange({...additionInput(data),draft:{...draft({title:'Extra'}),confirmed_amount:10} as FixedCostDraft}),/Unrecognized|입력/);
 const base=persisted(buildCashPlanFixedCostChange(existingInput(data)));
 assert.throws(()=>buildCashPlanFixedCostChange({...existingInput(data,[{...base,payment_kind:'tax'}]),expectedVersion:1,expectedEditId:saveId}),/세금 납부/);
 const manualSeries={...series,source_type:'manual' as const,source_key:seriesId};
 const marked={...base,source_type:'manual' as const,source_key:seriesId,memo:fixedCostMemo('급여',''),amount:80};
 assert.equal(buildCashPlanSeriesMonthly(fixture({cash_plan_series:[manualSeries]}),[marked],month,1)[0].operatingAmount,80);
});

test('all four initially unregistered businesses can add a monthly card bill and promote only their own item onward',()=>{
 const data=fixture({cash_plan_series:[]});
 data.businesses=Array.from({length:4},(_,index)=>({...data.businesses[0],id:`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,name:`Synthetic company ${index+1}`}));
 data.accounts=data.businesses.map((business,index)=>({...data.accounts[0],id:`20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,business_id:business.id,name:`Synthetic account ${index+1}`}));
 const before=JSON.stringify(data);
 const inputs=data.businesses.map((business,index)=>({data,edits:[],businessId:business.id,month,id:`60000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
  draft:draft({title:'Synthetic user-entered card bill',amount:10+index,date:'2026-11-21',accountId:data.accounts[index].id,groupLabel:'카드대금',memo:'Synthetic confirmed statement'})}));
 assert.ok(buildCashPlanSeriesMonthly(data,[],month,1).every(row=>!row.registered));
 const monthly=inputs.map(input=>persisted(buildCashPlanFixedCostAddChange(input)));
 for(const [index,input] of inputs.entries()){
  const detail=buildCashPlanSeriesBreakdown(data,monthly,input.businessId,month);
  assert.equal(detail.operatingAmount,10+index);assert.equal(detail.includedCount,1);assert.equal(detail.groups[0].label,'카드대금');
  assert.equal(detail.includedRows[0].accountId,data.accounts[index].id);assert.equal(detail.includedRows[0].sourceKey,input.id);
  assert.equal(monthly[index].payment_kind,'general');assert.equal(isMonthlyFixedCostEdit(monthly[index]),true);
  assert.doesNotMatch(monthly[index].memo,/clobe-card-bill/);
  const otherAccount=data.accounts[(index+1)%data.accounts.length].id;
  assert.throws(()=>buildCashPlanFixedCostAddChange({...input,draft:{...input.draft,accountId:otherAccount}}),/선택한 사업자/);
  assert.throws(()=>buildCashPlanFixedCostForwardAddChange({...input,draft:{...input.draft,accountId:otherAccount}}),/선택한 사업자/);
 }
 const monthlyRows=buildCashPlanSeriesMonthly(data,monthly,month,2);
 assert.equal(monthlyRows.length,8);assert.equal(new Set(monthlyRows.map(row=>`${row.businessId}:${row.month}`)).size,8);
 assert.deepEqual(monthlyRows.map(row=>row.operatingAmount),[10,0,11,0,12,0,13,0]);
 const requests=inputs.map((input,index)=>buildCashPlanFixedCostForwardChange({...input,edits:monthly,rowId:input.id,expectedVersion:1,expectedEditId:input.id,expectedSeriesVersion:0,action:'save',draft:{...input.draft,amount:20+index}}));
 assert.ok(requests.every(request=>fixedCostForwardRequestSchema.safeParse(request).success&&request.expected_series_version===0));
 const promoted:Dataset={...data,cash_plan_series:requests.map(request=>({id:request.series_id,business_id:request.business_id,source_type:'manual',source_key:request.series_id,title:request.change.title,monthly_amount:request.change.amount,start_month:month,end_month:null,day:request.day,account_id:request.change.account_id,memo:request.change.memo,kind:'operating',amount_overrides:{},version:1}))};
 const saved=requests.map(request=>persisted(request.change,2)),next=buildCashPlanSeriesMonthly(promoted,saved,month,2);
 assert.deepEqual(next.map(row=>row.operatingAmount),[20,20,21,21,22,22,23,23]);
 for(const business of data.businesses){
  const detail=buildCashPlanSeriesBreakdown(promoted,saved,business.id,month),view=buildEditableCashPlan(promoted,range,asOf,saved);
  assert.equal(detail.includedCount,1);assert.equal(detail.groups[0].label,'카드대금');assert.equal(view.items.filter(item=>item.businessId===business.id).length,1);
  assert.equal(view.estimates.businesses.find(item=>item.business.id===business.id)?.total,detail.operatingAmount);
 }
 assert.equal(JSON.stringify(data),before);
});

test('direct card bills retain their explicit group and sorting while provider card markers remain separate',()=>{
 const data=fixture(),labels=['기타 고정비','카드대금','정기 서비스·구독'];
 const edits=labels.map((groupLabel,index)=>persisted(buildCashPlanFixedCostAddChange({...additionInput(data),id:`60000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,draft:draft({title:`Synthetic ${index+1}`,amount:10,date:null,accountId:null,groupLabel})})));
 const provider={...edits[1],id:'70000000-0000-4000-8000-000000000001',source_key:'70000000-0000-4000-8000-000000000001',amount:999,memo:`[clobe-card-bill:synthetic]\n${edits[1].memo}`};
 const detail=buildCashPlanSeriesBreakdown(data,[...edits,provider],businessId,month);
 assert.deepEqual(detail.groups.map(group=>group.label),['급여','정기 서비스·구독','카드대금','기타 고정비']);
 assert.equal(detail.operatingAmount,150);assert.equal(detail.includedCount,4);assert.equal(isMonthlyFixedCostEdit(provider),false);
 assert.equal(buildCashPlanSeriesMonthly(data,[...edits,provider],month,1)[0].operatingAmount,150);
});

test('marked estimated month edits keep their CAS identity for edit and removal while unsupported onward promotion is rejected',()=>{
 const data=fixture({cash_plan_series:[]});
 const source:CashPlanEdit={id:saveId,business_id:businessId,source_type:'estimated',source_key:sourceKey,month,title:'Synthetic reviewed card bill',account_id:accountId,plan_date:'2026-11-20',amount:80,memo:fixedCostMemo('카드대금','Synthetic monthly source'),excluded:false,version:4,updated_at:'2026-10-28T00:00:00Z',confirmed_amount:30,confirmed_date:'2026-11-20',confirmation_complete:false,confirmation_memo:'Synthetic original confirmation'};
 const before=JSON.stringify(source),input={data,edits:[source],businessId,month,rowId:saveId,expectedVersion:4,expectedEditId:saveId,action:'save' as const,draft:draft({title:source.title,amount:90,date:'2026-11-21',groupLabel:'카드대금'})};
 const change=buildCashPlanFixedCostChange(input);
 assert.equal(change.action,'save');if(change.action!=='save')throw Error('Expected save');
 assert.equal(change.id,saveId);assert.equal(change.source_type,'estimated');assert.equal(change.source_key,sourceKey);assert.equal(change.version,4);assert.equal(change.month,month);
 assert.equal(change.amount,90);assert.equal(readFixedCostMemo(change.memo)?.groupLabel,'카드대금');
 assert.equal('confirmed_amount' in change,false,'Ordinary saves leave payment evidence to the preserving RPC');
 assert.equal('confirmed_date' in change,false);assert.equal('confirmation_memo' in change,false);
 assert.throws(()=>buildCashPlanFixedCostChange({...input,expectedVersion:3}),/다른 관리자/);
 const removal=buildCashPlanFixedCostChange({...input,action:'remove'});
 assert.equal(removal.action,'save');if(removal.action!=='save')throw Error('Expected save');
 assert.equal(removal.id,saveId);assert.equal(removal.source_type,'estimated');assert.equal(removal.source_key,sourceKey);assert.equal(removal.excluded,true);
 assert.throws(()=>buildCashPlanFixedCostForwardChange({...input,expectedSeriesVersion:0}),/지출계획표에서 연결한 추정 항목은 이번 달만/);
 assert.throws(()=>buildCashPlanFixedCostForwardChange({...input,action:'remove',expectedSeriesVersion:0}),/지출계획표에서 연결한 추정 항목은 이번 달만/);
 assert.equal(JSON.stringify(source),before,'Building requests must not edit stored confirmation evidence');
});
