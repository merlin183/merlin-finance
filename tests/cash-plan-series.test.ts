import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCashPlanSeriesMonthly,buildCashPlanSeriesBreakdown,cashPlanSeriesDate,isMonthlyFixedCostEdit,readCashPlanSeries,type CashPlanSeries} from '../lib/finance/cash-plan-series';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildMonthlyReport} from '../lib/finance/monthly-report';
import {fixedCostMemo} from '../lib/finance/cash-plan-series-memo';
import {mergeCashPlanCategory} from '../lib/finance/cash-plan-category';

const bid='10000000-0000-4000-8000-000000000001',aid='20000000-0000-4000-8000-000000000001';
const sid='30000000-0000-4000-8000-000000000001',iid='30000000-0000-4000-8000-000000000002';
const transaction=(month:string,amount=100):Transaction=>({id:`tx-${month}`,business_id:bid,account_id:aid,txn_date:`2026-${month}-15`,amount,balance:null,direction:'out',description:'Synthetic supplier',upload_id:null,raw_gwamok:'',category_id:'fee',is_internal:false,tax_invoice:false,dedup_hash:`tx-${month}`,manually_classified:false});
const key=cashEstimateSourceKey(transaction('07'));
const series=(extra:Partial<CashPlanSeries>={}):CashPlanSeries=>({id:sid,business_id:bid,source_type:'estimated',source_key:key,title:'Synthetic supplier',account_id:aid,monthly_amount:120,start_month:'2026-11',end_month:null,day:15,kind:'operating',memo:'',amount_overrides:{},...extra});
const installment=(extra:Partial<CashPlanSeries>={}):CashPlanSeries=>series({id:iid,source_type:'manual',source_key:iid,title:'Synthetic finite installment',account_id:null,monthly_amount:30,start_month:'2026-11',end_month:'2027-01',day:18,kind:'installment',memo:'Synthetic estimate; fees unconfirmed',amount_overrides:{'2027-01':29},...extra});
const data=(extra:Partial<Dataset>={}):Dataset=>({...structuredClone(emptyDataset),
 businesses:[{id:bid,name:'Synthetic company',representative:'',kind:'법인',reserve:0,color:'#123456'}],
 accounts:[{id:aid,business_id:bid,name:'Synthetic account',bank:'Synthetic bank',masked_number:'0001',opening_balance:1000,opening_balance_date:'2026-10-01'}],
 categories:[{id:'fee',name:'지급수수료',group_name:'영업비용',is_internal:false,is_operating:true}],
 transactions:['07','08','09'].map(month=>transaction(month)),cash_plan_series:[series(),installment()],...extra});
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'40000000-0000-4000-8000-000000000001',business_id:bid,source_type:'manual',source_key:iid,month:'2026-11',title:'Synthetic monthly override',account_id:null,plan_date:'2026-11-18',amount:40,memo:'',excluded:false,version:1,updated_at:'2026-10-28T00:00:00Z',...extra});

test('fixed-cost summary holds overlapping legacy descendants and preserves disjoint categories and ancestor exclusions',()=>{
 const salary='60000000-0000-4000-8000-000000000001',ads='60000000-0000-4000-8000-000000000002';
 const source=data({cash_plan_series:[],categories:[{id:salary,name:'급여',group_name:'영업비용',is_internal:false,is_operating:true},{id:ads,name:'광고선전비',group_name:'영업비용',is_internal:false,is_operating:true}]});
 const legacy=edit({source_type:'estimated',source_key:key,account_id:aid,amount:300,memo:mergeCashPlanCategory(fixedCostMemo('기타 고정비','Legacy note'),salary)});
 const qualified=edit({id:'40000000-0000-4000-8000-000000000002',source_type:'estimated',source_key:JSON.stringify([...JSON.parse(key),salary]),account_id:aid,amount:100,memo:fixedCostMemo('급여','Qualified note')});
 const detail=buildCashPlanSeriesBreakdown(source,[legacy,qualified],bid,'2026-11');
 assert.equal(detail.total,300);assert.equal(detail.excludedRows[0].exclusionReason,'원본 예산 중복 보류');assert.equal(qualified.excluded,false);
 const distinct={...legacy,memo:mergeCashPlanCategory(legacy.memo,ads)};
 assert.equal(buildCashPlanSeriesBreakdown(source,[distinct,qualified],bid,'2026-11').total,400);
 assert.equal(buildCashPlanSeriesMonthly(source,[legacy,qualified],'2026-11',1)[0].total,300);
 const global={...legacy,id:'40000000-0000-4000-8000-000000000003',month:'*',plan_date:null,excluded:true};
 const excluded=buildCashPlanSeriesBreakdown(source,[qualified,global],bid,'2026-11');
 assert.equal(excluded.total,0);assert.equal(excluded.excludedRows[0].exclusionReason,'전체 기간 제외');
});

