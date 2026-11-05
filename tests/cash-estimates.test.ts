import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashEstimates} from '../lib/finance/cash-estimates';
import {emptyDataset,type Business,type Category,type Dataset,type Transaction} from '../lib/finance/types';

const business=(id:string):Business=>({id,name:`합성 사업자 ${id}`,representative:'',kind:'법인',reserve:0,color:'#123456'});
const category=(id:string,name:string,is_internal=false):Category=>({id,name,group_name:is_internal?'내부이동':'영업지출',is_internal,is_operating:!is_internal});
const transaction=(id:string,date:string,amount=300,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',upload_id:null,txn_date:date,amount,direction:'out',description:'SYNTHETIC SERVICE',raw_gwamok:'',category_id:'fee',is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const repeated=(prefix:string,extra:Partial<Transaction>={},days=[15,15,15])=>['06','07','08'].map((month,index)=>transaction(`${prefix}-${month}`,`2026-${month}-${String(days[index]).padStart(2,'0')}`,300,extra));
const dataset=(transactions:Transaction[],extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[business('b1')],categories:[category('fee','지급수수료')],transactions,...extra});

test('직전 3개 완료 월만 근거로 삼고 기준일 다음 날부터 기간 마지막 날까지 펼친다',()=>{
 const rows=[...repeated('valid'),transaction('old','2026-05-15',90000),transaction('partial','2026-09-15',90000),transaction('future','2026-10-15',90000)];
 const result=buildCashEstimates(dataset(rows),'2026-09-29',30);
 assert.deepEqual(result.basis.months,['2026-06','2026-07','2026-08']);
 assert.equal(result.basis.from,'2026-06-01');assert.equal(result.basis.to,'2026-08-31');
 assert.deepEqual(result.range,{from:'2026-09-30',to:'2026-10-29'});
 const first=result.businesses[0];
 assert.equal(first.groups[0].sourceCount,3);assert.equal(first.groups[0].monthlyAverage,300);
 assert.deepEqual(first.dated.map(item=>[item.date,item.amount]),[['2026-10-15',300]]);
 assert.equal(first.total,300);
});

test('출금이 없는 월은 0원을 포함해 평균하고 최근 완료 월이 없거나 1개월뿐이면 제외한다',()=>{
 const rows=[transaction('june','2026-06-15',300),transaction('august','2026-08-15',600),
  transaction('stale-june','2026-06-10',100,{description:'STALE'}),transaction('stale-july','2026-07-10',100,{description:'STALE'}),
  transaction('single','2026-08-01',100,{description:'SINGLE'})];
 const result=buildCashEstimates(dataset(rows),'2026-09-30',31).businesses[0];
 assert.equal(result.groups.length,1);assert.equal(result.groups[0].monthlyAverage,300);
 assert.deepEqual(result.groups[0].monthlyAmounts.map(item=>[item.amount,item.count]),[[300,1],[0,0],[600,1]]);
 assert.equal(result.total,300);assert.equal(result.exclusions.length,2);
 assert.match(result.exclusions.find(item=>item.label==='STALE')!.reason,/최근 완료 월/);
 assert.match(result.exclusions.find(item=>item.label==='SINGLE')!.reason,/2개월/);
});

test('사업자·통장·명시된 상대방별로 구분하고 유사 이름은 임의로 합치지 않는다',()=>{
 const rows=[...repeated('base'),...repeated('same-normalized',{description:'  synthetic   service  '}),
  ...repeated('other-account',{account_id:'a2'}),...repeated('other-business',{business_id:'b2'}),
  ...repeated('similar',{description:'SYNTHETIC SERVICE PRO'}),
  ...repeated('person-a',{description:'급여',source_details:{counterparty:'합성 수취인 A'}}),
  ...repeated('person-b',{description:'급여',source_details:{counterparty:'합성 수취인 B'}})];
 const result=buildCashEstimates(dataset(rows,{businesses:[business('b1'),business('b2')]}),'2026-09-30',31);
 assert.equal(result.businesses[0].groups.length,5);assert.equal(result.businesses[1].groups.length,1);
 const same=result.businesses[0].groups.find(group=>group.accountId==='a1'&&group.sourceCount===6)!;
 assert.equal(same.monthlyAverage,600);assert.equal(same.expectedDay,null);
 assert.deepEqual(result.businesses[0].groups.filter(group=>group.label.includes('합성 수취인')).map(group=>group.label),['합성 수취인 A','합성 수취인 B']);
});

