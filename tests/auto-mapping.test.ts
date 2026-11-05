import test from 'node:test';
import assert from 'node:assert/strict';
import {read,write,utils} from '@e965/xlsx';
import {detect,headerSignature,mappingProblems,matchingPreset,validateMapping} from '../lib/finance/auto-mapping';
import {normalizeRows,parseRows,parseDate,type ParseOptions} from '../lib/finance/parser';
import {readTransactions,sheetRows,transactionSheet,transactionSheets} from '../lib/finance/workbook';
import {previewSheets,transactionOverview,previewPage,type SheetPlan} from '../lib/finance/import-preview';

function preview(rows:unknown[][],fileName='',sheetName='거래내역'){
 const d=detect(rows,{fileName,sheetName});const opts:ParseOptions={headerRow:d.headerRow,year:d.year,month:d.month,amountMode:d.amountMode};
 assert.deepEqual(mappingProblems(rows,d.mapping,opts),[]);
 return {d,...normalizeRows(rows,d.mapping,[],[],[],opts)};
}
test('제목·조회조건 아래 헤더와 은행별 원화·줄바꿈 열 자동 인식',()=>{
 const rows=[['예금 거래내역'],['조회기간','2026-08-01 ~ 2026-08-31'],[],['거래일시','찾으신금액(원)','맡기신금액\n(원)','거래 후 잔액','통장표시내용'],['2026.08.01 09:30','1,200','','8,800','통신요금'],['2026.08.02 12:00','','2,000','10,800','매출']];
 const r=preview(rows);assert.equal(r.d.headerRow,3);assert.equal(r.parsed.length,2);assert.equal(r.parsed[0].direction,'out');assert.equal(r.parsed[1].amount,2000);assert.equal(r.parsed[1].balance,10800);assert.equal(r.parsed[0].description,'통신요금');
});
test('입금·출금이 하위 행에 나뉜 2단 헤더 처리',()=>{
 const r=preview([['거래일자','거래금액','','잔액'],['','입금','출금',''],['2026-08-01',1000,'',1000],['2026-08-02','',200,800]]);
 assert.equal(r.d.headerRow,1);assert.equal(r.parsed.length,2);assert.equal(r.parsed[1].direction,'out');assert.deepEqual(r.errors,[]);
});
test('입출금 구분과 모두 양수인 거래금액을 올바르게 해석',()=>{
 const r=preview([['거래일자','입출금 구분','거래금액(원)','적요'],['20260801','출금',500,'이체'],['20260802','입금',800,'매출']]);
 assert.deepEqual(r.parsed.map(r=>r.direction),['out','in']);
});
test('단일 금액의 부호가 확인될 때 자동 처리, 방향 없는 양수는 추측하지 않음',()=>{
 const r=preview([['날짜','거래금액','내용'],['2026-08-01','(1,000)','수수료'],['2026-08-02','+2,000','매출']]);
 assert.equal(r.parsed[0].direction,'out');assert.equal(r.parsed[1].direction,'in');
 const rows=[['날짜','금액'],['2026-08-01',1000]];const d=detect(rows);
 assert.match(mappingProblems(rows,d.mapping,{headerRow:d.headerRow}).join(' '),/입출금 방향/);
});
test('영문 거래 내역과 통화 단위 헤더 자동 인식',()=>{
 const r=preview([['Transaction Date','Description','Debit (KRW)','Credit (KRW)','Balance'],['2026-08-01','Rent',1000,'',2000],['2026-08-02','Sales','',3000,5000]]);
 assert.equal(r.parsed.length,2);assert.equal(r.parsed[0].amount,1000);assert.equal(r.parsed[1].balance,5000);
});
test('파일의 연월과 일자 열 결합, 파일에 없는 연월은 현재 날짜로 추측하지 않음',()=>{
 const rows=[['일자','입금액','출금액'],[1,1000,''],[2,'',100]];
 assert.equal(preview(rows,'2026년 8월_거래내역.xlsx').parsed[1].txn_date,'2026-08-02');
 const d=detect(rows);assert.equal(mappingProblems(rows,d.mapping,{headerRow:0}).length,2);
});
test('병합된 연·월 값은 앞 행에서 이어받되 새로운 연도에 지난 월을 재사용하지 않음',()=>{
 const rows=[['연','월','일','입금','출금'],[2026,8,1,1000,''],['','',2,'',200],[2026,9,3,300,''],['','',4,'',100],[2027,'',5,100,'']];
 const r=preview(rows);assert.deepEqual(r.parsed.map(r=>r.txn_date),['2026-08-01','2026-08-02','2026-09-03','2026-09-04']);assert.equal(r.errors.length,1);
});
test('반복 헤더·소계 제외, 날짜가 있는 합계라는 적요는 거래로 보존',()=>{
 const rows=[['적요','날짜','입금','출금'],['첫거래','2026-08-01',1000,''],['적요','날짜','입금','출금'],['소계','',1000,''],['합계','2026-08-02','',100],['잘못된 날짜','2026-02-30','',200]];
 const r=preview(rows);assert.equal(r.parsed.length,2);assert.equal(r.skipped,2);assert.equal(r.errors.length,1);assert.equal(r.errors[0].row,6);
});
test('기억한 형식은 헤더 순서까지 동일할 때만 적용, 예전 프리셋은 무시',()=>{
 const rows=[['날짜','입금','출금'],['2026-08-01',1000,0]];const d=detect(rows);
 const p={version:2,columns:d.mapping,signature:headerSignature(d.headers)};
 assert.ok(matchingPreset(p,d,rows));
 const reordered=[['날짜','출금','입금'],['2026-08-01',0,1000]];
 assert.equal(matchingPreset(p,detect(reordered),reordered),undefined);
 assert.equal(matchingPreset({date:0,income:1,expense:2},d,rows),undefined);
});
test('중복 열과 범위 밖 매핑은 저장 전에 거부',()=>{
 const rows=[['날짜','금액'],['2026-08-01',1000]];
 assert.throws(()=>validateMapping({date:0,income:0},rows,0));assert.throws(()=>validateMapping({date:0,income:3},rows,0));
 assert.throws(()=>validateMapping({date:0,unknown:1},rows,0));
});
test('중복된 같은 이름의 금액 열은 한쪽을 임의 선택하지 않음',()=>{
 const d=detect([['날짜','금액','금액'],['2026-08-01',100,200]]);
 assert.equal(d.mapping.amount,undefined);assert.ok(d.ambiguous.includes('amount'));
});
test('연속 번호를 엑셀 시리얼 날짜로 잘못 추론하지 않음',()=>{
 const d=detect([['번호','입금액'],[45001,100],[45002,200]]);assert.equal(d.mapping.date,undefined);
});
test('표지 대신 거래가 있는 시트를 선택하고 XLS/XLSX 실제 파일 왕복 처리',()=>{
 for(const bookType of ['xlsx','xls'] as const){
  const wb=utils.book_new();utils.book_append_sheet(wb,utils.aoa_to_sheet([['은행 이용 안내']]),'표지');
  utils.book_append_sheet(wb,utils.aoa_to_sheet([[],[],['날짜','지급금액','예입금액','거래후잔액'],['2026-08-01',200,'',800],['2026-08-02','',300,1100]]),'거래내역');
  const reopened=read(write(wb,{type:'buffer',bookType}),{sheetRows:20002});
  const name=transactionSheet(reopened,'거래내역.'+bookType);assert.equal(name,'거래내역');const r=preview(sheetRows(reopened,name));assert.equal(r.parsed.length,2);assert.equal(r.d.headerRow,2);
 }
});
test('CSV 읽기부터 자동 인식·저장 파싱까지 같은 결과와 중복 해시 유지',async()=>{
 const wb=read('거래일시,적요,출금액,입금액,거래후잔액\n2026-08-01,수수료,100,,900\n2026-08-02,매출,,200,1100',{type:'string'});
 const rows=sheetRows(wb,wb.SheetNames[0]),r=preview(rows);
 const saved=await parseRows(rows,r.d.mapping,'account',[],[],[],{headerRow:r.d.headerRow});
 assert.equal(saved.parsed.length,r.parsed.length);assert.equal(saved.parsed[0].amount,r.parsed[0].amount);assert.equal(saved.parsed[0].dedup_hash.length,64);
});
test('한국어 날짜 및 월일 날짜 보완',()=>{assert.equal(parseDate('2026년 8월 7일 12:30'),'2026-08-07');assert.equal(parseDate('08/07',2026),'2026-08-07');});
test('반복 헤더에 항목이 더 있어도 앞쪽 거래를 버리지 않음',()=>{
 const rows=[['거래일','입금액','출금액','적요'],['2026-08-01',100,0,'A'],['2026-08-02',0,20,'B'],['거래일','입금액','출금액','적요','잔액'],['2026-08-03',200,0,'C',280]];
 const r=preview(rows);assert.equal(r.d.headerRow,0);assert.equal(r.parsed.length,3);assert.equal(r.skipped,1);
});
test('중간에 입출금 순서가 바뀌면 거래를 잘못 저장하지 않고 중단',()=>{
 const rows=[['거래일','입금액','출금액','적요'],['2026-08-01',100,0,'A'],['거래일','출금액','입금액','적요'],['2026-08-02',200,0,'B']];
 assert.throws(()=>preview(rows),/열 순서/);
});
test('모두 출금 프리셋은 새로운 파일의 부호를 덮어쓰지 않음',()=>{
 const rows=[['날짜','금액','적요'],['2026-08-01',-100,'A'],['2026-08-02',200,'B']],d=detect(rows);
 const p=matchingPreset({version:2,columns:d.mapping,signature:headerSignature(d.headers),amountMode:'out'},d,rows)!;
 assert.equal(p.amountMode,'signed');assert.deepEqual(normalizeRows(rows,p.columns,[],[],[],{headerRow:d.headerRow,amountMode:p.amountMode}).parsed.map(r=>r.direction),['out','in']);
 const positive=[rows[0],rows[2]],positiveD=detect(positive);
 assert.equal(matchingPreset({...p,amountMode:'out'},positiveD,positive)?.amountMode,undefined);
});
test('연도 열과 시트명에 있는 월 조합을 최초 행부터 사용',()=>{
 const r=preview([['연도','일','입금액'],[2026,1,100],[2026,2,200]],'','11월');
 assert.deepEqual(r.parsed.map(r=>r.txn_date),['2026-11-01','2026-11-02']);assert.deepEqual(r.errors,[]);
});