test('whole-month operating and finite installment budgets have one final-month adjustment and no later charge',()=>{
 const source=data(),before=JSON.stringify(source),rows=buildCashPlanSeriesMonthly(source,[],'2026-10',6);
 assert.equal(rows[0].registered,false);
 assert.deepEqual(rows.map(row=>[row.month,row.operatingAmount,row.installmentAmount,row.total]),[
  ['2026-10',0,0,0],['2026-11',120,30,150],['2026-12',120,30,150],['2027-01',120,29,149],['2027-02',120,0,120],['2027-03',120,0,120],
 ]);
 assert.equal(rows[1].notes.length,1);assert.equal(rows[4].notes.length,0);assert.equal(JSON.stringify(source),before);
 assert.throws(()=>buildCashPlanSeriesMonthly(source,[],'bad'),RangeError);
});
test('authoritative estimated source replaces the same rolling source once while other sources and companies remain unchanged',()=>{
 const source=data(),other={...source.businesses[0],id:'10000000-0000-4000-8000-000000000002'};
 const otherAccount={...source.accounts[0],id:'20000000-0000-4000-8000-000000000002',business_id:other.id};
 source.businesses.push(other);source.accounts.push(otherAccount);
 source.transactions.push(...['07','08','09'].map(month=>({...transaction(month,70),id:`other-${month}`,business_id:other.id,account_id:otherAccount.id})));
 const model=buildEditableCashPlan(source,{from:'2026-11-01',to:'2026-11-30'},'2026-10-28',[]);
 const own=model.items.filter(item=>item.businessId===bid);
 assert.equal(own.length,2);assert.equal(own.filter(item=>item.source_key===key).length,1);
 assert.equal(model.estimates.businesses[0].total,150);assert.equal(model.estimates.businesses[1].total,70);
 assert.equal(own[0].seriesId!==undefined,true);
 const estimated=buildCashPlanWorksheetModel({data:source,editable:model,basis:'estimated',range:{from:'2026-11-01',to:'2026-11-30'},asOf:'2026-10-28'});
 assert.equal(estimated.businesses[0].originalTotal,150);
 const registered=buildCashPlanWorksheetModel({data:source,editable:model,basis:'registered',range:{from:'2026-11-01',to:'2026-11-30'},asOf:'2026-10-28'});
 assert.equal(registered.businesses[0].originalTotal,150);assert.equal(model.plan.businesses[0].expenses,150);
 const estimates=new Map(model.estimates.businesses.map(item=>[item.business.id,item]));
 for(const basis of ['estimated','registered'] as const){
  const funding=buildAccountFunding(model.plan.businesses,estimates,basis)[0];
  assert.equal(funding.expenses,150);assert.equal(funding.unassignedExpenses,30);
  assert.equal(funding.accounts[0].datedExpenses,120);assert.equal(funding.requiredTopUp,null);
 }
 assert.equal(buildMonthlyReport(source,[],'2026-11','2026-10-28').businesses[0].remainingTotal,150);
});
test('monthly override and exclusion update both month summary and shared plan without adding a second source',()=>{
 const source=data(),changes=[edit()];
 const model=buildEditableCashPlan(source,{from:'2026-11-01',to:'2026-11-30'},'2026-10-28',changes);
 assert.equal(model.estimates.businesses[0].total,160);assert.equal(buildCashPlanSeriesMonthly(source,changes,'2026-11',1)[0].total,160);
 const excluded=[edit({source_type:'estimated',source_key:key,excluded:true})];
 assert.equal(buildCashPlanSeriesMonthly(source,excluded,'2026-11',1)[0].total,30);
 assert.equal(buildEditableCashPlan(source,{from:'2026-11-01',to:'2026-11-30'},'2026-10-28',excluded).estimates.businesses[0].total,30);
});
test('series leave historical plans intact and stale month overrides cannot revive an expired installment',()=>{
 const source=data(),historical=edit({source_type:'estimated',source_key:key,month:'2026-10',amount:80,plan_date:'2026-10-15'});
 const previous=buildEditableCashPlan(source,{from:'2026-10-01',to:'2026-10-31'},'2026-10-28',[historical]);
 assert.equal(previous.items.length,1);assert.equal(previous.items[0].amount,80);assert.equal(previous.items[0].seriesId,undefined);
 const expired=edit({month:'2027-02',plan_date:'2027-02-18',amount:500});
 const next=buildEditableCashPlan(source,{from:'2027-02-01',to:'2027-02-28'},'2026-10-28',[expired]);
 assert.equal(next.items.some(item=>item.source_key===iid),false);assert.equal(next.estimates.businesses[0].total,120);
});
test('undated schedules remain undated, dated day31 clamps to month end, and partial periods use existing proration once',()=>{
 assert.equal(cashPlanSeriesDate(series({day:null}),'2027-02'),null);assert.equal(cashPlanSeriesDate(series({day:31}),'2027-02'),'2027-02-28');
 const source=data({transactions:[],cash_plan_series:[series({day:null,monthly_amount:300})]});
 const model=buildEditableCashPlan(source,{from:'2026-11-16',to:'2026-11-30'},'2026-10-28',[]);
 assert.equal(model.items[0].date,null);assert.equal(model.items[0].remainingAmount,150);
 assert.equal(model.estimates.businesses[0].total,150);assert.equal(buildCashPlanSeriesMonthly(source,[],'2026-11',1)[0].total,300);
});
test('actual and manual confirmation use the larger amount once while the month budget remains whole',()=>{
 const actual=transaction('11',50),source=data({transactions:[...data().transactions,actual]});
 const confirm=edit({source_type:'estimated',source_key:key,amount:120,account_id:aid,plan_date:'2026-11-15',confirmed_amount:70,confirmed_date:'2026-11-15',confirmation_complete:false});
 const model=buildEditableCashPlan(source,{from:'2026-11-01',to:'2026-11-30'},'2026-11-20',[confirm]);
 const item=model.items.find(item=>item.source_key===key)!;
 assert.equal(item.recordedAmount,70);assert.equal(item.remainingAmount,50);assert.equal(buildCashPlanSeriesMonthly(source,[confirm],'2026-11',1)[0].operatingAmount,120);
 assert.equal(source.transactions.length,4);
});
test('transport rejects missing, malformed, duplicate and cross-scope schedules rather than showing a zero budget',()=>{
 assert.deepEqual(readCashPlanSeries([series()],data()),[series()]);
 for(const value of [undefined,{},[series({monthly_amount:-1})],[series(),series()],[installment({source_key:sid})],[series({end_month:'2026-10'})],[series({amount_overrides:{'2026-10':1}})]])assert.throws(()=>readCashPlanSeries(value));
 assert.throws(()=>readCashPlanSeries([series({business_id:'10000000-0000-4000-8000-000000000003'})],data()),/사업자/);
});

