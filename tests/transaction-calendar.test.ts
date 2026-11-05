import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTransactionCalendar,calendarMonthRange,shiftCalendarMonth} from '../lib/finance/transaction-calendar';
import type {Transaction} from '../lib/finance/types';

function transaction(id:string,date:string,amount:number,direction:'in'|'out'='out',time?:string|null):Transaction {
 return {id,business_id:'synthetic-business',account_id:'synthetic-account',upload_id:null,txn_date:date,txn_time:time,amount,direction,description:'합성 거래',raw_gwamok:'',category_id:null,is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false};
}

test('달력은 윤년과 실제 월말을 포함하며 지원 범위 양 끝도 계산한다',()=>{
 assert.deepEqual(calendarMonthRange('2024-02'),{from:'2024-02-01',to:'2024-02-29'});
 assert.deepEqual(calendarMonthRange('2026-02'),{from:'2026-02-01',to:'2026-02-28'});
 assert.deepEqual(calendarMonthRange('2026-09'),{from:'2026-09-01',to:'2026-09-30'});
 assert.deepEqual(calendarMonthRange('1900-01'),{from:'1900-01-01',to:'1900-01-31'});
 assert.deepEqual(calendarMonthRange('9999-12'),{from:'9999-12-01',to:'9999-12-31'});
});

test('월 이동은 연도 경계를 넘고 지원 범위 밖으로 벗어나지 않는다',()=>{
 assert.equal(shiftCalendarMonth('2026-12',1),'2027-01');
 assert.equal(shiftCalendarMonth('2026-01',-1),'2025-12');
 assert.equal(shiftCalendarMonth('2026-09',15),'2027-12');
 assert.equal(shiftCalendarMonth('2026-09',0),'2026-09');
 assert.equal(shiftCalendarMonth('1900-01',-1),'1900-01');
 assert.equal(shiftCalendarMonth('9999-12',1),'9999-12');
 assert.equal(shiftCalendarMonth('2026-09',Number.MAX_SAFE_INTEGER),'9999-12');
 assert.equal(shiftCalendarMonth('2026-09',-Number.MAX_SAFE_INTEGER),'1900-01');
});