const suppliedHeaders=['구분','거래일자','출금금액(원)','입금금액(원)','거래 후 잔액(원)','거래내용','거래기록사항','거래점','거래시간','이체메모'];
test('사용자 은행 형식: 구분이 순번이어도 전체 날짜와 양방향 금액 보존',()=>{
 const rows=[suppliedHeaders,[1,'2017.01.02',1200,0,8800,'출금','기록','본점','09:30:00',''],[2,'2026.12.31',0,2000,10800,'입금','','본점','15:00:00',''],[3,'2031.01.01',300,0,10500,'출금','','본점','10:00:00','']];
 const r=preview(rows);assert.equal(r.d.mapping.date,1);assert.equal(r.d.mapping.direction,undefined);assert.equal(r.d.mapping.description,5);
 assert.deepEqual(r.parsed.map(row=>[row.txn_date,row.direction,row.amount]),[['2017-01-02','out',1200],['2026-12-31','in',2000],['2031-01-01','out',300]]);assert.deepEqual(r.errors,[]);
});
test('한 시트 365일 전체를 인식하고 첫 8건 이후와 마지막 페이지도 조회',()=>{
 const rows:unknown[][]=[suppliedHeaders];for(let i=0;i<365;i++){const date=new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10);rows.push([i+1,date,i%2?100:0,i%2?0:200,1000,`거래${i}`]);}
 const r=preview(rows),all=r.parsed.map(row=>({...row,sheet:'거래내역'})),summary=transactionOverview(all);
 assert.equal(all.length,365);assert.equal(summary.from,'2025-01-01');assert.equal(summary.to,'2025-12-31');assert.equal(summary.months.length,12);assert.equal(summary.incomeCount,183);assert.equal(summary.expenseCount,182);
 const last=previewPage(all,'all','all',999);assert.equal(last.current,7);assert.equal(last.rows.at(-1)?.txn_date,'2025-12-31');
 const december=previewPage(all,'out','2025-12',0);assert.ok(december.rows.every(row=>row.direction==='out'&&row.txn_date.startsWith('2025-12')));assert.equal(all.length,365);
});
test('월별 모든 거래 시트 통합 및 표지 제외, 미리보기와 저장의 원본 시트 보존',()=>{
 const wb=utils.book_new();utils.book_append_sheet(wb,utils.aoa_to_sheet([['이용 안내']]),'표지');
 for(const [month,direction] of [[1,'in'],[2,'out'],[12,'in']] as const)utils.book_append_sheet(wb,utils.aoa_to_sheet([['일자','입금금액(원)','출금금액(원)'],[1,direction==='in'?100:0,direction==='out'?50:0]]),`2025년 ${month}월`);
 const reopened=readTransactions(write(wb,{type:'array',bookType:'xlsx'}));
 const plans:SheetPlan[]=transactionSheets(reopened,'거래내역.xlsx').map(s=>({...s,mapping:s.detected.mapping,options:{headerRow:s.detected.headerRow,year:s.detected.year,month:s.detected.month}}));
 assert.equal(plans.filter(p=>p.selected).length,3);assert.equal(plans[0].selected,false);
 const r=previewSheets(plans,[],[],[]),summary=transactionOverview(r.parsed);assert.equal(r.parsed.length,3);assert.deepEqual(r.errors,[]);assert.deepEqual(r.problems,[]);assert.equal(summary.from,'2025-01-01');assert.equal(summary.to,'2025-12-01');assert.equal(summary.income,200);assert.equal(summary.expense,50);
});
test('연월 구간 제목이 바뀌면 연말·연초의 같은 일자도 다른 날짜로 보존',async()=>{
 const rows=[['2025년 12월'],['일자','입금','출금','적요'],[1,100,0,'매출'],['2026년 1월'],['일자','입금','출금','적요'],[1,100,0,'매출']];
 const d=detect(rows),r=await parseRows(rows,d.mapping,'account',[],[],[],{headerRow:d.headerRow,year:d.year,month:d.month});
 assert.deepEqual(r.parsed.map(row=>row.txn_date),['2025-12-01','2026-01-01']);assert.notEqual(r.parsed[0].dedup_hash,r.parsed[1].dedup_hash);assert.deepEqual(r.errors,[]);
});
test('실제로 병합된 날짜만 채우며 일반 빈 날짜와 금액은 복제하지 않음',()=>{
 const wb=utils.book_new(),ws=utils.aoa_to_sheet([['거래일자','입금','출금'],['2025-01-01',100,0],['',0,50],['',0,20],['',0,10]]);ws['!merges']=[{s:{r:1,c:0},e:{r:3,c:0}}];utils.book_append_sheet(wb,ws,'거래');
 const r=preview(sheetRows(readTransactions(write(wb,{type:'array',bookType:'xlsx'})),'거래'));assert.equal(r.parsed.length,3);assert.equal(r.errors.length,1);assert.equal(r.errors[0].row,5);assert.deepEqual(r.parsed.map(row=>row.amount),[100,50,20]);
});
test('음수 거래가 30행 뒤에 있어도 단일 금액의 방향을 전체 행에서 인식',()=>{
 const rows:unknown[][]=[['날짜','금액']];for(let i=0;i<40;i++)rows.push([`2025-01-${String(i%28+1).padStart(2,'0')}`,100]);rows.push(['2025-12-31',-50]);
 const r=preview(rows);assert.equal(r.d.amountMode,'signed');assert.equal(r.parsed.length,41);assert.equal(r.parsed.at(-1)?.direction,'out');
});
test('입금액·인출액 모두 인식하여 출금 날짜를 누락하지 않음',()=>{
 const r=preview([['날짜','입금액','인출액'],['2025-01-01',100,0],['2025-12-31',0,50]]);assert.equal(r.parsed.length,2);assert.deepEqual(r.errors,[]);assert.equal(r.parsed[1].direction,'out');
});
test('과거·미래 엑셀 시리얼 날짜와 존재하지 않는 날짜 검사',()=>{
 assert.equal(parseDate(42736),'2017-01-01');assert.equal(parseDate(47849),'2031-01-01');assert.throws(()=>parseDate(60));assert.throws(()=>parseDate('2025-02-29'));
});
test('날짜 서식이 있는 XLSX의 1900/1904 체계를 읽을 때 한국 시간대에서도 날짜 보존',()=>{
 for(const [date1904,serial,expected] of [[false,45658,'2025-01-01'],[true,44196,'2025-01-01'],[true,0,'1904-01-01'],[true,60,'1904-03-01']] as const){
  const wb=utils.book_new();wb.Workbook={WBProps:{date1904}};const ws=utils.aoa_to_sheet([['거래일자','입금','출금'],[serial,100,0]]);ws.A2.z='yyyy-mm-dd';utils.book_append_sheet(wb,ws,'거래');
  const r=preview(sheetRows(readTransactions(write(wb,{type:'array',bookType:'xlsx'})),'거래'));assert.deepEqual(r.errors,[]);assert.equal(r.parsed[0].txn_date,expected);
 }
});
test('반복 헤더 사이의 연월 없는 일자를 1900년 날짜로 저장하지 않음',()=>{
 const rows=[['날짜','입금','출금'],[1,100,0],['날짜','입금','출금'],[2,0,50]],d=detect(rows);
 const r=normalizeRows(rows,d.mapping,[],[],[],{headerRow:d.headerRow});assert.equal(r.parsed.length,0);assert.equal(r.errors.length,2);assert.throws(()=>parseDate(1));
});
