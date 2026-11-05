import {read,utils,type WorkBook} from '@e965/xlsx';
import {detect,normalizeHeader} from './auto-mapping';

export function normalizeExcelDate(value:Date){
 const milliseconds=value.getUTCMilliseconds();
 // Excel serial conversion can land 1 ms either side of an exact second:
 // multiplying by 24*60*60*1000 vs 86400000 changes intermediate rounding.
 // Correct that boundary only; genuine subsecond values remain untouched.
 return milliseconds===1||milliseconds===999?new Date(Math.round(value.getTime()/1000)*1000):value;
}
export function readTransactions(buffer:ArrayBuffer){
 const workbook=read(buffer,{type:'array',cellDates:true,UTC:true,codepage:65001,sheetRows:20002});
 for(const sheet of Object.values(workbook.Sheets))for(const address of Object.keys(sheet)){
  if(address.startsWith('!'))continue;
  const cell=sheet[address];if(cell?.t==='d'&&cell.v instanceof Date)cell.v=normalizeExcelDate(cell.v);
 }
 return workbook;
}
export function sheetRows(wb:WorkBook,name:string,scanOnly=false):unknown[][]{
 const sheet=wb.Sheets[name];if(!sheet)throw Error('거래 시트를 찾지 못했습니다.');
 const range=utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1');
 if(range.e.c>200)throw Error('열이 201개를 넘습니다. 거래내역이 있는 열만 남겨주세요.');
 if(!scanOnly&&range.e.r>20000)throw Error('시트당 20,000행 이하로 나누어 업로드하세요.');
 const rows=utils.sheet_to_json<unknown[]>(sheet,{header:1,defval:'',UTC:true,range:{s:{r:0,c:0},e:{r:Math.min(range.e.r,scanOnly?130:20000),c:range.e.c}}});
 const detected=detect(rows),mapping=detected.mapping;
 if(mapping.date===undefined&&mapping.day!==undefined&&mapping.year!==undefined&&mapping.month!==undefined){
  for(let row=detected.headerRow+1;row<rows.length;row++){
   const value=rows[row][mapping.day],cell=sheet[utils.encode_cell({r:row,c:mapping.day})];
   if(!(value instanceof Date)||!Number.isFinite(value.getTime())||value.getUTCFullYear()<1901)continue;
   // Only a literal day-only display with explicit numeric year/month can
   // override an unrelated hidden date. A visible full date remains strict.
   if(!/^\d{1,2}(?:일)?$/.test(String(cell?.w||'')))continue;
   if(value.getUTCHours()||value.getUTCMinutes()||value.getUTCSeconds()||value.getUTCMilliseconds())continue;
   const year=Number(String(rows[row][mapping.year]).replace(/년$/,'')),month=Number(String(rows[row][mapping.month]).replace(/월$/,'')),day=Number(String(cell.w).replace(/일$/,''));
   if(!Number.isInteger(year)||year<1901||year>9999||!Number.isInteger(month)||month<1||month>12||day<1||day>31||day!==value.getUTCDate())continue;
   if(value.getUTCFullYear()!==year||value.getUTCMonth()+1!==month)rows[row][mapping.day]=day;
  }
 }
 // Fill only explicitly merged date cells. Never duplicate merged money cells.
 if(sheet['!merges']?.length){const columns=new Set([mapping.date,mapping.year,mapping.month,mapping.day].filter(c=>c!==undefined));
  for(const merge of sheet['!merges'])if(merge.s.c===merge.e.c&&columns.has(merge.s.c)&&merge.s.r>detected.headerRow){
   for(let r=merge.s.r+1;r<=Math.min(merge.e.r,rows.length-1);r++)if(rows[r][merge.s.c]==='')rows[r][merge.s.c]=rows[merge.s.r][merge.s.c];
  }
 }
 return rows;
}
function businessTransferReport(rows:unknown[][],fileName:string,sheetName:string){
 const headers=rows.slice(0,100);
 const hasTransferHeader=headers.some(row=>{
  const labels=new Set(row.map(normalizeHeader));
  const sender=labels.has('보낸사업자')||labels.has('보내는사업자')||labels.has('사업자a');
  const receiver=labels.has('받은사업자')||labels.has('받는사업자')||labels.has('사업자b');
  const loanColumns=[...labels].some(label=>/대여|상환|순증감|순채권|순채무/.test(label));
  const recordColumns=labels.has('기록id')&&labels.has('상태')&&labels.has('버전');
  return sender&&receiver&&(loanColumns||recordColumns);
 });
 if(!hasTransferHeader)return false;
 // A report's data can contain the words 입금/출금. Require actual header
 // labels for bank evidence rather than allowing inferred dates from those
 // data rows to turn the report into a second bank ledger.
 return !headers.some((_,headerRow)=>{
  const labelRows=headers.slice(Math.max(0,headerRow-1),headerRow+1);
  const mapping=detect(labelRows,{headerRow:labelRows.length-1}).mapping;
  if(mapping.date===undefined&&mapping.day===undefined)return false;
  if(mapping.income!==undefined||mapping.expense!==undefined)return true;
  if(mapping.amount===undefined)return false;
  const detected=detect(rows,{fileName,sheetName,headerRow});
  return mapping.balance!==undefined||detected.mapping.direction!==undefined||detected.amountMode!==undefined;
 });
}
export function transactionSheets(wb:WorkBook,fileName:string){
 return wb.SheetNames.filter(name=>!wb.Workbook?.Sheets?.find(s=>s.name===name)?.Hidden).map(name=>{
  const rows=sheetRows(wb,name),detected=detect(rows,{fileName,sheetName:name});
  const m=detected.mapping;
  return {name,rows,detected,selected:(m.date!==undefined||m.day!==undefined)&&(m.income!==undefined||m.expense!==undefined||m.amount!==undefined)&&!businessTransferReport(rows,fileName,name)};
 });
}
export function transactionSheet(wb:WorkBook,fileName:string){
 let selected=wb.SheetNames[0],score=-1;
 for(const name of wb.SheetNames){
  if(wb.Workbook?.Sheets?.find(s=>s.name===name)?.Hidden)continue;
  try{const result=detect(sheetRows(wb,name,true),{fileName,sheetName:name});if(result.score>score){selected=name;score=result.score;}}catch{/* A non-transaction sheet does not block other sheets. */}
 }
 if(!selected)throw Error('엑셀에 읽을 수 있는 시트가 없습니다.');return selected;
}