test('breakdown uses explicit source groups and named regulatory budgets without inferring a purpose from names',()=>{
 const other='30000000-0000-4000-8000-000000000003',social='30000000-0000-4000-8000-000000000004',unknown='30000000-0000-4000-8000-000000000005',tax='30000000-0000-4000-8000-000000000006';
 const source=data({cash_plan_series:[
  series({title:'Synthetic person A',memo:'월 고정비 계획 · 급여 · 합성 원본'}),
  series({id:other,source_key:'synthetic-rent',title:'Synthetic vendor',monthly_amount:80,memo:'월 고정비 계획 · 임차료 · 원본에 명시된 목적'}),
  series({id:social,source_type:'manual',source_key:social,title:'사회보험 월예산',monthly_amount:20,memo:'월 고정비 계획 · 사용자 지정 월기준 · 실제 출금과 구분'}),
  series({id:unknown,source_type:'manual',source_key:unknown,title:'Synthetic person without purpose',monthly_amount:30,memo:''}),
  series({id:tax,source_type:'manual',source_key:tax,title:'세금·원천세 월예산',monthly_amount:10,memo:'월 고정비 계획 · 사용자 지정 월기준 · 실제 출금과 구분'}),
  installment(),
 ]});
 const before=JSON.stringify(source),detail=buildCashPlanSeriesBreakdown(source,[],bid,'2026-11');
 const monthly=buildCashPlanSeriesMonthly(source,[],'2026-11',1)[0];
 assert.equal(detail.status,'active');assert.equal(detail.registered,true);
 assert.equal(detail.operatingAmount,260);assert.equal(detail.installmentAmount,30);assert.equal(detail.total,290);
 assert.equal(detail.groups.reduce((sum,group)=>sum+group.amount,0),monthly.operatingAmount);
 assert.equal(detail.total,monthly.total);assert.equal(detail.includedCount,6);assert.equal(detail.excludedCount,0);
 assert.deepEqual(detail.groups.map(group=>[group.label,group.amount]),[['급여',120],['사회보험',20],['세금·원천세',10],['임차료',80],['기타 고정비',30]]);
 assert.equal(detail.includedRows.find(row=>row.id===unknown)?.groupLabel,'기타 고정비');
 assert.equal(detail.includedRows.find(row=>row.id===iid)?.groupLabel,'한시적 할부');
 assert.equal(detail.includedRows.find(row=>row.id===sid)?.memo,'월 고정비 계획 · 급여 · 합성 원본');
 assert.equal(JSON.stringify(source),before);
});

