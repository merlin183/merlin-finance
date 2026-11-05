import type {IntercompanyBaseline} from './intercompany-register';

export type IntercompanySheetCell=string|number|boolean|null;
export type IntercompanySheetRaw={sourceTitle:string;sourceGid:string;mirrorTitle:string;mirrorGid:string;sourceValues:IntercompanySheetCell[][];sourceFormulas:IntercompanySheetCell[][];mirrorValues:IntercompanySheetCell[][];capturedAt:string;fingerprint:string};
export type IntercompanySourceRow={id:string;row:number;nativeId:string|null;date:string;fromParty:string;toParty:string;amount:number;kind:'loan'|'repayment';memo:string;financialPreimage:IntercompanySheetCell[]};
export type IntercompanyMirrorRow={id:string;row:number;date:string;fromParty:string;toParty:string;amount:number;kind:'loan'|'repayment';voided:boolean;version:number;memo:string;cells:(string|number)[]};
export type IntercompanyIdentifierWrite={row:number;value:string;expectedRow:IntercompanySheetCell[]};
export type IntercompanySourcePair={business_a:string;business_b:string;a_to_b:number;b_to_a:number;row:number;note:string;source_a_to_b:number;source_b_to_a:number;base_a_expression?:string;base_b_expression?:string};
export type IntercompanySourceIssue={row:number|null;code:string;message:string};
export type IntercompanySheetSource={sourceRows:IntercompanySourceRow[];historicalBasePairs:IntercompanySourcePair[];mirrorRows:IntercompanyMirrorRow[];identifierWrites:IntercompanyIdentifierWrite[];period:{sourceStart:string|null;ledgerThrough:string|null;sourceCheckedAt:string|null;raw:string};issues:IntercompanySourceIssue[];fingerprint:string;counts:{sourceRows:number;mirrorRows:number;pairs:number}};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceId=(value:string)=>uuid.test(value)||/^source-row-(?:4[89]|5[0-5])$/.test(value);
const text=(value:IntercompanySheetCell|undefined)=>value==null?'':String(value).trim();
const rowCells=(rows:IntercompanySheetCell[][],row:number)=>Array.from({length:9},(_,i)=>rows[row-1]?.[i]??null);
const blank=(value:IntercompanySheetCell)=>value===null||value==='';
const integer=(value:IntercompanySheetCell|undefined,zero=false)=>typeof value==='number'&&Number.isSafeInteger(value)&&(zero?value>=0:value>0)?value:null;
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function date(value:IntercompanySheetCell|undefined,year:number|null):string|null{
 if(typeof value==='number'){
  if(!Number.isInteger(value)||value<1||value>2958465)return null;
  const result=new Date(Date.UTC(1899,11,30)+value*86400000).toISOString().slice(0,10);return validDate(result)?result:null;
 }
 const raw=text(value);if(validDate(raw))return raw;
 const short=raw.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
 if(!short||year===null)return null;
 const result=`${year}-${short[1].padStart(2,'0')}-${short[2].padStart(2,'0')}`;return validDate(result)?result:null;
}
function kind(value:IntercompanySheetCell|undefined):'loan'|'repayment'|null{
 const normalized=text(value).replace(/\s+/g,'');
 if(/^대여금상환(?:[·;,].*)?$/.test(normalized))return 'repayment';
 if(/^대여금(?:[·;,].*)?$/.test(normalized))return 'loan';return null;
}
// Whitespace inside quoted sheet names and string criteria is significant.
function compact(formula:string){let out='',quote='';for(let i=0;i<formula.length;i++){const c=formula[i];if(quote){out+=c;if(c===quote){if(formula[i+1]===quote){out+=formula[++i];}else quote='';}}else if(c==='"'||c==="'"){quote=c;out+=c;}else if(!/\s/.test(c))out+=c;}return out;}
function unwrap(value:string){let out=value;while(out.startsWith('(')&&out.endsWith(')')){let depth=0,quote='',whole=true;for(let i=0;i<out.length;i++){const c=out[i];if(quote){if(c===quote){if(out[i+1]===quote)i++;else quote='';}continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='(')depth++;if(c===')')depth--;if(depth===0&&i<out.length-1){whole=false;break;}}if(!whole)break;out=out.slice(1,-1);}return out;}
function terms(value:string,sign=1):{value:string;sign:number}[]{
 const input=unwrap(value);let depth=0,quote='',start=0,nextSign=sign;const out:{value:string;sign:number}[]=[];
 for(let i=0;i<input.length;i++){const c=input[i];if(quote){if(c===quote){if(input[i+1]===quote)i++;else quote='';}continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='(')depth++;else if(c===')')depth--;else if(depth===0&&(c==='+'||c==='-')){if(i===start)return [];out.push(...terms(input.slice(start,i),nextSign));nextSign=c==='+'?sign:-sign;start=i+1;}}
 if(start===0)return [{value:input,sign}];return [...out,...terms(input.slice(start),nextSign)];
}
function dedupClause(row:number,mirror:string,type:'loan'|'repayment'){
 const sheet=`'${mirror.replace(/'/g,"''")}'!`,label=type==='loan'?'대여금':'대여금 상환';
 const count=(state:string)=>`COUNTIFS(${sheet}$A$2:$A$10000,$E$${row},${sheet}$B$2:$B$10000,TEXT($A$${row},"yyyy-mm-dd"),${sheet}$C$2:$C$10000,$B$${row},${sheet}$D$2:$D$10000,$C$${row},${sheet}$E$2:$E$10000,$D$${row},${sheet}$F$2:$F$10000,"${label}",${sheet}$G$2:$G$10000,"${state}")`;
 return `IF(AND($E$${row}<>"",(${count('정상')}+${count('취소')})=1),$D$${row},0)`;
}
export function intercompanySourceDedupFormula(row:number,mirror:string,column:'E'|'H'){
 const sheet=`'${mirror.replace(/'/g,"''")}'!`;
 return `IF(AND($${column}$${row}<>"",COUNTIF(${sheet}$A$2:$A$10000,$${column}$${row})=1),$D$${row},0)`;
}
function formulaBase(formula:IntercompanySheetCell,pairRow:number,forward:boolean,mirror:string,sourceRows:IntercompanySourceRow[],values:IntercompanySheetCell[][]):{amount:number;expression:string}|null{
 if(typeof formula!=='string'||!formula.startsWith('=')||formula.length>32768)return null;
 let depth=0,quote='';for(let i=0;i<formula.length;i++){const c=formula[i];if(quote){if(c===quote){if(formula[i+1]===quote)i++;else quote='';}continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c==='('&&++depth>128)return null;if(c===')'&&--depth<0)return null;}if(depth!==0||quote)return null;
 const a=forward?`A${pairRow}`:`B${pairRow}`,b=forward?`B${pairRow}`:`A${pairRow}`,sheet=`'${mirror.replace(/'/g,"''")}'!`;
 const manual=`SUMIFS($D$48:$D$70,$B$48:$B$70,${a},$C$48:$C$70,${b})`;
 const mirrored=`SUMIFS(${sheet}$E$2:$E$10000,${sheet}$C$2:$C$10000,${a},${sheet}$D$2:$D$10000,${b},${sheet}$G$2:$G$10000,"정상")`;
 const parts=terms(compact(formula.slice(1)));let base:number|null=null,expression='',manualCount=0,mirrorCount=0;const used=new Set<number>();
 for(const part of parts){
  if(part.sign===1&&/^\d+$/.test(part.value)){const number=Number(part.value);if(base!==null||!Number.isSafeInteger(number))return null;base=number;expression=part.value;continue;}
  if(part.sign===1&&/^SUM\(\$?D\$?36:\$?D\$?38\)$/.test(part.value)){
   if(base!==null)return null;const evidence=[35,36,37].map(index=>integer(values[index]?.[3],true));if(evidence.some(value=>value===null))return null;
   const sum=evidence.reduce<number>((total,value)=>total+(value??0),0);if(!Number.isSafeInteger(sum))return null;base=sum;expression=part.value;continue;
  }
  if(part.sign===1&&part.value===manual){manualCount++;continue;}
  if(part.sign===1&&part.value===mirrored){mirrorCount++;continue;}
  const deduction=part.sign===-1?sourceRows.find(row=>part.value===dedupClause(row.row,mirror,'loan')||part.value===dedupClause(row.row,mirror,'repayment')||part.value===intercompanySourceDedupFormula(row.row,mirror,'E')||part.value===intercompanySourceDedupFormula(row.row,mirror,'H')):undefined;
  if(!deduction||used.has(deduction.row))return null;used.add(deduction.row);
 }
 if(base===null&&manualCount===0&&mirrorCount===1&&parts.length===1)return {amount:0,expression:'0'};
 return base!==null&&manualCount===1&&mirrorCount===1?{amount:base,expression}:null;
}

