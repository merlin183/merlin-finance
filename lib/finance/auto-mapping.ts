import {parseAmount,parseDate,parseDirection,type Mapping,type ParseOptions} from './parser';

export const fieldLabels:Record<keyof Mapping,string>={date:'거래일',time:'거래시간',year:'연도',month:'월',day:'일',income:'입금',expense:'출금',amount:'거래금액',direction:'입출금 구분',description:'적요',category:'원과목',balance:'잔액',tax:'세금계산서'};
const aliases:Record<keyof Mapping,string[]>={
 date:['거래일시','거래일자','거래일','거래날짜','거래년월일','거래연월일','날짜','일자','일시','년월일','연월일','거래일자시간','거래일시간','transactiondate','transactiondatetime','datetime','date'],
 time:['거래시간','시간','transactiontime','time'],
 year:['연도','년도','년','연','year'],month:['월','거래월','month'],day:['일','거래일수','day'],
 income:['입금액','입금금액','입금','맡기신금액','맡기신돈','맡기신금액입금','입금맡기신금액','예입금액','예금액','받으신금액','받은금액','수입금액','수입','입금거래금액','deposit','depositamount','credit','creditamount','moneyin'],
 expense:['출금액','출금금액','출금','찾으신금액','찾으신돈','찾으신금액출금','출금찾으신금액','지급금액','인출금액','보내신금액','보낸금액','지출금액','지출','출금거래금액','withdrawal','withdrawalamount','debit','debitamount','moneyout','인출액','지급액'],
 amount:['거래금액','입출금액','입출금금액','금액','이체금액','금액부호','거래금액부호','amount','transactionamount','signedamount'],
 direction:['입출금구분','입금출금구분','입출금','수입지출구분','수지구분','입출구분','거래구분','구분','거래유형','direction','type','transactiontype'],
 description:['거래내용','통장표시내용','거래적요','적요','기재내용','내용','기본내역','세부내역','거래내역','보낸분받는분','보낸분받으신분','받는분보낸분','보낸사람받는사람','상대방','상대예금주','상대방명','메모','비고','description','details','memo','counterparty','payee'],
 category:['계정과목','과목','계정','분류','항목','과목명','category'],balance:['거래후잔액','거래후금액','잔액','잔액금액','통장잔액','예금잔액','거래잔액','balance','runningbalance'],tax:['세금계산서','세금계산서발행','세금계산서유무','세금계산서유무(발급일자기준)','증빙','taxinvoice'],
};
export const normalizeHeader=(value:unknown)=>String(value??'').normalize('NFKC').toLowerCase().replace(/\([^)]*(?:원|krw)[^)]*\)|\[[^\]]*(?:원|krw)[^\]]*\]/g,'').replace(/[\s\p{P}\p{S}]/gu,'').replace(/(?:단위원|단위krw|krw|원)$/,'');
const keys=Object.keys(aliases) as (keyof Mapping)[];
const normalizedAliases=Object.fromEntries(keys.map(key=>[key,aliases[key].map(normalizeHeader)])) as Record<keyof Mapping,string[]>;
export type Detection={headerRow:number;headerStart:number;mapping:Mapping;headers:string[];score:number;year?:number;month?:number;amountMode?:ParseOptions['amountMode'];ambiguous:(keyof Mapping)[]};
type DetectOptions={fileName?:string;sheetName?:string;headerRow?:number};
const value=(v:unknown)=>String(v??'').trim();
const isDate=(v:unknown)=>{try{parseDate(v);return true}catch{return false}};

