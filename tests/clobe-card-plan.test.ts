import assert from 'node:assert/strict';
import test from 'node:test';
import {buildClobeCardPlanChanges,getClobeCardPlanCandidates,type ClobeCardPlanSelection} from '../lib/finance/clobe-card-plan';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import type {ClobeCardBill} from '../lib/clobe/card-billing-types';
import type {CashPlanChange,CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const b1=id(1),b2=id(2),a1=id(3),a2=id(4),r1=id(5),m1=id(6),billId=id(7),taxId=id(8),excludeId=id(9);
const asOf='2027-04-01',month='2027-04',range={from:'2027-04-01',to:'2027-04-30'};
const transaction=(n:number,date:string,description='합성카드 결제'):Transaction=>({id:id(n),business_id:b1,account_id:a1,upload_id:null,txn_date:date,amount:100,direction:'out',description,raw_gwamok:'',category_id:null,is_internal:false,balance:null,tax_invoice:false,dedup_hash:`synthetic-${n}`,manually_classified:false});
const data:Dataset={...emptyDataset,
 businesses:[{id:b1,name:'합성 사업자 A',representative:'',kind:'법인',reserve:0,color:'#123456'},{id:b2,name:'합성 사업자 B',representative:'',kind:'법인',reserve:0,color:'#654321'}],
 accounts:[{id:a1,business_id:b1,name:'합성 통장 A',bank:'합성',masked_number:'0001',opening_balance:3000,opening_balance_date:'2027-03-31'},{id:a2,business_id:b2,name:'합성 통장 B',bank:'합성',masked_number:'0002',opening_balance:2000,opening_balance_date:'2027-03-31'}],
 transactions:['01','02','03'].map((m,index)=>transaction(20+index,`2027-${m}-15`)),
};
const source=cashEstimateSourceKey(data.transactions[0]);
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:id(30),business_id:b1,source_type:'estimated',source_key:source,month,title:'합성카드 결제',account_id:a1,plan_date:'2027-04-15',amount:120,memo:'기존 사용자 메모',excluded:false,version:4,updated_at:'2027-03-20T00:00:00Z',payment_kind:'general',payment_status:'pending',...extra});
const bill=(extra:Partial<ClobeCardBill>={}):ClobeCardBill=>({key:billId,maskedCard:'****-****-****-9876',date:'2027-04-18',amount:450,kind:'REGULAR',itemCount:2,replaceable:true,reason:null,...extra});
const candidateKey=()=>getClobeCardPlanCandidates(data,[],b1,month,asOf)[0].key;
const selected=(extra:Partial<ClobeCardPlanSelection>={}):ClobeCardPlanSelection=>({companyId:'synthetic-company',businessId:b1,accountId:a1,bill:bill(),replacementKeys:[candidateKey()],...extra});
const apply=(edits:readonly CashPlanEdit[],changes:CashPlanChange[]):CashPlanEdit[]=>{
 const saved=new Map(edits.map(row=>[row.id,row]));
 for(const change of changes){assert.equal(change.action,'save');if(change.action!=='save')continue;
  const {action:_,...value}=change;void _;
  saved.set(change.id,{...value,version:change.version+1,updated_at:'2027-04-01T00:00:00Z'});
 }
 return [...saved.values()];
};
const changes=(edits:readonly CashPlanEdit[]=[],selection=selected())=>buildClobeCardPlanChanges({data,edits,asOf,selections:[selection],newEditIds:{[candidateKey()]:excludeId}});

test('confirmed card bill replaces an explicitly selected estimate instead of adding a second expense',()=>{
 const before=JSON.stringify(data),result=changes();
 assert.equal(result.length,2);
 const old=result.find(row=>row.id===excludeId)!;assert.equal(old.action,'save');
 if(old.action==='save'){assert.equal(old.source_type,'estimated');assert.equal(old.source_key,source);assert.equal(old.amount,100);assert.equal(old.excluded,true);assert.equal(old.month,month);assert.equal(old.version,0);}
 const next=result.find(row=>row.id===billId)!;
 if(next.action==='save'){assert.equal(next.source_type,'manual');assert.equal(next.source_key,billId);assert.equal(next.plan_date,'2027-04-18');assert.equal(next.amount,450);assert.equal(next.account_id,a1);}
 const model=buildEditableCashPlan(data,range,asOf,apply([],result));
 assert.equal(model.estimates.businesses[0].total,450);assert.equal(model.plan.businesses[0].expenses,450);
 assert.equal(JSON.stringify(data),before,'no transaction, account, category or rule mutation');
});

