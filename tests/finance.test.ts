import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDate,parseAmount,parseRows,classify,safePattern,digest} from '../lib/finance/parser';
import {accountBalance,occurrences,simulate,monthly} from '../lib/finance/aggregate';
import {emptyDataset,type Category,type Rule,type Dataset} from '../lib/finance/types';
import {read,write,utils} from '@e965/xlsx';

test('은행 날짜와 원화 입력: 실제 날짜만 허용',()=>{
 assert.equal(parseDate('2026.08.07 15:30'),'2026-08-07');
 assert.equal(parseDate('26/8/7'),'2026-08-07');assert.equal(parseDate(46241),'2026-08-07');
 assert.equal(parseAmount('1,234,567원'),1234567);assert.equal(parseAmount('-'),0);
});
test('존재하지 않는 날짜·소수금액 거부',()=>{assert.throws(()=>parseDate('2026-02-30'));assert.throws(()=>parseAmount('1.2'));assert.throws(()=>parseAmount('9007199254740992'))});
const cats:Category[]=[{id:'cash',name:'현금대체',group_name:'내부이동',is_operating:false,is_internal:true},{id:'loan',name:'대여금상환',group_name:'내부이동',is_operating:false,is_internal:true},{id:'card',name:'카드대금결제',group_name:'정리필요',is_operating:false,is_internal:false},{id:'unknown',name:'미매핑',group_name:'정리필요',is_operating:false,is_internal:false}];
const rules:Rule[]=[{id:'r',pattern:'카드',field:'description',priority:20,category_id:'card',is_internal:false}];
test('내부과목을 적요 규칙으로 덮어쓰지 않음',()=>{assert.deepEqual(classify('대여금상환','카드결제 자금 상환',cats,rules,[]),{category_id:'loan',is_internal:true});assert.equal(classify('현금대체','통장간 이체',cats,rules,[]).category_id,'cash')});
test('원장의 명시된 과목과 과목명 통일은 광범위한 적요 규칙보다 우선한다',()=>{
 const ledger=[...cats,{id:'ads',name:'광고선전비',group_name:'영업지출',is_operating:true,is_internal:false}];
 assert.equal(classify('광고선전비','롯데카드 광고 충전',ledger,rules,[]).category_id,'ads');
 assert.equal(classify(' 광고비 ','롯데카드 광고 충전',ledger,rules,[{id:'a',raw_name:'광고비',standard_name:'광고선전비'}]).category_id,'ads');
});
test('학습 규칙은 같은 계좌와 입출금 방향에서만 적용된다',async()=>{
 const scoped:Rule[]=[{id:'scoped',field:'description',pattern:'^정산$',priority:1,category_id:'card',is_internal:false,account_id:'aa',direction:'out'}];
 assert.equal(classify('','정산',cats,scoped,[],{account_id:'aa',direction:'out'}).category_id,'card');
 for(const context of [{account_id:'bb',direction:'out' as const},{account_id:'aa',direction:'in' as const},{}])assert.equal(classify('','정산',cats,scoped,[],context).category_id,'unknown');
 const rows=[['날짜','입금','출금','적요'],['2026-09-17',0,100,'정산'],['2026-09-17',100,0,'정산']];
 const result=await parseRows(rows,{date:0,income:1,expense:2,description:3},'aa',cats,scoped,[],{headerRow:0});
 assert.deepEqual(result.parsed.map(r=>r.category_id),['card','unknown']);
});
test('정규식 반복 공격 거부, 단어와 대안식 지원',()=>{assert.throws(()=>safePattern('(a|aa)+$'));assert.throws(()=>safePattern('a*a*'));assert.equal(safePattern('^카드|급여$').test('급여'),true);assert.equal(safePattern('A\\+B').test('A+B'),true)});
test('공백 연월 보완·양방향 오류행 분리·합계',async()=>{
 const rows=[['연','월','일','입금','출금'],[2026,8,1,1000,''],['','',2,'',200],['','',3,100,200]];
 const r=await parseRows(rows,{year:0,month:1,day:2,income:3,expense:4},'a',cats,[],[],{headerRow:0,year:2026,month:8});
 assert.equal(r.parsed.length,2);assert.equal(r.errors[0].row,4);assert.equal(r.parsed[1].txn_date,'2026-08-02');
 assert.deepEqual(monthly(r.parsed as never),[{month:'2026-08',income:1000,expense:200,net:800}]);
});
test('같은 거래 해시 유지, 계좌가 다르면 구분',async()=>{assert.equal(await digest('a','2026-08-01',100,'in','매출'),await digest('a','2026-08-01',100,'in','매출'));assert.notEqual(await digest('a','2026-08-01',100,'in','매출'),await digest('b','2026-08-01',100,'in','매출'))});
const data:Dataset={...emptyDataset,businesses:[{id:'a',name:'A',representative:'',kind:'개인',reserve:100,color:'#3366ee'},{id:'b',name:'B',representative:'',kind:'법인',reserve:0,color:'#2266ee'}],accounts:[{id:'aa',business_id:'a',name:'A',bank:'',masked_number:'',opening_balance:1000,opening_balance_date:'2026-08-01'},{id:'bb',business_id:'b',name:'B',bank:'',masked_number:'',opening_balance:200,opening_balance_date:'2026-08-01'}],recurring:[{id:'out',business_id:'a',title:'지출',amount:100,direction:'out',day:31,frequency:'monthly',start_date:'2026-08-01',end_date:null}]};
test('미래 개시일은 잔액 없음; 개시일 거래는 포함',()=>{assert.equal(accountBalance(data.accounts[0],[],'2026-07-31'),null);assert.equal(accountBalance(data.accounts[0],[{account_id:'aa',txn_date:'2026-08-01',amount:300,direction:'out'}] as never,'2026-08-01'),700)});
test('31일 반복지출은 월말 보정',()=>{assert.deepEqual(occurrences(data.recurring[0],'2026-08-01','2026-09-30'),['2026-08-31','2026-09-30'])});
test('미래 이체는 그때 잔액과 그 이후 30일 지출을 사용',()=>{const r=simulate(data,'2026-08-01','a','b',100,'2026-09-01');assert.equal(r.sender.balance,800);assert.equal(r.sender.available,600);assert.equal(r.receiver.balance,300);assert.throws(()=>simulate(data,'2026-08-01','a','a',100));assert.throws(()=>simulate(data,'2026-08-01','a','b',100,'2027-01-01'))});
test('희소 엑셀의 숨은 뒤쪽 행 잘림을 탐지할 수 있음',()=>{const wb=utils.book_new();const ws=utils.aoa_to_sheet([['날짜','입금'],['2026-08-01',100]]);ws.A25001={t:'s',v:'2026-08-02'};ws.B25001={t:'n',v:200};ws['!ref']='A1:B25001';utils.book_append_sheet(wb,ws,'원장');const clipped=read(write(wb,{type:'buffer',bookType:'xlsx'}),{sheetRows:20002});const sheet=clipped.Sheets['원장'];assert.ok(utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1').e.r>20000)});
