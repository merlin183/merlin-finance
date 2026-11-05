import test from 'node:test';
import assert from 'node:assert/strict';
import {accountSnapshot,statementClosing} from '../lib/finance/balances';
import {positions} from '../lib/finance/aggregate';
import {digest,parseBalance,parseRows,parseTime} from '../lib/finance/parser';
import {detect,validateMapping} from '../lib/finance/auto-mapping';
import {emptyDataset,type Account,type Transaction} from '../lib/finance/types';

const account:Account={id:'bank-a',business_id:'business',name:'합성 운영통장',bank:'합성은행',masked_number:'001',opening_balance:999999,opening_balance_date:'2026-01-01'};
const txn=(id:string,date:string,amount:number,direction:'in'|'out',balance:number|null,extra:Partial<Transaction>={}):Transaction=>({id,txn_date:date,account_id:account.id,business_id:account.business_id,upload_id:null,amount,direction,balance,description:'반복 거래',raw_gwamok:'',category_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const day=[txn('a','2026-09-01',200,'out',800),txn('b','2026-09-01',100,'in',900),txn('c','2026-09-01',200,'out',700)];
test('엑셀 잔액은 개시잔액보다 우선하고 같은 날 거래의 입력 순서에 의존하지 않는다',()=>{
 for(const rows of [day,[...day].reverse(),[day[1],day[2],day[0]]]){
  assert.equal(statementClosing(rows)?.balance,700);
  assert.deepEqual(accountSnapshot(account,rows,'2026-09-17'),{balance:700,date:'2026-09-01',source:'statement',transactionId:'c',message:'엑셀의 거래 후 잔액'});
 }
 assert.equal(accountSnapshot({...account,opening_balance_date:null},day,'2026-09-17').balance,700);
});
test('종료일 이후 거래는 잔액에 포함하지 않고 이후 잔액 없는 거래는 계산 근거를 표시한다',()=>{
 const rows=[...day,txn('later','2026-09-03',300,'in',1000)];
 assert.equal(accountSnapshot(account,rows,'2026-09-02').balance,700);
 assert.equal(accountSnapshot(account,rows,'2026-09-03').balance,1000);
 const calculated=accountSnapshot(account,[...day,txn('later','2026-09-03',300,'in',null)],'2026-09-03');
 assert.equal(calculated.balance,1000);assert.equal(calculated.source,'calculated');
});
test('연결되지 않는 잔액이나 별도 순환 거래를 임의 순서로 추정하지 않는다',()=>{
 assert.equal(statementClosing([day[0],day[2]]),null);
 assert.equal(statementClosing([...day,txn('cycle1','2026-09-01',1,'in',11),txn('cycle2','2026-09-01',1,'out',10)]),null);
 assert.equal(accountSnapshot(account,[day[0],day[2]],'2026-09-17').source,'conflict');
 assert.equal(accountSnapshot(account,[...day,txn('missing','2026-09-01',50,'out',null)],'2026-09-17').balance,null);
});
test('순증감 0인 날은 거래시간으로 잔액 연결까지 검증한다',()=>{
 const cycle=[txn('a','2026-09-01',100,'out',900),txn('b','2026-09-01',100,'in',1000)];
 assert.equal(statementClosing(cycle),null);
 assert.equal(statementClosing([{...cycle[1],txn_time:'10:00:00'},{...cycle[0],txn_time:'09:00:00'}])?.balance,1000);
 assert.equal(statementClosing(cycle.map(t=>({...t,txn_time:'09:00:00'}))),null);
});
test('0원과 음수 잔액을 보존하며 빈 잔액과 대시는 미제공으로 처리한다',()=>{
 for(const value of [null,undefined,'','-','—','–'])assert.equal(parseBalance(value),null);
 assert.equal(parseBalance('0'),0);assert.equal(parseBalance('-1,000'),-1000);
 assert.equal(accountSnapshot(account,[txn('zero','2026-09-01',100,'out',0)],'2026-09-01').balance,0);
 assert.equal(accountSnapshot(account,[txn('negative','2026-09-01',110,'out',-10)],'2026-09-01').balance,-10);
});
test('한 사업자의 여러 통장 잔액을 각각 검증한 뒤 합산한다',()=>{
 const other={...account,id:'bank-b',name:'농협23'};
 const data={...emptyDataset,businesses:[{id:'business',name:'사업자',representative:'',kind:'개인',reserve:50,color:'#000'}],accounts:[account,other],transactions:[...day,txn('other','2026-09-01',1,'in',300,{account_id:other.id})]};
 assert.equal(positions(data,'2026-09-01')[0].balance,1000);
 assert.equal(positions(data,'2026-09-01')[0].available,950);
});
test('같은 일자·금액·적요라도 잔액이 다르면 보존하고 같은 파일 재업로드는 중복이다',async()=>{
 const hash=(balance:number|null)=>digest('bank-a','2026-09-01',200,'out','반복 거래',balance);
 assert.notEqual(await hash(800),await hash(700));assert.equal(await hash(800),await hash(800));
 assert.equal(await hash(null),await digest('bank-a','2026-09-01',200,'out','반복 거래'));
});
test('별도 거래시간과 거래시간 이름의 전체 날짜를 모두 자동 인식한다',async()=>{
 const rows=[['거래일자','거래시간','출금금액(원)','거래 후 잔액(원)'],['2026-09-01','09:15:20',200,800],['2026-09-01','10:00:00',200,600]];
 const detection=detect(rows);validateMapping(detection.mapping,rows,detection.headerRow);
 const result=await parseRows(rows,detection.mapping,'bank-a',[],[],[],{headerRow:detection.headerRow});
 assert.deepEqual(result.parsed.map(t=>[t.txn_date,t.txn_time,t.balance,t.source_row]),[['2026-09-01','09:15:20',800,2],['2026-09-01','10:00:00',600,3]]);
 const legacy=[['거래시간','출금','잔액'],['2026-09-01 09:15:20',200,800]];
 const mapped=detect(legacy);assert.equal(mapped.mapping.date,0);assert.equal(mapped.mapping.time,undefined);
 assert.equal(parseTime(.5),'12:00:00');assert.equal(parseTime('25:01:00'),null);
});
