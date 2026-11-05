import type {Alias,Category,Rule,SourceDetails} from './types';
import {isHistoricalCompletionCategory,isHistoricalDate,needsCategoryReview,resolveHistoricalCompletion} from './category-status';
import {extractSourceDetails} from './source-details';
export type Mapping=Partial<Record<'date'|'time'|'year'|'month'|'day'|'income'|'expense'|'amount'|'direction'|'description'|'category'|'balance'|'tax',number>>;
export type ParsedRow={txn_date:string;txn_time?:string|null;source_sheet?:string|null;source_row?:number;source_details?:SourceDetails|null;amount:number;direction:'in'|'out';description:string;raw_gwamok:string;balance:number|null;tax_invoice:boolean;category_id:string|null;is_internal:boolean;dedup_hash:string;manually_classified:boolean};
const text=(v:unknown)=>String(v??'').trim();
function dateComponent(value:unknown,part:'year'|'month'|'day'):number|undefined{
 if(!text(value))return undefined;
 let component:number;
 if(value instanceof Date){
  if(!Number.isFinite(value.getTime()))throw Error('날짜 형식의 연·월·일 값을 확인하세요.');
  if(part!=='year'&&value.getUTCFullYear()<=1900){
   // Sheets can export a small month/day number with a date format. Recover
   // only the unambiguous integer serial, not an arbitrary 1900 calendar day.
   component=(value.getTime()-Date.UTC(1899,11,31))/86400000;
  }else component=part==='year'?value.getUTCFullYear():part==='month'?value.getUTCMonth()+1:value.getUTCDate();
 }else component=Number(text(value).normalize('NFKC').replace(part==='year'?/년$/:part==='month'?/월$/:/일$/,''));
 const min=part==='year'?1900:1,max=part==='year'?9999:part==='month'?12:31;
 if(!Number.isInteger(component)||component<min||component>max)throw Error('올바른 연·월·일인지 확인하세요.');
 return component;
}
function validDate(y:number,m:number,d:number){if(!Number.isInteger(y)||y<1900||y>9999||m<1||m>12||d<1||d>31)throw Error('올바른 연·월·일인지 확인하세요.');const value=new Date(Date.UTC(y,m-1,d));if(value.getUTCMonth()!==m-1||value.getUTCDate()!==d)throw Error('존재하지 않는 날짜입니다.');return value.toISOString().slice(0,10)}
export function parseDate(value:unknown,year?:unknown,month?:unknown):string {
 if(value instanceof Date&&!isNaN(value.getTime()))return validDate(value.getUTCFullYear(),value.getUTCMonth()+1,value.getUTCDate());
 const str=text(value).normalize('NFKC').replace(/년\s*/g,'-').replace(/월\s*/g,'-').replace(/일/g,'').replace(/\s*([-./])\s*/g,'$1');
 const n=Number(str);
 if(str&&Number.isFinite(n)){
  if(Number.isInteger(n)&&n>=1&&n<=31){if(!year||!month)throw Error('일자에 사용할 연·월을 확인하세요.');return validDate(Number(year),Number(month),n);}
  if(n>=1&&n<2958466){const serial=Math.floor(n);if(serial===60)throw Error('존재하지 않는 날짜입니다.');const d=new Date(Date.UTC(1899,11,31)+(serial-(serial>60?1:0))*86400000);return validDate(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate())}
 }
 const matched=str.match(/^(\d{4}|\d{2})[-./](\d{1,2})[-./](\d{1,2})(?:\s|T|\(|$)/);
 if(matched)return validDate(Number(matched[1])+(matched[1].length===2?2000:0),Number(matched[2]),Number(matched[3]));
 const compact=str.match(/^(\d{4})(\d{2})(\d{2})(?:\s|T|$)/);
 if(compact)return validDate(+compact[1],+compact[2],+compact[3]);
 const short=str.match(/^(\d{1,2})[-./](\d{1,2})(?:\s|T|$)/);
 if(short&&year)return validDate(Number(year),+short[1],+short[2]);
 throw Error('날짜를 해석할 수 없습니다. 연·월 또는 날짜 열을 확인하세요.');
}
export function parseAmount(value:unknown){if(value===undefined||value===null||text(value)===''||/^[-—–]$/.test(text(value)))return 0;let s=text(value).normalize('NFKC').replace(/KRW/ig,'').replace(/[,₩원\s]/g,'').replace(/−/g,'-');if(/^\(\d+(?:\.0+)?\)$/.test(s))s='-'+s.slice(1,-1);s=s.replace(/\.0+$/,'');if(!/^[+-]?\d+$/.test(s))throw Error('금액은 원 단위 정수여야 합니다.');const n=Number(s);if(!Number.isSafeInteger(n))throw Error('금액이 처리 가능한 범위를 벗어났습니다.');return n;}
export function parseDirection(value:unknown):'in'|'out'|undefined{const s=text(value).toLowerCase().replace(/\s/g,'');if(/^(입금|입|수입|수납|예입|받음|in|credit|cr|deposit|입금거래)$/.test(s))return 'in';if(/^(출금|출|지출|지급|인출|보냄|out|debit|dr|withdrawal|출금거래)$/.test(s))return 'out';}
export function safePattern(pattern:string){if(!pattern||pattern.length>120)throw Error('규칙은 1~120자로 입력하세요.');if(/\\[1-9]|\(\?[=!<]|\([^)]*[+*{][^)]*\)[+*{]|(?:\.\*){2}/.test(pattern))throw Error('복잡한 정규식은 사용할 수 없습니다. 단어 또는 | 로 구분한 패턴을 사용하세요.');if(/[+*?{}]/.test(pattern.replace(/\\./g,'')))throw Error('반복 연산자는 사용할 수 없습니다. 단어, |, ^, $를 사용하세요.');return new RegExp(pattern,'i')}
export type ClassificationContext={account_id?:string;direction?:'in'|'out';txn_date?:string};
/** Compile one dataset snapshot for a batch; never cache another user's data globally. */
export function createClassifier(categories:Category[],rules:Rule[],aliases:Alias[]){
 const byName=new Map<string,Category>(),byId=new Map<string,Category>(),aliasNames=new Map<string,string>();
 for(const category of categories){if(!byName.has(category.name))byName.set(category.name,category);if(!byId.has(category.id))byId.set(category.id,category);}
 for(const alias of aliases)if(!aliasNames.has(alias.raw_name))aliasNames.set(alias.raw_name,alias.standard_name);
 const compileRules=()=>[...rules].sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id)).flatMap(rule=>{
  if(isHistoricalCompletionCategory(byId.get(rule.category_id)?.name))return [];
  try{return [{rule,pattern:safePattern(rule.pattern),category:byId.get(rule.category_id)}];}catch{return [];}
 });
 let compiled:ReturnType<typeof compileRules>|undefined;
 return (raw:string,description:string,context:ClassificationContext={})=>{
  const trimmed=raw.trim(),normalized=aliasNames.get(trimmed)||trimmed;
  // A supplied ledger category is authoritative, even when a broad rule matches.
  const explicit=normalized==='미매핑'?undefined:byName.get(normalized);
  if(explicit&&!needsCategoryReview(explicit.name))return {category_id:explicit.id,is_internal:explicit.is_internal};
  compiled??=compileRules();
  for(const {rule,pattern,category} of compiled){
   if(!category||(rule.account_id&&rule.account_id!==context.account_id)||(rule.direction&&rule.direction!==context.direction))continue;
   const source=rule.field==='raw_gwamok'?normalized:description;
   if(pattern.test(source.slice(0,1000))){
    const completed=resolveHistoricalCompletion(categories,context.txn_date,category.id);
    return {category_id:completed?.id??category.id,is_internal:completed?completed.is_internal:rule.is_internal||category.is_internal};
   }
  }
  const unresolved=explicit||byName.get('미매핑');
  const category=resolveHistoricalCompletion(categories,context.txn_date,unresolved?.id)||unresolved;
  return {category_id:category?.id??null,is_internal:category?.is_internal??false};
 };
}
export function classify(raw:string,description:string,categories:Category[],rules:Rule[],aliases:Alias[],context:ClassificationContext={}){
 return createClassifier(categories,rules,aliases)(raw,description,context);
}
export function parseBalance(value:unknown){return value===undefined||value===null||text(value)===''||/^[-—–]$/.test(text(value))?null:parseAmount(value);}
export function parseTime(value:unknown):string|null{
 if(value instanceof Date&&!isNaN(value.getTime()))return [value.getUTCHours(),value.getUTCMinutes(),value.getUTCSeconds()].map(n=>String(n).padStart(2,'0')).join(':');
 if(typeof value==='number'&&value>=0&&value<1){const seconds=Math.round(value*86400);if(seconds<86400)return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');}
 const m=text(value).match(/(?:^|[T\s])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
 return m&&+m[1]<24&&+m[2]<60&&+(m[3]||0)<60?`${m[1].padStart(2,'0')}:${m[2]}:${m[3]||'00'}`:null;
}
export async function digest(account:string,date:string,amount:number,direction:string,description:string,balance?:number|null){const parts=[account,date,amount,direction,description];const withBalance=balance!==undefined&&balance!==null;const data=new TextEncoder().encode((withBalance?['v2',...parts,balance]:parts).join('|'));const hash=await crypto.subtle.digest(withBalance?'SHA-256':'SHA-1',data);return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export type ParseOptions={headerRow:number;year?:number;month?:number;amountMode?:'signed'|'in'|'out';accountId?:string;completeHistorical?:boolean};
export type NormalizedRow=Omit<ParsedRow,'dedup_hash'>&{source_row:number};
function resolveDate(value:unknown,split:boolean,year:number|undefined,month:number|undefined,explicitYear?:number,explicitMonth?:number){
 if(!split)return parseDate(value,year,month);
 const isFullDate=value instanceof Date&&Number.isFinite(value.getTime())&&value.getUTCFullYear()>=1901;
 const dayValue=value instanceof Date&&!isFullDate?dateComponent(value,'day'):value;
 const date=parseDate(dayValue,year,month);
 const y=Number(date.slice(0,4)),m=Number(date.slice(5,7));
 if((explicitYear!==undefined&&explicitYear!==y)||(explicitMonth!==undefined&&explicitMonth!==m))throw Error('일 열의 전체 날짜와 연·월 열이 일치하지 않습니다. 원본 날짜를 확인하세요.');
 return date;
}
export function normalizeRows(rows:unknown[][],mapping:Mapping,categories:Category[],rules:Rule[],aliases:Alias[],opts:ParseOptions){
 const parsed:NormalizedRow[]=[];const errors:{row:number;message:string}[]=[];let skipped=0;
 const classifyRow=createClassifier(categories,rules,aliases);
 if(mapping.date===undefined&&mapping.day===undefined)throw Error('거래일을 찾지 못했습니다. 날짜 열만 확인해주세요.');
 if(mapping.income===undefined&&mapping.expense===undefined&&mapping.amount===undefined)throw Error('거래금액을 찾지 못했습니다. 입출금 열만 확인해주세요.');
 let currentYear=opts.year,currentMonth=opts.month;
 const clean=(v:unknown)=>text(v).replace(/\s/g,'');
 const header=rows[opts.headerRow]||[];
 const sourceHeaders=header.map((value,column)=>text(value)||rows[opts.headerRow-1]?.[column]);
 for(let i=opts.headerRow+1;i<rows.length;i++){
  const row=rows[i];if(!row.some(v=>text(v)))continue;
  const get=(key:keyof Mapping)=>mapping[key]===undefined?undefined:row[mapping[key]!];
  const rowDate=(year=currentYear,month=currentMonth)=>{const y=dateComponent(get('year'),'year'),m=dateComponent(get('month'),'month');return resolveDate(get('date')??get('day'),mapping.date===undefined&&mapping.day!==undefined,y??year,m??month,y,m);};
  // Explicit month/year section labels apply to subsequent day-only rows.
  const nonempty=row.filter(v=>text(v));
  const section=nonempty.length===1?text(nonempty[0]).match(/^(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월(?:\s*거래(?:내역)?)?$/):null;
  if(section&&Number(section[2])>=1&&Number(section[2])<=12){if(section[1])currentYear=Number(section[1]);currentMonth=Number(section[2]);skipped++;continue;}
  // Repeated page headers and explicit subtotal/footer labels are not transactions.
  const matched=Object.values(mapping).filter(col=>text(header[col!])&&clean(row[col!])===clean(header[col!])).length;
  if(matched>=2){
   let actualDate=false;try{rowDate();actualDate=true;}catch{/* Repeated header. */}
   if(!actualDate){
    const changed=(['date','year','month','day','income','expense','amount','direction'] as const).some(key=>{const col=mapping[key];return col!==undefined&&text(header[col])&&text(row[col])&&clean(row[col])!==clean(header[col]);});
    if(changed)throw Error('파일 중간에 날짜·입출금 열 순서가 달라집니다. 거래 표를 시트별로 나누어 올려주세요.');
    skipped++;continue;
   }
  }
  const first=text(row.find(v=>text(v)));
  if(/^(?:총\s*합계|합계|소계|월계|누계|전월이월|이월잔액|기초잔액|조회건수|조회결과\s*없음|total|subtotal)(?:\s|[:：]|$)/i.test(first)){
   let hasDate=false;try{rowDate();hasDate=true;}catch{/* Footer label, without a transaction date. */}
   if(!hasDate){skipped++;continue;}
  }
  try{
   let y:number|undefined,m:number|undefined;
   try{y=dateComponent(get('year'),'year');m=dateComponent(get('month'),'month');}catch(e){currentYear=undefined;currentMonth=undefined;throw e;}
   if(y!==undefined){if(currentYear!==undefined&&currentYear!==y&&m===undefined)currentMonth=undefined;currentYear=y;}
   if(m!==undefined)currentMonth=m;
   const date=resolveDate(get('date')??get('day'),mapping.date===undefined&&mapping.day!==undefined,currentYear,currentMonth,y,m);
   // A complete date is also valid context for subsequent merged/blank cells.
   currentYear=Number(date.slice(0,4));currentMonth=Number(date.slice(5,7));
   let income=parseAmount(get('income')),expense=parseAmount(get('expense'));
   let reversalNote='';
   if(income&&expense)throw Error('입금과 출금이 모두 있어 방향을 확인해야 합니다.');
   // A signed value in one split column reverses that column's cash effect.
   // Preserve both the original posting and the reversal as distinct rows.
   if(income<0){reversalNote=`원본 입금 ${income}원: 음수 입금을 출금으로 반영`;expense=-income;income=0;}
   else if(expense<0){reversalNote=`원본 출금 ${expense}원: 음수 출금을 입금으로 반영`;income=-expense;expense=0;}
   if(mapping.income===undefined&&mapping.expense===undefined){
    const amount=parseAmount(get('amount'));
    const direction=mapping.direction!==undefined?parseDirection(get('direction')):opts.amountMode==='in'||opts.amountMode==='out'?opts.amountMode:undefined;
    if(mapping.direction!==undefined&&!direction)throw Error('입출금 구분을 해석할 수 없습니다.');
    if(direction==='in'&&amount<0)throw Error('입금 구분과 음수 금액이 일치하지 않습니다.');
    if(direction){income=direction==='in'?Math.abs(amount):0;expense=direction==='out'?Math.abs(amount):0;}
    else{income=Math.max(amount,0);expense=Math.max(-amount,0);}
   }
   if(income>0&&expense>0)throw Error('입금과 출금이 모두 있어 방향을 확인해야 합니다.');
   if(!income&&!expense)throw Error('0원 또는 거래금액이 없는 행입니다.');
   const description=text(get('description')).slice(0,1000),raw=text(get('category')).slice(0,120);
   let sourceDetails=extractSourceDetails(sourceHeaders,row);
   if(reversalNote){
    const note=[sourceDetails?.note,reversalNote].filter(Boolean).join(' · ');
    if(note.length>1000)throw Error('음수 거래의 원본 비고가 너무 깁니다. 비고를 900자 이내로 줄여주세요.');
    sourceDetails={...sourceDetails,note};
   }
   const day=get('day');const fullDayTime=day instanceof Date&&day.getUTCFullYear()>=1901&&(day.getUTCHours()||day.getUTCMinutes()||day.getUTCSeconds()||day.getUTCMilliseconds())?day:undefined;
   const classification=classifyRow(raw,description,{account_id:opts.accountId,direction:income>0?'in':'out',...(opts.completeHistorical===false?{}:{txn_date:date})});
   const completed=opts.completeHistorical!==false&&isHistoricalDate(date)&&isHistoricalCompletionCategory(categories.find(category=>category.id===classification.category_id)?.name);
   parsed.push({source_row:i+1,txn_date:date,txn_time:parseTime(get('time')??get('date')??fullDayTime),amount:income||expense,direction:income>0?'in':'out',description,raw_gwamok:raw,
    source_details:sourceDetails,
    balance:parseBalance(get('balance')),
    tax_invoice:/^(y|yes|true|1|발행|있음|o|○)$/i.test(text(get('tax'))),...classification,manually_classified:completed});
  }catch(e){errors.push({row:i+1,message:e instanceof Error?e.message:'처리할 수 없는 행입니다.'});}
 }
 return {parsed,errors,skipped};
}
export async function parseRows(rows:unknown[][],mapping:Mapping,account:string,categories:Category[],rules:Rule[],aliases:Alias[],opts:ParseOptions){
 const result=normalizeRows(rows,mapping,categories,rules,aliases,{...opts,accountId:account});const parsed:ParsedRow[]=[];
 for(const row of result.parsed)parsed.push({...row,dedup_hash:await digest(account,row.txn_date,row.amount,row.direction,row.description,row.balance)});
 return {...result,parsed};
}