test('breakdown shares newest overrides and whole-period exclusion precedence while keeping excluded details visible',()=>{
 const rent='30000000-0000-4000-8000-000000000003',social='30000000-0000-4000-8000-000000000004',zero='30000000-0000-4000-8000-000000000005';
 const nextAccount={...data().accounts[0],id:'20000000-0000-4000-8000-000000000002',name:'Synthetic replacement account',masked_number:'0002'};
 const source=data({accounts:[...data().accounts,nextAccount],cash_plan_series:[
  series({memo:'월 고정비 계획 · 급여 · 원본'}),
  series({id:rent,source_key:'synthetic-rent',title:'Synthetic rent',monthly_amount:80,memo:'월 고정비 계획 · 임차료 · 원본'}),
  series({id:social,source_type:'manual',source_key:social,title:'사회보험 월예산',monthly_amount:20}),
  series({id:zero,source_type:'manual',source_key:zero,title:'Synthetic zero budget',monthly_amount:10}),installment(),
 ]});
 const changes=[
  edit({source_type:'estimated',source_key:key,amount:95,version:1}),
  edit({source_type:'estimated',source_key:key,title:'Edited synthetic budget',amount:90,account_id:nextAccount.id,plan_date:'2026-11-22',memo:'월 고정비 계획 · 새 그룹으로 바꾸려는 월 메모',version:3}),
  edit({id:rent,source_type:'estimated',source_key:'synthetic-rent',month:'*',excluded:true,plan_date:null,memo:'Synthetic whole-period exclusion'}),
  edit({id:rent,source_type:'estimated',source_key:'synthetic-rent',amount:999,excluded:false,memo:'Monthly row does not restore global exclusion'}),
  edit({id:social,source_key:social,amount:20,excluded:true,memo:'Synthetic one-month exclusion'}),
  edit({id:zero,source_key:zero,amount:0,memo:''}),
 ];
 const before=JSON.stringify({source,changes}),detail=buildCashPlanSeriesBreakdown(source,changes,bid,'2026-11');
 const monthly=buildCashPlanSeriesMonthly(source,changes,'2026-11',1)[0];
 assert.equal(detail.operatingAmount,90);assert.equal(detail.total,120);assert.equal(detail.total,monthly.total);
 assert.equal(detail.groups.reduce((sum,group)=>sum+group.amount,0),monthly.operatingAmount);
 assert.equal(detail.includedCount,3);assert.equal(detail.excludedCount,2);
 const changed=detail.includedRows.find(row=>row.id===sid)!;
 assert.equal(changed.originalTitle,'Synthetic supplier');assert.equal(changed.title,'Edited synthetic budget');
 assert.equal(changed.groupLabel,'급여');assert.equal(changed.baseAmount,120);assert.equal(changed.currentAmount,90);
 assert.equal(changed.date,'2026-11-22');assert.equal(changed.accountId,nextAccount.id);assert.match(changed.accountName,/Synthetic replacement account/);
 assert.equal(changed.memo,'월 고정비 계획 · 급여 · 원본');assert.equal(changed.editMemo,changes[1].memo);assert.equal(changed.effectiveMemo,changes[1].memo);
 const excludedRent=detail.excludedRows.find(row=>row.id===rent)!;
 assert.equal(excludedRent.baseAmount,80);assert.equal(excludedRent.currentAmount,999);assert.equal(excludedRent.exclusionReason,'전체 기간 제외');assert.equal(excludedRent.globalMemo,changes[2].memo);
 assert.equal(detail.excludedRows.find(row=>row.id===social)?.exclusionReason,'이번 달 제외');
 assert.equal(detail.includedRows.find(row=>row.id===zero)?.currentAmount,0);
 assert.equal(JSON.stringify({source,changes}),before);
});