test('monthly replacement retains exact saved amount, date, memo and metadata for every source kind',()=>{
 for(const type of ['estimated','manual','registered'] as const){
  const fixture={...data,transactions:type==='estimated'?data.transactions:[],recurring:type==='registered'?[{id:r1,business_id:b1,title:'합성카드 결제',amount:200,direction:'out' as const,day:15,start_date:'2027-01-01',end_date:null,frequency:'monthly' as const}]:[]};
  const saved=edit({source_type:type,source_key:type==='estimated'?source:type==='manual'?m1:r1,amount:230,plan_date:'2027-04-12'});
  const item=getClobeCardPlanCandidates(fixture,[saved],b1,month,asOf)[0];
  const before=JSON.stringify({fixture,saved});
  const result=buildClobeCardPlanChanges({data:fixture,edits:[saved],asOf,selections:[selected({replacementKeys:[item.key]})]});
  const exclusion=result.find(row=>row.id===saved.id)!;
  assert.deepEqual(exclusion,{action:'save',id:saved.id,business_id:b1,source_type:type,source_key:saved.source_key,month,title:saved.title,account_id:a1,plan_date:saved.plan_date,amount:saved.amount,memo:saved.memo,excluded:true,version:4,payment_kind:'general',payment_status:'pending'});
  const updated=buildEditableCashPlan(fixture,range,asOf,apply([saved],result));
  assert.equal(updated.estimates.businesses[0].total,450);assert.equal(updated.plan.businesses[0].expenses,450);
  assert.equal(JSON.stringify({fixture,saved}),before);
 }
});

test('same bill is a no-op on repeat, while updates use the current saved version and preserve user notes',()=>{
 const saved=apply([],changes());
 assert.deepEqual(changes(saved),[]);
 assert.deepEqual(changes(saved,selected({replacementKeys:[]})),[]);
 const withNote=saved.map(row=>row.id===billId?{...row,memo:`${row.memo}\n사용자 추가 메모`}:row);
 const result=changes(withNote,selected({bill:bill({amount:600}),replacementKeys:[]}));
 assert.equal(result.length,1);const row=result[0];
 if(row.action==='save'){assert.equal(row.id,billId);assert.equal(row.version,1);assert.equal(row.amount,600);assert.match(row.memo,/사용자 추가 메모/);}
 assert.equal(buildEditableCashPlan(data,range,asOf,apply(withNote,result)).estimates.businesses[0].total,600);
});

test('several explicit bill rows can replace one aggregate old plan with one monthly exclusion',()=>{
 const result=buildClobeCardPlanChanges({data,edits:[],asOf,selections:[selected(),selected({bill:bill({key:id(10),amount:300,maskedCard:'****-****-****-8765',date:'2027-04-22'})})],newEditIds:{[candidateKey()]:excludeId}});
 assert.equal(result.length,3);assert.equal(result.filter(row=>row.id===excludeId).length,1);
 const saved=apply([],result);assert.equal(buildEditableCashPlan(data,range,asOf,saved).estimates.businesses[0].total,750);
 assert.deepEqual(buildClobeCardPlanChanges({data,edits:saved,asOf,selections:[selected(),selected({bill:bill({key:id(10),amount:300,maskedCard:'****-****-****-8765',date:'2027-04-22'})})]}),[]);
});