function period(rows:unknown[][],headerRow:number,options:DetectOptions){
 const source=[options.fileName||'',options.sheetName||'',...rows.slice(0,headerRow).flat().map(value)].join(' ');
 const pairs=[...source.matchAll(/(?:^|[^\d])(20\d{2})\s*(?:년\s*|[-._/ ])(0?[1-9]|1[0-2])(?:월|[^\d]|$)/g)].map(m=>[Number(m[1]),Number(m[2])]);
 for(const m of source.matchAll(/(?:^|[^\d])(20\d{2})(0[1-9]|1[0-2])(?:[0-3]\d)?(?=[^\d]|$)/g))pairs.push([Number(m[1]),Number(m[2])]);
 const years=new Set(pairs.map(p=>p[0])),months=new Set(pairs.map(p=>p[1]));
 if(!years.size)for(const m of source.matchAll(/(20\d{2})\s*년/g))years.add(+m[1]);
 if(!months.size)for(const m of source.matchAll(/(?:^|[^\d])(0?[1-9]|1[0-2])\s*월/g))months.add(+m[1]);
 return {year:years.size===1?[...years][0]:undefined,month:months.size===1?[...months][0]:undefined};
}
function labelsAt(rows:unknown[][],start:number,end:number){
 const top=rows[start]||[],bottom=rows[end]||[];let parent='';
 return Array.from({length:Math.max(top.length,bottom.length)},(_,col)=>{
  if(start===end)return value(bottom[col]);
  if(value(top[col]))parent=value(top[col]);
  const child=value(bottom[col]);
  if(!child)return value(top[col]);
  if(keys.some(key=>normalizedAliases[key].includes(normalizeHeader(child)))&&!/^(금액|amount)$/i.test(child))return child;
  return parent+' '+child;
 });
}
function candidate(rows:unknown[][],start:number,end:number,options:DetectOptions):Detection{
 const headers=labelsAt(rows,start,end),mapping:Mapping={},ambiguous:(keyof Mapping)[]=[];
 const samples=rows.slice(end+1,end+31).filter(row=>row.some(v=>value(v)));
 for(const key of keys){
  const matches=headers.map((header,col)=>{
   const name=normalizeHeader(header),rank=normalizedAliases[key].indexOf(name);
   if(rank<0)return {col,score:0};
   const cells=samples.map(row=>row[col]).filter(v=>value(v));
   if(key==='direction'&&['구분','거래구분','거래유형','type'].includes(name)&&!cells.some(v=>parseDirection(v)))return {col,score:0};
   return {col,score:100-rank+(key==='date'&&cells.some(isDate)?20:0)};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  if(matches.length>1&&matches[0].score===matches[1].score){ambiguous.push(key);continue;}
  if(matches.length)mapping[key]=matches[0].col;
 }
 // Some banks label a full datetime column as 거래시간.
 if(mapping.date===undefined&&mapping.day===undefined&&mapping.time!==undefined){
  const cells=samples.map(row=>row[mapping.time!]).filter(v=>value(v));
  if(cells.length&&cells.every(isDate)){mapping.date=mapping.time;delete mapping.time;}
 }
 // A date column with an unfamiliar label is safe to infer only from several actual dates.
 if(mapping.date===undefined&&mapping.day===undefined){
  const dateCols=headers.map((_,col)=>{const cells=samples.map(row=>row[col]).filter(v=>value(v));return {col,cells}})
   .filter(({col,cells})=>!Object.values(mapping).includes(col)&&cells.length>=2&&cells.some(v=>typeof v==='string'&&/\d[-./년]\s*\d/.test(v))&&cells.filter(isDate).length/cells.length>=.8);
  if(dateCols.length===1)mapping.date=dateCols[0].col;
 }
 const context=period(rows,start,options);
 if(mapping.date!==undefined){const cells=samples.map(r=>r[mapping.date!]).filter(v=>value(v));if(cells.length&&cells.every(v=>/^\d{1,2}$/.test(value(v))&&+value(v)>=1&&+value(v)<=31)){mapping.day=mapping.date;delete mapping.date;}}
 let amountMode:Detection['amountMode'];
 if(mapping.amount!==undefined&&mapping.income===undefined&&mapping.expense===undefined&&mapping.direction===undefined){
  const h=headers[mapping.amount];
  if(/[±]|부호|signed/i.test(h)||samples.some(r=>{try{return parseAmount(r[mapping.amount!])<0}catch{return false}}))amountMode='signed';
 }
 const dateField=mapping.date!==undefined||mapping.day!==undefined;
 const moneyField=mapping.income!==undefined||mapping.expense!==undefined||mapping.amount!==undefined;
 const score=Object.keys(mapping).length+(dateField?8:0)+(moneyField?8:0)+(dateField&&moneyField?12:0)-(end-start)*.1;
 return {headerRow:end,headerStart:start,mapping,headers,score,...context,amountMode,ambiguous};
}
export function detect(rows:unknown[][],options:DetectOptions={}):Detection{
 let best:Detection={headerRow:0,headerStart:0,mapping:{},headers:[],score:-1,ambiguous:[]};
 const from=options.headerRow??0,to=options.headerRow!==undefined?from+1:Math.min(rows.length,100);
 for(let row=from;row<to;row++){
  for(const start of row>0?[row,row-1]:[row]){
   const result=candidate(rows,start,row,options);
   const hasEarlierTrades=best.score>=28&&rows.slice(best.headerRow+1,start).some(row=>{
    const date=row[best.mapping.date??best.mapping.day??-1];
    if(!/\d/.test(value(date)))return false;
    return (['income','expense','amount'] as const).some(key=>{const col=best.mapping[key];try{return col!==undefined&&parseAmount(row[col])!==0}catch{return false}});
   });
   if(result.score>best.score&&!hasEarlierTrades)best=result;
  }
 }
 // The header search is bounded; direction evidence comes from the entire sheet.
 if(best.mapping.amount!==undefined&&best.mapping.income===undefined&&best.mapping.expense===undefined&&best.mapping.direction===undefined){
  if(rows.slice(best.headerRow+1).some(row=>{try{return parseAmount(row[best.mapping.amount!])<0}catch{return false}}))best.amountMode='signed';
 }
 return best;
}
export function mappingProblems(rows:unknown[][],mapping:Mapping,opts:ParseOptions){
 const problems:string[]=[];
 if(opts.year!==undefined&&(!Number.isInteger(opts.year)||opts.year<1900||opts.year>9999))problems.push('기준 연도는 네 자리의 올바른 연도로 입력해주세요.');
 if(opts.month!==undefined&&(!Number.isInteger(opts.month)||opts.month<1||opts.month>12))problems.push('기준 월은 1~12월로 입력해주세요.');
 if(mapping.date===undefined&&mapping.day===undefined)problems.push('거래일 열을 찾지 못했습니다.');
 if(mapping.income===undefined&&mapping.expense===undefined&&mapping.amount===undefined)problems.push('입금·출금 또는 거래금액 열을 찾지 못했습니다.');
 if(mapping.amount!==undefined&&mapping.income===undefined&&mapping.expense===undefined&&mapping.direction===undefined&&!opts.amountMode)problems.push('금액만 있어 입출금 방향을 확인해야 합니다.');
 const sample=rows.slice(opts.headerRow+1).filter(row=>row.some(v=>value(v)));
 if(mapping.day!==undefined){
  if(!opts.year&&(mapping.year===undefined||!sample.some(r=>value(r[mapping.year!]))))problems.push('일자에 사용할 기준 연도를 확인해주세요.');
  if(!opts.month&&(mapping.month===undefined||!sample.some(r=>value(r[mapping.month!]))))problems.push('일자에 사용할 기준 월을 확인해주세요.');
 }
 return problems;
}
export function validateMapping(input:unknown,rows:unknown[][],headerRow:number):Mapping{
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('열 인식 결과가 올바르지 않습니다.');
 const max=Math.max(0,...rows.slice(headerRow,headerRow+31).map(r=>r.length));
 const mapping:Mapping={};
 for(const [key,col] of Object.entries(input)){
  if(!keys.includes(key as keyof Mapping)||!Number.isInteger(col)||col<0||col>=max||col>200)throw Error('열 인식 결과가 파일 범위를 벗어났습니다.');
  mapping[key as keyof Mapping]=col;
 }
 if(new Set(Object.values(mapping)).size!==Object.values(mapping).length)throw Error('같은 열을 두 항목에 사용할 수 없습니다.');
 return mapping;
}
// Stored JSON lives in the existing JSONB column; legacy presets remain readable but
// are never applied automatically without a matching header signature.
export type MappingPreset={version:2;columns:Mapping;signature:string;amountMode?:ParseOptions['amountMode']};
export function headerSignature(headers:string[]){return JSON.stringify(headers.map(normalizeHeader));}
export function matchingPreset(raw:unknown,detected:Detection,rows:unknown[][]):MappingPreset|undefined{
 if(!raw||typeof raw!=='object')return;
 const p=raw as MappingPreset;
 if(p.version!==2||p.signature!==headerSignature(detected.headers))return;
 if(p.amountMode!==undefined&&!['signed','in','out'].includes(p.amountMode))return;
 try{return {...p,columns:validateMapping(p.columns,rows,detected.headerRow),amountMode:detected.amountMode||(p.amountMode==='signed'?'signed':undefined)}}catch{return;}
}