test('unregistered, not-started, ended and valid zero budgets are distinguishable and expired edits stay inactive',()=>{
 assert.equal(buildCashPlanSeriesBreakdown(data({cash_plan_series:[]}),[],bid,'2026-11').status,'unregistered');
 const before=buildCashPlanSeriesBreakdown(data(),[],bid,'2026-10');
 assert.equal(before.status,'before-start');assert.equal(before.registered,false);assert.deepEqual(before.includedRows,[]);
 const zero=buildCashPlanSeriesBreakdown(data({cash_plan_series:[series({monthly_amount:0})]}),[],bid,'2026-11');
 assert.equal(zero.status,'active');assert.equal(zero.registered,true);assert.equal(zero.includedCount,1);assert.equal(zero.total,0);
 const expired=buildCashPlanSeriesBreakdown(data({cash_plan_series:[installment()]}),[edit({month:'2027-02',plan_date:'2027-02-18',amount:700})],bid,'2027-02');
 assert.equal(expired.status,'ended');assert.equal(expired.registered,true);assert.deepEqual(expired.includedRows,[]);assert.equal(expired.total,0);
 assert.throws(()=>buildCashPlanSeriesBreakdown(data(),[],bid,'invalid'),RangeError);
});

test('breakdown never leaks another business title, account or note, and explicit null overrides remain null',()=>{
 const otherBusiness='10000000-0000-4000-8000-000000000002',otherAccount='20000000-0000-4000-8000-000000000002',otherSeries='30000000-0000-4000-8000-000000000003';
 const source=data();
 source.businesses.push({...source.businesses[0],id:otherBusiness,name:'Synthetic other company'});
 source.accounts.push({...source.accounts[0],id:otherAccount,business_id:otherBusiness,name:'Synthetic other secret account'});
 source.cash_plan_series!.push(series({id:otherSeries,business_id:otherBusiness,source_key:'other-source',title:'Synthetic other secret title',account_id:otherAccount,memo:'Synthetic other secret note'}));
 const changes=[edit({source_type:'estimated',source_key:key,amount:120,account_id:null,plan_date:null,memo:''})];
 const detail=buildCashPlanSeriesBreakdown(source,changes,bid,'2026-11'),operating=detail.includedRows.find(row=>row.id===sid)!;
 assert.equal(operating.date,null);assert.equal(operating.accountId,null);assert.equal(operating.accountName,'미지정');assert.equal(operating.editMemo,'');assert.equal(operating.effectiveMemo,'');
 assert.ok(!JSON.stringify(detail).includes('other secret'));
 const wrongAccount=buildCashPlanSeriesBreakdown(source,[edit({source_type:'estimated',source_key:key,account_id:otherAccount})],bid,'2026-11').includedRows.find(row=>row.id===sid)!;
 assert.equal(wrongAccount.accountId,null);assert.equal(wrongAccount.accountName,'미지정');
 const unknown=buildCashPlanSeriesBreakdown(source,[],otherSeries,'2026-11');
 assert.equal(unknown.status,'unknown-business');assert.equal(unknown.businessName,'');assert.deepEqual(unknown.includedRows,[]);assert.deepEqual(unknown.notes,[]);
});