test('card fees, tax obligations, excluded plans and provider bills are not candidate replacement targets',()=>{
 const titles=['합성카드 문자수수료','합성카드 SMS','합성카드 연회비','합성카드론','사무용품','합성카드 현금서비스','합성카드 취소','클로브 카드대금 · ****'];
 const rows=titles.map((title,index)=>edit({id:id(40+index),source_type:'manual',source_key:id(40+index),title}));
 rows.push(edit({id:taxId,source_type:'manual',source_key:taxId,title:'합성카드 납부세금',payment_kind:'tax'}));
 rows.push(edit({id:m1,source_type:'manual',source_key:m1,title:'합성카드 결제',excluded:true}));
 const fixture={...data,transactions:[]};
 assert.deepEqual(getClobeCardPlanCandidates(fixture,rows,b1,month,asOf),[]);
 for(const row of rows){
  const key=buildEditableCashPlan(fixture,range,asOf,rows).items.find(item=>item.edit?.id===row.id)!.key;
  assert.throws(()=>buildClobeCardPlanChanges({data:fixture,edits:rows,asOf,selections:[selected({replacementKeys:[key]})]}),/대체 대상/);
 }
 assert.throws(()=>changes([edit({month:'*',plan_date:null,excluded:true})]),/대체 대상/);
});

test('unsafe, partial, prepaid, empty or past bills never erase an old plan or create a fake zero',()=>{
 const before=JSON.stringify(data);
 for(const patch of [{amount:0},{amount:null},{amount:-1},{amount:1.5},{replaceable:false},{kind:'PRE_PAYMENT' as const},{kind:'ADJUSTMENT' as const},{date:'2027-03-31'},{date:'2027-04-31'},{itemCount:0},{maskedCard:'1234567890123456'}]){
  assert.deepEqual(changes([],selected({bill:bill(patch)})),[]);
 }
 assert.deepEqual(buildClobeCardPlanChanges({data,edits:[],asOf,selections:[]}),[]);
 assert.equal(JSON.stringify(data),before);
 assert.equal(buildEditableCashPlan(data,range,asOf,[]).estimates.businesses[0].total,100);
});

test('business, account and monthly boundaries are explicit and cannot replace other scopes',()=>{
 assert.throws(()=>changes([],selected({accountId:''})),/출금 계좌/);
 assert.throws(()=>changes([],selected({accountId:a2})),/출금 계좌/);
 assert.throws(()=>changes([],selected({businessId:b2,accountId:a2})),/대체 대상/);
 assert.throws(()=>changes([],selected({bill:bill({date:'2027-05-18'})})),/대체 대상/);
 assert.throws(()=>changes([],selected({replacementKeys:[]})),/대체할 기존 카드 계획/);
 assert.throws(()=>buildClobeCardPlanChanges({data,edits:[],asOf,selections:[selected()]}),/수정 식별자/);
 const saved=apply([],changes());
 assert.throws(()=>changes(saved,selected({replacementKeys:[buildEditableCashPlan(data,range,asOf,saved).items.find(item=>item.edit?.id===billId)!.key]})),/대체 대상/);
});

test('a deliberately excluded imported bill is never resurrected, and old global exclusion is preserved',()=>{
 const saved=apply([],changes());
 const excluded=saved.map(row=>row.id===billId?{...row,excluded:true}:row),before=JSON.stringify(excluded);
 assert.throws(()=>changes(excluded,selected({replacementKeys:[]})),/자동 복원하지 않습니다/);
 assert.equal(JSON.stringify(excluded),before);
 const global=edit({id:id(60),month:'*',plan_date:null,excluded:true});
 assert.throws(()=>changes([...saved,global]),/대체 대상/);
});

test('atomic batches reject duplicate bill IDs, namespace collisions and more than 100 changes',()=>{
 assert.throws(()=>buildClobeCardPlanChanges({data,edits:[],asOf,selections:[selected(),selected()],newEditIds:{[candidateKey()]:excludeId}}),/한 번만 선택/);
 const collision=edit({id:billId,source_type:'manual',source_key:billId,title:'합성카드 사용자 계획'});
 assert.throws(()=>changes([collision]),/덮어쓸 수 없습니다/);
 const selections=Array.from({length:100},(_,index)=>selected({bill:bill({key:id(100+index)})}));
 assert.throws(()=>buildClobeCardPlanChanges({data,edits:[],asOf,selections,newEditIds:{[candidateKey()]:excludeId}}),/100건 이내/);
});