test('내부거래·대여금이 섞인 그룹과 사용자가 제외한 사업자 과목은 추정하지 않는다',()=>{
 const rows=[...repeated('internal',{description:'INTERNAL',is_internal:true}),
  ...repeated('loan',{description:'LOAN',category_id:'loan'}),
  ...repeated('salary',{description:'SALARY',category_id:'salary'}),
  ...repeated('other-salary',{business_id:'b2',description:'SALARY',category_id:'salary'}),
  ...repeated('mixed',{description:'MIXED'}),transaction('mixed-internal','2026-08-20',300,{description:'MIXED',is_internal:true}),
  ...repeated('interest',{description:'INTEREST',category_id:'interest'})];
 const data=dataset(rows,{businesses:[business('b1'),business('b2')],categories:[category('fee','지급수수료'),category('loan','대여금'),category('salary','급여'),category('interest','대출이자')]});
 const result=buildCashEstimates(data,'2026-09-30',31,{excludedBusinessCategories:[{businessId:'b1',categoryId:'salary'}]});
 assert.deepEqual(result.businesses[0].groups.map(group=>group.label),['INTEREST']);
 assert.equal(result.businesses[0].exclusions.length,4);
 assert.match(result.businesses[0].exclusions.find(item=>item.label==='SALARY')!.reason,/사용자/);
 assert.deepEqual(result.businesses[1].groups.map(group=>group.label),['SALARY']);
});

test('월 1회이고 날짜 차이 6일 이하일 때만 중앙값을 쓰고 월말은 실제 말일로 표시한다',()=>{
 const rows=[...repeated('stable',{description:'STABLE'},[13,15,17]),
  ...repeated('unstable',{description:'UNSTABLE'},[5,15,25]),
  ...repeated('month-end',{description:'MONTH END'},[30,31,31]),
  ...repeated('multiple',{description:'MULTIPLE'},[12,12,12]),transaction('extra','2026-08-13',300,{description:'MULTIPLE'})];
 const result=buildCashEstimates(dataset(rows),'2026-09-30',61).businesses[0];
 assert.equal(result.groups.find(group=>group.label==='STABLE')!.expectedDay,15);
 assert.equal(result.groups.find(group=>group.label==='UNSTABLE')!.expectedDay,null);
 assert.equal(result.groups.find(group=>group.label==='MULTIPLE')!.expectedDay,null);
 const monthEnd=result.groups.find(group=>group.label==='MONTH END')!;
 assert.equal(monthEnd.expectedDay,31);assert.equal(monthEnd.monthEnd,true);
 assert.deepEqual(result.dated.filter(item=>item.title==='MONTH END').map(item=>item.date),['2026-10-31','2026-11-30']);
 assert.equal(result.undated.some(item=>'date' in item),false);
});

test('명시적으로 연결된 내부이체와 내부 계정과목은 거래 플래그가 빠져도 제외한다',()=>{
 const rows=[...repeated('linked',{description:'LINKED'}),...repeated('category',{description:'CATEGORY',category_id:'internal'}),...repeated('raw',{description:'RAW',category_id:null,raw_gwamok:'대여금 상환'})];
 const result=buildCashEstimates(dataset(rows,{categories:[category('fee','지급수수료'),category('internal','사업자이동',true)],links:[{id:'link',out_transaction_id:'linked-08',in_transaction_id:'synthetic-incoming'}]}),'2026-09-30',31).businesses[0];
 assert.equal(result.groups.length,0);assert.equal(result.exclusions.length,3);assert.equal(result.total,0);
 assert.equal(result.exclusions.every(item=>item.reason.includes('내부이동')),true);
});

test('매월 28일 출금은 말일로 바꾸지 않고 짧은 달만 실제 마지막 날로 제한한다',()=>{
 const fixed28=buildCashEstimates(dataset(repeated('fixed',{},[28,28,28])),'2026-09-29',30).businesses[0];
 assert.equal(fixed28.groups[0].expectedDay,28);assert.equal(fixed28.groups[0].monthEnd,false);
 assert.deepEqual(fixed28.dated.map(item=>item.date),['2026-10-28']);assert.equal(fixed28.total,300);
 const rows=['2026-10-30','2026-11-30','2026-12-30'].map((date,index)=>transaction(`fixed30-${index}`,date));
 const fixed30=buildCashEstimates(dataset(rows),'2027-01-31',60).businesses[0];
 assert.equal(fixed30.groups[0].expectedDay,30);assert.equal(fixed30.groups[0].monthEnd,false);
 assert.deepEqual(fixed30.dated.map(item=>item.date),['2027-02-28','2027-03-30']);
 const endRows=['2026-10-31','2026-11-30','2026-12-31'].map((date,index)=>transaction(`month-end-${index}`,date));
 const monthEnd=buildCashEstimates(dataset(endRows),'2027-01-31',60).businesses[0];
 assert.equal(monthEnd.groups[0].monthEnd,true);
 assert.deepEqual(monthEnd.dated.map(item=>item.date),['2027-02-28','2027-03-31']);
});