test('explicit compound group labels retain internal punctuation and bank labels do not repeat the same name',()=>{
 const source=data({accounts:[{...data().accounts[0],bank:'Synthetic bank',name:'Synthetic bank'}],cash_plan_series:[
  series({memo:'월 고정비 계획 · 정기 서비스·구독 · 합성 원본 근거\n다른 안내'}),
 ]});
 const detail=buildCashPlanSeriesBreakdown(source,[],bid,'2026-11');
 assert.equal(detail.groups[0].label,'정기 서비스·구독');assert.equal(detail.includedRows[0].groupLabel,'정기 서비스·구독');
 assert.equal(detail.includedRows[0].accountName,'Synthetic bank · 0001');
 assert.equal(detail.groups[0].amount,detail.operatingAmount);
});

test('every business has independent monthly entry points even when no fixed-cost plan exists',()=>{
 const source=data({cash_plan_series:[],transactions:[]});
 source.businesses=Array.from({length:4},(_,index)=>({...source.businesses[0],id:`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,name:`Synthetic company ${index+1}`}));
 const before=JSON.stringify(source),rows=buildCashPlanSeriesMonthly(source,[],'2026-11',2);
 assert.equal(rows.length,8);assert.equal(new Set(rows.map(row=>`${row.businessId}:${row.month}`)).size,8);
 for(const business of source.businesses){
  const own=rows.filter(row=>row.businessId===business.id);
  assert.deepEqual(own.map(row=>[row.month,row.registered,row.total]),[['2026-11',false,0],['2026-12',false,0]]);
  assert.ok(own.every(row=>row.businessName===business.name&&row.operatingAmount===0&&row.installmentAmount===0&&row.notes.length===0));
  const detail=buildCashPlanSeriesBreakdown(source,[],business.id,'2026-11');
  assert.equal(detail.status,'unregistered');assert.equal(detail.registered,false);assert.deepEqual(detail.includedRows,[]);
 }
 assert.deepEqual(buildCashPlanSeriesMonthly({...source,businesses:[]},[],'2026-11',2),[]);
 assert.equal(JSON.stringify(source),before);
});

test('registered, monthly manual, onward-excluded and unregistered businesses coexist without cross-business totals',()=>{
 const source=data({cash_plan_series:[series()],transactions:[]});
 source.businesses=Array.from({length:4},(_,index)=>({...source.businesses[0],id:`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,name:`Synthetic company ${index+1}`}));
 const [,unregistered,manualBusiness,excludedBusiness]=source.businesses;
 const excludedId='30000000-0000-4000-8000-000000000004';
 source.cash_plan_series!.push(series({id:excludedId,business_id:excludedBusiness.id,source_key:'synthetic-excluded-salary',account_id:null,memo:'월 고정비 계획 · 급여 · 합성 근거',version:2}));
 source.cash_plan_series_revisions=[{id:'50000000-0000-4000-8000-000000000004',business_id:excludedBusiness.id,series_id:excludedId,effective_month:'2026-11',title:'Synthetic excluded salary',monthly_amount:120,day:15,account_id:null,memo:'Synthetic continued exclusion',excluded:true,cancelled:false,version:1,updated_at:'2026-10-28T00:00:00Z'}];
 const manual=edit({id:'40000000-0000-4000-8000-000000000003',business_id:manualBusiness.id,source_key:'60000000-0000-4000-8000-000000000003',account_id:null,amount:25,memo:fixedCostMemo('카드대금','User-entered synthetic bill')});
 const futureFalse=edit({id:'40000000-0000-4000-8000-000000000004',business_id:excludedBusiness.id,source_type:'estimated',source_key:'synthetic-excluded-salary',month:'2026-12',plan_date:'2026-12-15',excluded:false,amount:999});
 const before=JSON.stringify({source,manual,futureFalse}),rows=buildCashPlanSeriesMonthly(source,[manual,futureFalse],'2026-11',2);
 assert.equal(rows.length,8);assert.equal(new Set(rows.map(row=>`${row.businessId}:${row.month}`)).size,8);
 assert.deepEqual(rows.filter(row=>row.businessId===bid).map(row=>row.operatingAmount),[120,120]);
 assert.deepEqual(rows.filter(row=>row.businessId===manualBusiness.id).map(row=>row.operatingAmount),[25,0]);
 assert.ok(rows.filter(row=>row.businessId===unregistered.id).every(row=>!row.registered&&row.total===0));
 assert.ok(rows.filter(row=>row.businessId===excludedBusiness.id).every(row=>row.registered&&row.total===0));
 const excluded=buildCashPlanSeriesBreakdown(source,[manual,futureFalse],excludedBusiness.id,'2026-12');
 assert.equal(excluded.excludedRows[0].exclusionReason,'이 달부터 계속 제외');assert.equal(excluded.operatingAmount,0);
 assert.equal(JSON.stringify({source,manual,futureFalse}),before);
});