/** Pure bounded parser. Financial totals are not inferred from transaction names. */
export function parseIntercompanySheetSource(raw:IntercompanySheetRaw,baseline:IntercompanyBaseline,options:{newId?:()=>string}={}):IntercompanySheetSource{
 const issues:IntercompanySourceIssue[]=[],sourceRows:IntercompanySourceRow[]=[],mirrorRows:IntercompanyMirrorRow[]=[],historicalBasePairs:IntercompanySourcePair[]=[],identifierWrites:IntercompanyIdentifierWrite[]=[];
 const issue=(row:number|null,code:string,message:string)=>issues.push({row,code,message});
 const partyByName=new Map<string,string>();
 for(const party of baseline.businesses){const name=party.name.normalize('NFKC').trim();if(partyByName.has(name))issue(null,'party_duplicate','원본 사업자 이름이 중복되었습니다.');partyByName.set(name,party.key);}
 const party=(value:IntercompanySheetCell|undefined)=>partyByName.get(text(value).normalize('NFKC'));
 const periodText=text(raw.sourceValues[1]?.[0]),coverage=periodText.match(/원장\s*기록\s*(\d{4}-\d{2}-\d{2})\s*[~～]\s*(\d{4}-\d{2}-\d{2})/),checked=periodText.match(/확인\s*(\d{4}-\d{2}-\d{2})/);
 const period={sourceStart:coverage&&validDate(coverage[1])?coverage[1]:null,ledgerThrough:coverage&&validDate(coverage[2])?coverage[2]:null,sourceCheckedAt:checked&&validDate(checked[1])?checked[1]:null,raw:periodText};
 const year=period.sourceCheckedAt?Number(period.sourceCheckedAt.slice(0,4)):null;
 if(!period.sourceStart||!period.ledgerThrough||!period.sourceCheckedAt||period.sourceStart>period.ledgerThrough)issue(2,'period_invalid','원본의 원장 기간과 확인 날짜를 확인해주세요.');
 if(raw.sourceGid!==baseline.gid||raw.mirrorGid!==baseline.mirror_gid||raw.mirrorTitle!==baseline.mirror_sheet_name)issue(null,'source_mismatch','등록된 원본 시트 연결과 다릅니다.');
 const sourceHeader=['기재일','보낸 사업자','받은 사업자','반영 금액','반영 위치','근거','비고'];
 if(sourceHeader.some((value,index)=>text(raw.sourceValues[46]?.[index])!==value))issue(47,'source_header','원본 추가 내역의 열 제목이 변경되었습니다.');
 if(text(raw.sourceValues[46]?.[7])&&!['연동ID'].includes(text(raw.sourceValues[46]?.[7])))issue(47,'source_identity_header','원본 연동ID 열 제목을 확인해주세요.');
 const ids=new Set<string>(),linkedIds=new Set<string>();
 for(let row=48;row<=70;row++){
  const cells=rowCells(raw.sourceValues,row);if(cells.slice(0,8).every(blank))continue;
  if(cells.slice(0,7).every(blank)){issue(row,'source_empty_identity','식별자만 남은 원본 행을 확인해주세요.');continue;}
  const from=party(cells[1]),to=party(cells[2]),value=integer(cells[3]),day=date(cells[0],year),type=kind(cells[6]);
  if(!from||!to||from===to||value===null||!day||!type){issue(row,'source_row_invalid','원본 행의 날짜·사업자·금액·대여/상환 구분을 확인해주세요.');continue;}
  const nativeId=uuid.test(text(cells[4]))?text(cells[4]).toLowerCase():null;
  let id=text(cells[7]);
  if(!id){id=row<=55?`source-row-${row}`:nativeId??(options.newId??(()=>crypto.randomUUID()))();identifierWrites.push({row,value:id,expectedRow:cells});}
  if(uuid.test(id))id=id.toLowerCase();
  if(!sourceId(id)||ids.has(id)||nativeId&&linkedIds.has(nativeId)){issue(row,'source_identity','원본 기록 식별자가 잘못되었거나 중복되었습니다.');continue;}
  ids.add(id);if(nativeId)linkedIds.add(nativeId);
  sourceRows.push({id,row,nativeId,date:day,fromParty:from,toParty:to,amount:value,kind:type,memo:[text(cells[5]),text(cells[6])].filter(Boolean).join(' · '),financialPreimage:cells.slice(0,7)});
 }
 const mirrorHeader=['기록ID','일자','보낸 사업자','받은 사업자','금액','구분','상태','버전','메모'];
 if(mirrorHeader.some((value,index)=>text(raw.mirrorValues[0]?.[index])!==value))issue(null,'mirror_header','기록 탭의 열 제목이 변경되었습니다.');
 const mirrorIds=new Set<string>();
 for(let row=2;row<=Math.min(raw.mirrorValues.length,10000);row++){
  const cells=rowCells(raw.mirrorValues,row);if(cells.every(blank))continue;
  const id=text(cells[0]).toLowerCase(),day=date(cells[1],year),from=party(cells[2]),to=party(cells[3]),value=integer(cells[4]),type=kind(cells[5]),version=integer(cells[7]);
  if(!uuid.test(id)||mirrorIds.has(id)||!day||!from||!to||from===to||value===null||!type||!version||cells.some(cell=>typeof cell==='boolean')||!['정상','취소'].includes(text(cells[6]))||text(cells[8]).length>2000){issue(row,'mirror_row_invalid','기록 탭의 날짜·사업자·금액·상태·식별자를 확인해주세요.');continue;}
  mirrorIds.add(id);mirrorRows.push({id,row,date:day,fromParty:from,toParty:to,amount:value,kind:type,voided:text(cells[6])==='취소',version,memo:text(cells[8]),cells:cells.map(cell=>cell==null?'':cell) as (string|number)[]});
 }
 const pairs=new Set<string>();
 for(let row=9;row<=44;row++){
  const cells=rowCells(raw.sourceValues,row),from=party(cells[0]),to=party(cells[1]);if(!from||!to)continue;
  const key=JSON.stringify([from,to].sort()),a=integer(cells[2],true),b=integer(cells[3],true),net=typeof cells[4]==='number'?cells[4]:null;
  if(from===to||pairs.has(key)||a===null||b===null||net!==a-b){issue(row,'pair_invalid','원본 사업자 쌍의 방향별 금액과 순증감을 확인해주세요.');continue;}
  const formulas=rowCells(raw.sourceFormulas,row),baseA=formulaBase(formulas[2],row,true,raw.mirrorTitle,sourceRows,raw.sourceValues),baseB=formulaBase(formulas[3],row,false,raw.mirrorTitle,sourceRows,raw.sourceValues);
  if(baseA===null||baseB===null){issue(row,'pair_formula','지원되지 않는 원본 합계 수식입니다. 기존 원본과 비교가 필요합니다.');continue;}
  pairs.add(key);historicalBasePairs.push({business_a:from,business_b:to,a_to_b:baseA.amount,b_to_a:baseB.amount,row,note:text(cells[6]),source_a_to_b:a,source_b_to_a:b,base_a_expression:baseA.expression,base_b_expression:baseB.expression});
 }
 if(historicalBasePairs.length!==baseline.pairs.length)issue(null,'pair_count','원본 사업자 쌍의 누락·추가 또는 수식 변경을 확인해주세요.');
 return {sourceRows,historicalBasePairs,mirrorRows,identifierWrites,period,issues,fingerprint:raw.fingerprint,counts:{sourceRows:sourceRows.length,mirrorRows:mirrorRows.length,pairs:historicalBasePairs.length}};
}