test('날짜 미정은 조회기간의 월별 일수에 비례한 예산만 계산한다',()=>{
 const result=buildCashEstimates(dataset(repeated('variable',{},[1,15,30])),'2026-09-29',30).businesses[0];
 assert.equal(result.dated.length,0);assert.equal(result.undated.length,2);
 assert.deepEqual(result.undated.map(item=>[item.month,item.from,item.to,item.coveredDays,item.monthDays,item.monthlyAmount,item.amount,item.kind]),[
  ['2026-09','2026-09-30','2026-09-30',1,30,300,10,'period-budget'],
  ['2026-10','2026-10-01','2026-10-29',29,31,300,281,'period-budget'],
 ]);
 assert.equal(result.total,291);
 const fullMonth=buildCashEstimates(dataset(repeated('variable',{},[1,15,30])),'2026-09-30',31).businesses[0];
 assert.equal(fullMonth.total,300);
});

test('명시된 상대방 없는 일반 채널·급여 표기는 별도 확인으로 남기고 입금은 추정하지 않는다',()=>{
 const rows=[...repeated('generic',{description:'급여'}),...repeated('income',{description:'INCOME',direction:'in'}),...repeated('blank',{description:' '})];
 const result=buildCashEstimates(dataset(rows),'2026-09-30',31).businesses[0];
 assert.equal(result.total,0);assert.equal(result.groups.length,0);assert.equal(result.exclusions.length,2);
 assert.equal(result.exclusions.every(item=>item.reason.includes('원본 내역')),true);
});

test('등록 계획·실제 지급과 합치거나 차감하지 않고 근거 원본도 변경하지 않는다',()=>{
 const rows=repeated('source');
 const data=dataset(rows,{recurring:[{id:'registered',business_id:'b1',title:'SYNTHETIC SERVICE',amount:900,direction:'out',day:15,start_date:'2026-01-01',end_date:null,frequency:'monthly'}]});
 const before=JSON.stringify(data);
 const result=buildCashEstimates(data,'2026-09-30',31);
 assert.equal(result.businesses[0].total,300);
 assert.equal(result.businesses[0].dated.length,1);
 assert.deepEqual(result.businesses[0].groups[0].sourceIds,['source-06','source-07','source-08']);
 assert.equal(JSON.stringify(data),before);
 assert.equal(result.reminders.some(item=>item.includes('합산하지')),true);
 assert.equal(result.reminders.some(item=>item.includes('미지급액')),true);
});

test('반올림은 월평균과 월별 일수 예산 단계에서 하고 60·90일 합계가 상세 합계와 일치한다',()=>{
 const rows=[...repeated('stable'),...repeated('unstable',{description:'UNSTABLE'},[1,15,30])];
 rows[0].amount=301;
 for(const horizon of [30,60,90]){
  const result=buildCashEstimates(dataset(rows),'2026-09-29',horizon).businesses[0];
  assert.equal(result.groups.find(group=>group.label==='SYNTHETIC SERVICE')!.monthlyAverage,300);
  assert.equal(result.total,result.dated.reduce((sum,item)=>sum+item.amount,0)+result.undated.reduce((sum,item)=>sum+item.amount,0));
  assert.equal(Number.isSafeInteger(result.total),true);
 }
});

test('잘못된 기준일·거래일·기간을 보정하지 않고 연말에도 완료 월을 정확히 정한다',()=>{
 const invalidDates=['2026-06-31','2026-07-00','2026-08-15T00:00:00Z'];
 const result=buildCashEstimates(dataset(invalidDates.map((date,index)=>transaction(`invalid-${index}`,date))),'2026-09-30',31);
 assert.equal(result.businesses[0].groups.length,0);assert.equal(result.businesses[0].exclusions.length,0);
 assert.deepEqual(buildCashEstimates(dataset([]),'2027-01-01',30).basis.months,['2026-10','2026-11','2026-12']);
 for(const date of ['invalid','2026-02-30','1900-01-01','1900-03-01'])assert.throws(()=>buildCashEstimates(dataset([]),date),RangeError);
 for(const horizon of [0,-1,1.5,NaN,Infinity])assert.throws(()=>buildCashEstimates(dataset([]),'2026-09-30',horizon),RangeError);
 assert.throws(()=>buildCashEstimates(dataset([]),'9999-12-31',1),RangeError);
});