test('explicit estimated month budgets enter the summary once without changing forecast reconciliation or other months',()=>{
 const source=data({cash_plan_series:[]}),range={from:'2026-11-01',to:'2026-11-30'},asOf='2026-11-20';
 const ordinary=edit({source_type:'estimated',source_key:key,account_id:aid,amount:140,plan_date:'2026-11-15',memo:'Synthetic reviewed month',confirmed_amount:60,confirmed_date:'2026-11-15',confirmation_complete:false,confirmation_memo:'Synthetic evidence'});
 const marked={...ordinary,memo:fixedCostMemo('카드대금',ordinary.memo)},before=JSON.stringify({source,ordinary,marked});
 assert.equal(isMonthlyFixedCostEdit(marked),false,'Summary registration must not change forecast membership');
 assert.equal(buildCashPlanSeriesBreakdown(source,[ordinary],bid,'2026-11').total,0);
 const detail=buildCashPlanSeriesBreakdown(source,[marked],bid,'2026-11');
 assert.equal(detail.total,140);assert.equal(detail.includedCount,1);assert.equal(detail.groups[0].label,'카드대금');
 assert.equal(detail.includedRows[0].id,marked.id);assert.equal(detail.includedRows[0].editId,marked.id);
 assert.equal(detail.includedRows[0].sourceType,'estimated');assert.equal(detail.includedRows[0].sourceKey,key);
 const project=(changes:CashPlanEdit[],period=range)=>buildEditableCashPlan(source,period,asOf,changes).items.map(row=>({key:row.key,amount:row.amount,date:row.date,accountId:row.accountId,recordedAmount:row.recordedAmount,remainingAmount:row.remainingAmount,seriesKind:row.seriesKind,seriesId:row.seriesId}));
 assert.deepEqual(project([marked]),project([ordinary]));
 const december={from:'2026-12-01',to:'2026-12-31'};
 assert.deepEqual(project([marked],december),project([ordinary],december));
 assert.deepEqual(buildCashPlanSeriesMonthly(source,[marked],'2026-10',3).map(row=>row.total),[0,140,0]);
 assert.equal(JSON.stringify({source,ordinary,marked}),before);
});

