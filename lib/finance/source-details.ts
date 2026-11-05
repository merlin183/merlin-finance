import type {SourceDetails,Transaction} from './types';

export const sourceDetailFields=['basic','detail','counterparty','record','memo','note'] as const;
type DetailField=typeof sourceDetailFields[number];
const labels:Record<DetailField,string>={basic:'기본내역',detail:'세부내역',counterparty:'거래 상대방',record:'거래기록사항',memo:'이체메모',note:'비고'};
const aliases:Record<DetailField,string[]>={
 basic:['기본내역','기본내용'],
 detail:['세부내역','세부내용','상세내역','상세내용'],
 counterparty:['보낸분받는분','보낸분받으신분','받는분보낸분','보낸사람받는사람','받는사람보낸사람','보낸분','보내는분','받는분','받으신분','보낸사람','받는사람','상대방','상대방명','상대예금주','상대방예금주','상대계좌예금주','거래처','거래처명','송금인','송금인명','수취인','수취인명','수취인성명','입금자','입금자명','출금거래처','입금거래처','counterparty','payee','payer','recipient','sender'],
 record:['거래기록사항','거래기록','기록사항','통장기록사항'],
 memo:['이체메모','송금메모','메모','transfermemo','memo'],
 note:['비고','note','notes'],
};
const normalizeHeader=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const withoutHeaderHint=(value:string)=>normalizeHeader(value.normalize('NFKC').replace(/\([^)]*\)/g,''));
const directionalCounterpartyHeaders=new Set(['보낸분','보내는분','보낸사람','송금인','송금인명','입금자','입금자명','받는분','받으신분','받는사람','수취인','수취인명','수취인성명','입금거래처','출금거래처','payer','sender','payee','recipient']);
const clean=(value:unknown)=>typeof value==='string'?value.trim().slice(0,1000):'';
const cellText=(value:unknown)=>value instanceof Date?(Number.isFinite(value.getTime())?value.toISOString():''):value===null||value===undefined?'':String(value).trim();
const plainObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Preserve explicit source columns without guessing a person from an ordinary description. */
export function extractSourceDetails(headers:unknown[],row:unknown[]):SourceDetails|null{
 const values=new Map<DetailField,{header:string;value:string}[]>();
 for(let index=0;index<headers.length;index++){
  const header=cellText(headers[index]),name=normalizeHeader(header),withoutHint=withoutHeaderHint(header);
  const field=sourceDetailFields.find(key=>aliases[key].includes(name)||aliases[key].includes(withoutHint));
  const value=cellText(row[index]);
  if(!field||!value)continue;
  const list=values.get(field)||[];
  if(!list.some(item=>item.value===value&&(field!=='counterparty'||item.header===header)))list.push({header,value});
  values.set(field,list);
 }
 const result:SourceDetails={};
 for(const field of sourceDetailFields){
  const list=values.get(field);if(!list?.length)continue;
  const item=list[0];
  // A bank may list the recipient even on an incoming payment (or vice
  // versa). Preserve its explicit role instead of inferring it from direction.
  const singleValue=field==='counterparty'&&directionalCounterpartyHeaders.has(withoutHeaderHint(item.header))?`${item.header}: ${item.value}`:item.value;
  result[field]=(list.length===1?singleValue:list.map(item=>`${item.header}: ${item.value}`).join(' · ')).slice(0,1000);
 }
 return Object.keys(result).length?result:null;
}

/** Keep only supported, bounded strings; blank input never erases a saved value. */
export function normalizeSourceDetails(input:unknown):SourceDetails|null{
 if(!plainObject(input))return null;
 const result:SourceDetails={};
 for(const field of sourceDetailFields){const value=clean(input[field]);if(value)result[field]=value;}
 const provenance=input.provenance;
 if(plainObject(provenance)){
  const sheet=clean(provenance.sheet),row=provenance.row;
  if(sheet&&typeof row==='number'&&Number.isInteger(row)&&row>=1){
   const url=clean(provenance.url);result.provenance={sheet,row,...(url?{url}:{})};
  }
 }
 return Object.keys(result).length?result:null;
}

export function mergeSourceDetails(previous:SourceDetails|null|undefined,incoming:SourceDetails|null|undefined):SourceDetails|null{
 const saved=normalizeSourceDetails(previous),next=normalizeSourceDetails(incoming);
 if(!next)return saved;
 const result:SourceDetails={...saved};
 let supplied=false;
 for(const field of sourceDetailFields)if(next[field]){result[field]=next[field];supplied=true;}
 // An empty new source must not relabel the origin of older saved details.
 if(next.provenance&&supplied)result.provenance=next.provenance;
 return Object.keys(result).length?result:null;
}

export function getSourceDetailEntries(transaction:Pick<Transaction,'source_details'>):{label:string;value:string}[]{
 const details=normalizeSourceDetails(transaction.source_details);
 return sourceDetailFields.flatMap(field=>details?.[field]?[{label:labels[field],value:details[field]!}]:[]);
}

export function sourceCounterparty(transaction:Pick<Transaction,'source_details'>):string|null{
 return clean(transaction.source_details?.counterparty)||null;
}