test('잘못된 월과 정수가 아닌 이동은 임의로 보정하지 않는다',()=>{
 for(const month of ['','2026-9','2026-00','2026-13','2026-09-01','1899-12','10000-01','invalid']){
  assert.throws(()=>calendarMonthRange(month),RangeError);
  assert.throws(()=>shiftCalendarMonth(month,1),RangeError);
  assert.throws(()=>buildTransactionCalendar([],month),RangeError);
 }
 for(const delta of [0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>shiftCalendarMonth('2026-09',delta),RangeError);
});

test('일요일부터 시작하는 주를 빈칸으로 채우고 빈 날짜도 표시한다',()=>{
 const september=buildTransactionCalendar([],'2026-09');
 assert.equal(september.days.length,35);
 assert.deepEqual(september.days.slice(0,2),[null,null]);
 assert.deepEqual(september.days[2],{date:'2026-09-01',transactions:[],income:0,expense:0});
 assert.equal(september.days[31]?.date,'2026-09-30');
 assert.deepEqual(september.days.slice(32),[null,null,null]);
 const february=buildTransactionCalendar([],'2026-02');
 assert.equal(february.days.length,28);
 assert.equal(february.days[0]?.date,'2026-02-01');
 assert.equal(february.days[27]?.date,'2026-02-28');
 assert.equal(buildTransactionCalendar([],'2026-05').days.length,42);
});

test('월과 일별 입출금 합계가 일치하며 모든 사업자와 내부거래를 그대로 집계한다',()=>{
 const rows=[transaction('opening','2026-08-31',999),transaction('first','2026-09-01',100),transaction('income','2026-09-01',250,'in'),{...transaction('other-business','2026-09-30',75),business_id:'second-business',account_id:'second-account',is_internal:true},transaction('next','2026-10-01',888)];
 const result=buildTransactionCalendar(rows,'2026-09');
 assert.equal(result.income,250);assert.equal(result.expense,175);
 assert.deepEqual(result.transactions.map(row=>row.id),['first','income','other-business']);
 assert.deepEqual(result.days.find(day=>day?.date==='2026-09-01'),{date:'2026-09-01',transactions:[rows[1],rows[2]],income:250,expense:100});
 assert.equal(result.days.reduce((sum,day)=>sum+(day?.income??0),0),result.income);
 assert.equal(result.days.reduce((sum,day)=>sum+(day?.expense??0),0),result.expense);
});

test('거래가 하루에 50건을 넘어도 모두 보존하고 같은 내용의 별도 거래도 합치지 않는다',()=>{
 const rows=Array.from({length:125},(_,index)=>transaction(`same-day-${String(index).padStart(3,'0')}`,'2026-09-15',10));
 const result=buildTransactionCalendar(rows,'2026-09');
 assert.equal(result.transactions.length,125);
 assert.equal(result.days.find(day=>day?.date==='2026-09-15')?.transactions.length,125);
 assert.equal(result.expense,1250);
 assert.equal(new Set(result.transactions.map(row=>row.id)).size,125);
});

test('원본을 바꾸지 않고 날짜·시간·아이디순으로 정렬하며 미확인 시간은 뒤에 둔다',()=>{
 const rows=Object.freeze([
  Object.freeze(transaction('unknown-b','2026-09-15',1)),
  Object.freeze(transaction('late','2026-09-15',2,'out','18:30:00')),
  Object.freeze(transaction('early-b','2026-09-15',3,'in','09:00:00')),
  Object.freeze(transaction('early-a','2026-09-15',4,'out','09:00:00')),
  Object.freeze(transaction('prior-date','2026-09-14',5,'out','23:00:00')),
  Object.freeze(transaction('unknown-a','2026-09-15',6,'out',null)),
 ]);
 const before=JSON.stringify(rows);
 const result=buildTransactionCalendar(rows,'2026-09');
 assert.deepEqual(result.transactions.map(row=>row.id),['prior-date','early-a','early-b','late','unknown-a','unknown-b']);
 assert.equal(JSON.stringify(rows),before);
 assert.equal(result.transactions.find(row=>row.id==='early-a'),rows[3]);
 assert.deepEqual(buildTransactionCalendar([...rows].reverse(),'2026-09').transactions,result.transactions);
});

test('불가능한 날짜와 다른 형식의 날짜는 어느 달력 날짜에도 붙이지 않는다',()=>{
 const dates=['2026-09-00','2026-09-31','2026-9-15','2026-09-15T00:00:00Z','invalid','2026-02-29'];
 const rows=dates.map((date,index)=>transaction(`invalid-${index}`,date,100));
 const result=buildTransactionCalendar(rows,'2026-09');
 assert.equal(result.transactions.length,0);assert.equal(result.expense,0);
 assert.equal(buildTransactionCalendar(rows,'2026-02').transactions.length,0);
 const leap=buildTransactionCalendar([transaction('leap','2024-02-29',100)],'2024-02');
 assert.equal(leap.days.filter(Boolean).length,29);assert.equal(leap.expense,100);
});

test('서울·UTC·미국 서머타임에서도 원본 거래일과 달력 요일이 이동하지 않는다',()=>{
 const previous=process.env.TZ;
 try{
  for(const timezone of ['Asia/Seoul','UTC','America/Los_Angeles']){
   process.env.TZ=timezone;
   const rows=[transaction('start','2026-03-01',10),transaction('dst','2026-03-08',20),transaction('end','2026-03-31',30)];
   const calendar=buildTransactionCalendar(rows,'2026-03');
   assert.equal(calendar.days[0]?.date,'2026-03-01',timezone);
   assert.equal(calendar.days[7]?.date,'2026-03-08',timezone);
   assert.equal(calendar.days[30]?.date,'2026-03-31',timezone);
   assert.deepEqual(calendar.transactions.map(row=>row.txn_date),['2026-03-01','2026-03-08','2026-03-31'],timezone);
   assert.equal(calendar.expense,60,timezone);
   assert.deepEqual(calendarMonthRange('2026-03'),{from:'2026-03-01',to:'2026-03-31'},timezone);
  }
 }finally{
  if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;
 }
});