test('marked estimated month registration validates source ownership and excludes payment records',()=>{
 const otherBusiness='10000000-0000-4000-8000-000000000002',otherAccount='20000000-0000-4000-8000-000000000002';
 const source=data({cash_plan_series:[]});source.businesses.push({...source.businesses[0],id:otherBusiness,name:'Synthetic other'});
 source.accounts.push({...source.accounts[0],id:otherAccount,business_id:otherBusiness});
 const marked=edit({source_type:'estimated',source_key:key,account_id:aid,amount:140,memo:fixedCostMemo('정기 서비스·구독','Synthetic scoped registration')});
 const invalid:Partial<CashPlanEdit>[]=[
  {source_key:'not-json'},{source_key:JSON.stringify([bid,aid,null])},{source_key:JSON.stringify([bid,aid,' '])},
  {source_key:JSON.stringify([otherBusiness,aid,'description:synthetic'])},{source_key:JSON.stringify([bid,otherAccount,'description:synthetic'])},
  {account_id:otherAccount},{id:'not-a-uuid'},{amount:-1},{plan_date:'2026-12-01'},{plan_date:'2026-11-31'},
  {payment_kind:'tax'},{payment_status:'paid'},{memo:`[clobe-card-bill:synthetic]\n${marked.memo}`},{memo:'Synthetic unmarked'},
 ];
 for(const patch of invalid)assert.equal(buildCashPlanSeriesBreakdown(source,[{...marked,...patch}],bid,'2026-11').total,0,JSON.stringify(patch));
 assert.equal(buildCashPlanSeriesBreakdown(source,[marked],otherBusiness,'2026-11').total,0);
 assert.equal(buildCashPlanSeriesBreakdown(source,[marked],bid,'2026-11').total,140);
});

test('global exclusions and exact recurrence ownership take precedence over marked standalone month budgets',()=>{
 const marked=edit({source_type:'estimated',source_key:key,account_id:aid,amount:140,memo:fixedCostMemo('카드대금','Synthetic registration')});
 const global={...marked,id:'40000000-0000-4000-8000-000000000002',month:'*',excluded:true,plan_date:null,memo:'Synthetic global exclusion'};
 const standalone=buildCashPlanSeriesBreakdown(data({cash_plan_series:[]}),[marked,global],bid,'2026-11');
 assert.equal(standalone.total,0);assert.equal(standalone.excludedCount,1);assert.equal(standalone.excludedRows[0].exclusionReason,'전체 기간 제외');assert.equal(standalone.excludedRows[0].globalMemo,global.memo);
 const manual=edit({memo:fixedCostMemo('기타 고정비','Synthetic manual registration')});
 const manualGlobal={...manual,id:global.id,month:'*',excluded:true,plan_date:null,memo:'Synthetic manual global exclusion'};
 assert.equal(buildCashPlanSeriesBreakdown(data({cash_plan_series:[]}),[manual,manualGlobal],bid,'2026-11').total,0);
 const current=buildCashPlanSeriesBreakdown(data({cash_plan_series:[series()]}),[marked],bid,'2026-11');
 assert.equal(current.includedCount,1);assert.equal(current.includedRows[0].id,sid);assert.equal(current.total,140);
 const later=data({cash_plan_series:[series({start_month:'2026-12'})]});
 assert.equal(buildCashPlanSeriesBreakdown(later,[marked],bid,'2026-11').includedRows[0].id,marked.id);
 assert.deepEqual(buildCashPlanSeriesMonthly(later,[marked],'2026-11',2).map(row=>row.total),[140,120]);
 const ended=data({cash_plan_series:[series({start_month:'2026-10',end_month:'2026-10'})]});
 assert.equal(buildCashPlanSeriesBreakdown(ended,[marked],bid,'2026-11').total,0);
});
