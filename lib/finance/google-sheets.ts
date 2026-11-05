import {readTransactions,transactionSheets} from './workbook';
import {previewSheets,transactionOverview,type SheetPlan} from './import-preview';
import {digest} from './parser';
import type {Account,Business,Dataset} from './types';
import type {SheetMergeRow} from './sheet-merge';
import {isReviewCategoryName,normalizeCategoryName,resolveSheetCategory,type SheetCategoryIssue} from './sheet-category';
import {isHistoricalCompletionCategory,isHistoricalDate,resolveHistoricalCompletion} from './category-status';
import {installationPolicy,type SheetBusinessAliasPolicy} from './installation-policy';

const MAX_BYTES=4*1024*1024;
const normalize=(value:string)=>value.normalize('NFKC').replace(/[\s()（）·_-]/g,'').toLowerCase();
export function googleSheetUrl(value:string){
 let url:URL;try{url=new URL(value.trim());}catch{throw Error('Google Sheets 공유 링크를 입력해주세요.');}
 const match=url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})(?:\/|$)/);
 if(url.protocol!=='https:'||url.hostname!=='docs.google.com'||url.port||url.username||url.password||!match)throw Error('docs.google.com/spreadsheets/d/로 시작하는 Google Sheets 링크를 사용해주세요.');
 return {id:match[1],url:`https://docs.google.com/spreadsheets/d/${match[1]}/edit`,exportUrl:`https://docs.google.com/spreadsheets/d/${match[1]}/export?format=xlsx`};
}
export async function sha256(value:string){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
export async function fetchGoogleSheet(value:string){
 const source=googleSheetUrl(value);let url=source.exportUrl;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
 try{
  for(let hop=0;hop<5;hop++){
   const response=await fetch(url,{redirect:'manual',cache:'no-store',signal:controller.signal});
   if(response.status>=300&&response.status<400){
    const location=response.headers.get('location');if(!location)throw Error('시트 내보내기 주소를 확인하지 못했습니다.');
    const next=new URL(location,url);
    if(next.protocol!=='https:'||next.port||next.username||next.password||!(next.hostname==='docs.google.com'||next.hostname.endsWith('.googleusercontent.com')))throw Error('이 링크는 서버에서 읽을 수 없습니다. 읽기 가능한 공유 링크인지 확인하거나 파일로 업로드해주세요.');
    await response.body?.cancel();url=next.href;continue;
   }
   if(!response.ok)throw Error('Google Sheets를 읽지 못했습니다. 링크와 읽기 권한을 확인해주세요.');
   if(Number(response.headers.get('content-length')||0)>MAX_BYTES)throw Error('Google Sheets 내보내기 파일은 4MB 이하여야 합니다.');
   const reader=response.body?.getReader();if(!reader)throw Error('시트 데이터가 비어 있습니다.');
   const chunks:Uint8Array[]=[];let size=0;
   while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('Google Sheets 내보내기 파일은 4MB 이하여야 합니다.');}chunks.push(next.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   if(bytes[0]!==0x50||bytes[1]!==0x4b)throw Error('Excel 형식으로 시트를 읽지 못했습니다. 다운로드 가능한 Google Sheets 공유 링크인지 확인해주세요.');
   return {sourceUrl:source.url,bytes};
  }
  throw Error('시트 내보내기가 너무 여러 번 이동합니다. 원본 Google Sheets 링크를 확인해주세요.');
 }catch(error){if(controller.signal.aborted)throw Error('시트를 읽는 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.');throw error;}finally{clearTimeout(timer);}
}
export function suggestSheetAccount(name:string,businesses:Business[],accounts:Account[],aliases:readonly SheetBusinessAliasPolicy[]=installationPolicy.sheetBusinessAliases){
 const normalized=normalize(name);
 const matching=businesses.filter(b=>[b.name,...aliases.filter(alias=>normalize(alias.businessName)===normalize(b.name)).flatMap(alias=>alias.aliases)]
  .some(candidate=>!!normalize(candidate)&&normalized.includes(normalize(candidate))));
 if(matching.length!==1)return null;
 const candidates=accounts.filter(a=>a.business_id===matching[0].id&&normalized.includes(normalize(a.name)));
 return candidates.length===1?candidates[0].id:null;
}
export type SheetMapping={sheet:string;account_id:string|null;selected:boolean};
export function sheetSnapshot(bytes:Uint8Array){
 const workbook=readTransactions(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);
 const sheets=transactionSheets(workbook,'Google Sheets.xlsx').filter(s=>s.selected);
 if(!sheets.length)throw Error('날짜·입금·출금이 있는 공개된 거래 시트를 찾지 못했습니다.');
 if(sheets.length>40)throw Error('한 번에 거래 시트 40개까지 가져올 수 있습니다.');
 return sheets;
}
export async function sheetSourceHash(bytes:Uint8Array){return hashSheetRows(sheetSnapshot(bytes));}
async function hashSheetRows(sheets:ReturnType<typeof sheetSnapshot>){
 return sha256(JSON.stringify(sheets.map(s=>({name:s.name,rows:s.rows.filter(r=>r.some(v=>v!==''&&v!==null&&v!==undefined))}))));
}
export async function prepareSheetRows(bytes:Uint8Array,data:Dataset,mappings?:SheetMapping[],sourceUrl?:string){
 return prepareSheetRowsFromSnapshot(sheetSnapshot(bytes),data,mappings,sourceUrl);
}
/** Reuse the request's already parsed workbook. Preparation reads the snapshot
 * without mutating it, so a concurrent-ledger replan can use the same source. */
export async function prepareSheetRowsFromSnapshot(sourceSheets:ReturnType<typeof sheetSnapshot>,data:Dataset,mappings?:SheetMapping[],sourceUrl?:string){
 const sourceHash=await hashSheetRows(sourceSheets);
 const mappingMap=new Map(mappings?.map(m=>[m.sheet,m]));
 if(mappings&&(mappingMap.size!==mappings.length||mappings.some(m=>!sourceSheets.some(s=>s.name===m.sheet))))throw Error('시트 목록이 바뀌었습니다. 링크를 다시 불러와주세요.');
 const incoming:SheetMergeRow[]=[];
 const sheets=[];
 for(const source of sourceSheets){
  const requested=mappingMap.get(source.name),account_id=requested?requested.account_id:suggestSheetAccount(source.name,data.businesses,data.accounts);
  const selected=requested?requested.selected:!!account_id;
  if(account_id&&!data.accounts.some(a=>a.id===account_id))throw Error('연결할 계좌를 확인해주세요.');
  if(selected&&!account_id)throw Error(`${source.name}: 연결할 사업자·계좌를 선택해주세요.`);
  const d=source.detected;
  const plan:SheetPlan={...source,selected:true,mapping:d.mapping,options:{headerRow:d.headerRow,year:d.year,month:d.month,amountMode:d.amountMode,completeHistorical:false}};
  const result=previewSheets([plan],data.categories,data.rules,data.aliases,account_id||undefined);
  const errors=[...result.errors.map(e=>({row:e.row,message:e.message})),...result.problems.map(message=>({row:d.headerRow+1,message}))];
  const categoriesByRow=new Map<number,ReturnType<typeof resolveSheetCategory>>();
  const categoryIssues=new Map<string,SheetCategoryIssue>();
  const unmapped=resolveSheetCategory('미매핑',data.categories,[]).category;
  for(const parsed of result.parsed){
   if(parsed.source_details)parsed.source_details={...parsed.source_details,provenance:{sheet:source.name,row:parsed.source_row,...(sourceUrl?{url:sourceUrl.slice(0,1000)}:{})}};
   const rawCategory=parsed.raw_gwamok.trim(),resolution=resolveSheetCategory(rawCategory,data.categories,data.aliases);
   categoriesByRow.set(parsed.source_row,resolution);
   // Generic source labels do not erase an existing, scoped rule result.
   // Keep the source status so automatic classification remains non-manual.
   const keepRuleClassification=resolution.status==='needs_review'&&data.categories.some(category=>category.id===parsed.category_id&&!isReviewCategoryName(category.name));
   if(rawCategory&&!keepRuleClassification){parsed.category_id=resolution.category?.id||unmapped?.id||null;parsed.is_internal=!!resolution.category?.is_internal;}
   if((resolution.status==='needs_review'||resolution.status==='blank')&&!data.categories.some(category=>category.id===parsed.category_id&&!isReviewCategoryName(category.name))){
    // A complete registered category name is explicit evidence; a person's
    // name, a substring or conflicting detail fields are not.
    const names=new Set([parsed.description,parsed.source_details?.basic||'',parsed.source_details?.detail||''].map(normalizeCategoryName).filter(Boolean));
    const matches=data.categories.filter(category=>!isReviewCategoryName(category.name)&&!isHistoricalCompletionCategory(category.name)&&names.has(normalizeCategoryName(category.name)));
    if(matches.length===1){parsed.category_id=matches[0].id;parsed.is_internal=matches[0].is_internal;parsed.manually_classified=false;}
   }
   const completed=resolveHistoricalCompletion(data.categories,parsed.txn_date,parsed.category_id);
   if(completed){parsed.category_id=completed.id;parsed.is_internal=completed.is_internal;}
   const completedHistorical=isHistoricalDate(parsed.txn_date)&&isHistoricalCompletionCategory(data.categories.find(category=>category.id===parsed.category_id)?.name);
   if(completedHistorical)parsed.manually_classified=true;
   if(!completedHistorical&&(resolution.status==='unregistered'||resolution.status==='needs_review')){
    const key=JSON.stringify([rawCategory,resolution.status]),issue=categoryIssues.get(key);
    if(issue)issue.count++;else categoryIssues.set(key,{rawName:rawCategory,count:1,status:resolution.status});
   }
  }
  const overview=transactionOverview(result.parsed);
  const sample=result.parsed.length>6?[...result.parsed.slice(0,3),...result.parsed.slice(-3)]:result.parsed;
  sheets.push({name:source.name,account_id,selected,count:result.parsed.length,from:overview.from,to:overview.to,income:overview.income,expense:overview.expense,errors,categoryIssues:[...categoryIssues.values()],sample:sample.map(r=>({txn_date:r.txn_date,description:r.description,amount:r.amount,direction:r.direction,category_name:data.categories.find(c=>c.id===r.category_id)?.name||'미매핑',raw_category:r.raw_gwamok,category_status:categoriesByRow.get(r.source_row)!.status,balance:r.balance}))});
  if(!selected||!account_id)continue;
  for(const parsed of result.parsed){
   const raw=source.rows[parsed.source_row-1],tax=d.mapping.tax===undefined?undefined:raw[d.mapping.tax];
   const rawCategory=parsed.raw_gwamok.trim();
   const {sheet,...row}=parsed;
   const taxProvided=tax!==undefined&&tax!==null&&String(tax).trim()!=='';
   if(taxProvided)row.tax_invoice=tax instanceof Date||/^(?:o|y|yes|true|1|발행|발급|유|있음)$/i.test(String(tax).trim())||/^\d{4}[-/.년]/.test(String(tax).trim());
   incoming.push({...row,sheet,account_id,category_status:categoriesByRow.get(parsed.source_row)!.status,source_sheet:sheet,dedup_hash:await digest(account_id,row.txn_date,row.amount,row.direction,row.description,row.balance),provided:{category:!!rawCategory,balance:row.balance!==null,tax:taxProvided,time:!!row.txn_time}});
  }
 }
 return {sourceHash,sheets,incoming};
}
