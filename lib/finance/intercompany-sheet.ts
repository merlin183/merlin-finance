// Server-only gateway: node:crypto and credentials must never enter a client bundle.
import {createHash,createPrivateKey,sign} from 'node:crypto';
import {intercompanyEntrySchema,type IntercompanyBaseline,type IntercompanyEntry} from './intercompany-register';
import type {IntercompanyIdentifierWrite,IntercompanySheetCell,IntercompanySheetRaw} from './intercompany-sheet-source';
import {intercompanySourceDedupFormula,type IntercompanySheetSource} from './intercompany-sheet-source';

export const INTERCOMPANY_MIRROR_SHEET_NAME='사업자간 대여금_대시보드기록';
export const INTERCOMPANY_MIRROR_HEADERS=['기록ID','일자','보낸 사업자','받은 사업자','금액','구분','상태','버전','메모'] as const;
const TOKEN_URL='https://oauth2.googleapis.com/token';
const SHEETS_SCOPE='https://www.googleapis.com/auth/spreadsheets';
const API='https://sheets.googleapis.com/v4/spreadsheets';
export type IntercompanyMirrorCell=string|number;
type Cell=IntercompanyMirrorCell;
type MirrorBaseline=Pick<IntercompanyBaseline,'source_url'|'gid'|'businesses'>&{mirror_gid:string;mirror_sheet_name:string};
type MirrorEntry=IntercompanyEntry&{sheet_row:number};
type Options={fetcher?:typeof fetch;env?:NodeJS.ProcessEnv;now?:()=>number;timeoutMs?:number;expectedPreviousRow?:Cell[]};
type ErrorCode='configuration'|'invalid_source'|'invalid_entry'|'authorization'|'unavailable'|'tab_changed'|'headers_changed'|'row_conflict'|'stale_version'|'verification'|'source_changed';
const messages:Record<ErrorCode,string>={
 configuration:'Google 시트 기록 연결 설정을 확인해주세요.',invalid_source:'등록된 원본 시트 연결을 확인해주세요.',invalid_entry:'시트에 기록할 대여·상환 내용을 확인해주세요.',
 authorization:'Google 시트 기록 권한을 확인해주세요.',unavailable:'Google 시트에 연결하지 못했습니다. 같은 기록의 시트 반영을 다시 시도해주세요.',
 tab_changed:'대여금 기록 시트가 변경되었습니다. 연결 설정을 확인해주세요.',headers_changed:'대여금 기록 시트의 열 제목이 변경되었습니다. 원본을 확인해주세요.',
 row_conflict:'같은 시트 행에 다른 내용이 있습니다. 원본 확인 전에는 덮어쓰지 않습니다.',stale_version:'시트에 더 최신 상태가 있습니다. 최신 대여금 기록을 다시 조회해주세요.',
 verification:'시트 기록 결과를 확인하지 못했습니다. 같은 기록의 시트 반영을 다시 시도해주세요.',
 source_changed:'원본 시트가 조회 중 변경되었습니다. 최신 자료로 다시 동기화해주세요.',
};
export class IntercompanySheetError extends Error{
 constructor(readonly code:ErrorCode,readonly writeMayHaveSucceeded=false){super(messages[code]);this.name='IntercompanySheetError';}
}
const fail=(code:ErrorCode):never=>{throw new IntercompanySheetError(code);};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function target(baseline:MirrorBaseline){
 let url:URL;try{url=new URL(baseline.source_url);}catch{return fail('invalid_source');}
 const match=url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})(?:\/edit\/?)?$/);
 if(url.protocol!=='https:'||url.hostname!=='docs.google.com'||url.port||url.username||url.password||!match)return fail('invalid_source');
 const validGid=(value:string)=>/^\d{1,10}$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)<=2147483647;
 if(!validGid(baseline.gid)||!validGid(baseline.mirror_gid)||Number(baseline.gid)===Number(baseline.mirror_gid)||baseline.mirror_sheet_name!==INTERCOMPANY_MIRROR_SHEET_NAME)return fail('invalid_source');
 return {id:match[1],sourceGid:Number(baseline.gid),mirrorGid:Number(baseline.mirror_gid),name:baseline.mirror_sheet_name};
}
function desiredRow(baseline:MirrorBaseline,entry:MirrorEntry):Cell[]{
 if(!intercompanyEntrySchema.safeParse(entry).success||!Number.isInteger(entry.sheet_row)||entry.sheet_row<2||entry.sheet_row>1000000)return fail('invalid_entry');
 const from=baseline.businesses.filter(p=>p.key===entry.from_party),to=baseline.businesses.filter(p=>p.key===entry.to_party);
 if(from.length!==1||to.length!==1||entry.from_party===entry.to_party||[from[0].name,to[0].name].some(name=>typeof name!=='string'||!name||name.length>200))return fail('invalid_entry');
 return [entry.id,entry.entry_date,from[0].name,to[0].name,entry.amount,entry.kind==='loan'?'대여금':'대여금 상환',entry.voided?'취소':'정상',entry.version,entry.memo];
}
function assertion(env:NodeJS.ProcessEnv,now:number){
 try{
  const raw=env.FINANCE_GOOGLE_SERVICE_ACCOUNT_JSON;if(!raw||raw.length>32768)return fail('configuration');
  const account=object(JSON.parse(raw));
  if(!account||account.type!=='service_account'||typeof account.client_email!=='string'||!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(account.client_email)||typeof account.private_key!=='string'||!Number.isFinite(now))return fail('configuration');
  const key=createPrivateKey(account.private_key);
  if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)return fail('configuration');
  const header={alg:'RS256',typ:'JWT',...(typeof account.private_key_id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(account.private_key_id)?{kid:account.private_key_id}:{})};
  const issued=Math.floor(now/1000),claims={iss:account.client_email,scope:SHEETS_SCOPE,aud:TOKEN_URL,iat:issued,exp:issued+3600};
  const payload=[header,claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${payload}.${sign('RSA-SHA256',Buffer.from(payload),key).toString('base64url')}`;
 }catch{return fail('configuration');}
}
function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return Promise.reject(new IntercompanySheetError('unavailable'));
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(new IntercompanySheetError('unavailable'));
  signal.addEventListener('abort',abort,{once:true});
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
function rows(body:unknown):Cell[][]{
 const value=object(body)?.values;if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>1||value.some(row=>!Array.isArray(row)||row.length>9||row.some(cell=>typeof cell!=='string'&&typeof cell!=='number')))return fail('verification');
 return value as Cell[][];
}
const padded=(row:Cell[])=>Array.from({length:9},(_,i)=>row[i]??'');
const sameRow=(a:Cell[],b:Cell[])=>padded(a).every((cell,i)=>cell===padded(b)[i]);
const immutableMatches=(current:Cell[],desired:Cell[])=>[0,1,2,3,4,5,8].every(i=>padded(current)[i]===desired[i]);

/**
 * The caller must hold the DB row lease and pass only its saved baseline/entry.
 * Rows are allocated once in the DB; retries always write that same range (never append).
 * The original summary and all bank/ledger rows are outside this gateway's write range.
 */
export async function syncIntercompanySheetEntry(baseline:MirrorBaseline,entry:MirrorEntry,options:Options={}):Promise<void>{
 const source=target(baseline),desired=desiredRow(baseline,entry);
 const jwt=assertion(options.env??process.env,(options.now??Date.now)());
 const controller=new AbortController(),timeout=Math.min(30000,Math.max(1,options.timeoutMs??30000));
 const timer=setTimeout(()=>controller.abort(),timeout),fetcher=options.fetcher??fetch;
 let attemptedWrite=false;
 const request=async(url:string,init:RequestInit={},limit=131072)=>{
  if(controller.signal.aborted)throw new IntercompanySheetError('unavailable');
  const response=await bounded(Promise.resolve().then(()=>fetcher(url,{...init,cache:'no-store',redirect:'error',signal:controller.signal})),controller.signal);
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new IntercompanySheetError(response.status===401||response.status===403?'authorization':'unavailable');}
  if(Number(response.headers.get('content-length')??0)>limit){void response.body?.cancel().catch(()=>{});return fail('verification');}
  const text=await bounded(response.text(),controller.signal);
  if(text.length>limit)return fail('verification');
  try{return JSON.parse(text) as unknown;}catch{return fail('verification');}
 };
 try{
  const token=object(await request(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt}).toString()},8192));
  if(!token||typeof token.access_token!=='string'||!token.access_token||token.access_token.length>4096||/\s/.test(token.access_token)||token.token_type!=='Bearer'||typeof token.expires_in!=='number'||token.expires_in<60)return fail('authorization');
  const headers={Authorization:`Bearer ${token.access_token}`};
  const metadata=object(await request(`${API}/${source.id}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`,{headers}));
  if(!metadata||!Array.isArray(metadata.sheets))return fail('tab_changed');
  const properties=metadata.sheets.map(sheet=>object(object(sheet)?.properties));
  const matches=properties.filter(p=>p?.sheetId===source.mirrorGid);
  const mirror=matches[0],grid=object(mirror?.gridProperties);
  if(matches.length!==1||mirror?.title!==source.name||properties.filter(p=>p?.title===source.name).length!==1||!properties.some(p=>p?.sheetId===source.sourceGid)||!grid||typeof grid.rowCount!=='number'||grid.rowCount<entry.sheet_row||typeof grid.columnCount!=='number'||grid.columnCount<9)return fail('tab_changed');
  const range=(cells:string)=>`'${source.name.replace(/'/g,"''")}'!${cells}`;
  const rowRange=range(`A${entry.sheet_row}:I${entry.sheet_row}`);
  // FORMULA prevents a formula from masquerading as the immutable ID or header.
  // RAW writes still preserve user-entered strings beginning with '=' literally.
  const read=async(a1:string)=>rows(await request(`${API}/${source.id}/values/${encodeURIComponent(a1)}?valueRenderOption=FORMULA`,{headers}))[0]??[];
  if(!sameRow(await read(range('A1:I1')),[...INTERCOMPANY_MIRROR_HEADERS]))return fail('headers_changed');
  const current=await read(rowRange);
  if(!current.every(cell=>cell==='')){
   if(current[0]!==entry.id||!Number.isInteger(current[7])||Number(current[7])<1)return fail('row_conflict');
   if(Number(current[7])>entry.version)return fail('stale_version');
   const approvedPrior=options.expectedPreviousRow;
   const approvedAmendment=!!approvedPrior&&approvedPrior.length===9&&approvedPrior[0]===entry.id&&sameRow(current,approvedPrior)&&Number(current[7])<entry.version;
   if(!immutableMatches(current,desired)&&!approvedAmendment)return fail('row_conflict');
   if(Number(current[7])===entry.version){if(!sameRow(current,desired))return fail('row_conflict');return;}
  }
  // A DB lease serializes entry updates; Google Sheets has no cell-level CAS.
  // Read-back verification plus fixed rows makes an uncertain write retry-safe.
  attemptedWrite=true;
  await request(`${API}/${source.id}/values/${encodeURIComponent(rowRange)}?valueInputOption=RAW`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({range:rowRange,majorDimension:'ROWS',values:[desired]})});
  if(!sameRow(await read(rowRange),desired))return fail('verification');
 }catch(error){
  if(error instanceof IntercompanySheetError)throw new IntercompanySheetError(error.code,attemptedWrite);
  throw new IntercompanySheetError('unavailable',attemptedWrite);
 }finally{clearTimeout(timer);}
}

const SOURCE_ID_HEADER='연동ID';
const matrix=(value:unknown,maxRows:number):IntercompanySheetCell[][]=>{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>maxRows||value.some(row=>!Array.isArray(row)||row.length>9||row.some(cell=>cell!==null&&!['string','number','boolean'].includes(typeof cell))))return fail('verification');
 return value as IntercompanySheetCell[][];
};
const rawFingerprint=(raw:Pick<IntercompanySheetRaw,'sourceGid'|'mirrorGid'|'sourceValues'|'sourceFormulas'|'mirrorValues'>)=>createHash('sha256').update(JSON.stringify({sourceGid:raw.sourceGid,mirrorGid:raw.mirrorGid,sourceValues:raw.sourceValues.slice(0,70),sourceFormulas:raw.sourceFormulas.slice(0,70),mirrorValues:raw.mirrorValues})).digest('hex');
async function withSheetClient<T>(options:Options,work:(request:(url:string,init?:RequestInit)=>Promise<unknown>)=>Promise<T>):Promise<T>{
 const jwt=assertion(options.env??process.env,(options.now??Date.now)());
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(30000,Math.max(1,options.timeoutMs??30000))),fetcher=options.fetcher??fetch;
 let token:string|null=null;
 const request=async(url:string,init:RequestInit={})=>{
  if(controller.signal.aborted)return fail('unavailable');
  const response=await bounded(Promise.resolve().then(()=>fetcher(url,{...init,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...init.headers},cache:'no-store',redirect:'error',signal:controller.signal})),controller.signal);
  if(!response.ok){void response.body?.cancel().catch(()=>{});return fail(response.status===401||response.status===403?'authorization':'unavailable');}
  if(Number(response.headers.get('content-length')??0)>4*1024*1024){void response.body?.cancel().catch(()=>{});return fail('verification');}
  const body=await bounded(response.text(),controller.signal);if(Buffer.byteLength(body,'utf8')>4*1024*1024)return fail('verification');
  try{return JSON.parse(body) as unknown;}catch{return fail('verification');}
 };
 try{
  const auth=object(await request(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt}).toString()}));
  if(!auth||typeof auth.access_token!=='string'||!auth.access_token||auth.access_token.length>4096||/\s/.test(auth.access_token)||auth.token_type!=='Bearer'||typeof auth.expires_in!=='number'||auth.expires_in<60)return fail('authorization');
  token=auth.access_token;return await work(request);
 }catch(error){if(error instanceof IntercompanySheetError)throw error;throw new IntercompanySheetError('unavailable');}finally{clearTimeout(timer);}
}

/** Server-only bounded read; automatic presentation rows below 70 never enter source identity. */
export async function readIntercompanySheetSource(baseline:MirrorBaseline,options:Options={}):Promise<IntercompanySheetRaw>{
 const source=target(baseline);
 return withSheetClient(options,async request=>{
  const metadata=object(await request(`${API}/${source.id}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`));
  if(!Array.isArray(metadata?.sheets))return fail('tab_changed');
  const sheets=metadata.sheets.map(value=>object(object(value)?.properties)),sources=sheets.filter(sheet=>sheet?.sheetId===source.sourceGid),mirrors=sheets.filter(sheet=>sheet?.sheetId===source.mirrorGid);
  const original=sources[0],mirror=mirrors[0],sourceGrid=object(original?.gridProperties),mirrorGrid=object(mirror?.gridProperties);
  if(sources.length!==1||mirrors.length!==1||typeof original?.title!=='string'||!original.title||mirror?.title!==source.name||typeof sourceGrid?.rowCount!=='number'||sourceGrid.rowCount<70||typeof sourceGrid.columnCount!=='number'||sourceGrid.columnCount<9||typeof mirrorGrid?.rowCount!=='number'||mirrorGrid.rowCount<10000||typeof mirrorGrid.columnCount!=='number'||mirrorGrid.columnCount<9)return fail('tab_changed');
  const range=(name:string,cells:string)=>`'${name.replace(/'/g,"''")}'!${cells}`;
  const sourceRange=range(original.title,`A1:I${Math.min(170,sourceGrid.rowCount)}`),mirrorRange=range(source.name,'A1:I10000');
  const query=new URLSearchParams({valueRenderOption:'FORMULA'});query.append('ranges',sourceRange);query.append('ranges',mirrorRange);
  const formulaReply=object(await request(`${API}/${source.id}/values:batchGet?${query}`));
  if(!Array.isArray(formulaReply?.valueRanges)||formulaReply.valueRanges.length!==2)return fail('verification');
  const sourceFormulas=matrix(object(formulaReply.valueRanges[0])?.values,170),mirrorValues=matrix(object(formulaReply.valueRanges[1])?.values,10000);
  const effective=object(await request(`${API}/${source.id}/values/${encodeURIComponent(sourceRange)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`));
  const sourceValues=matrix(effective?.values,170);
  if(!sameRow(mirrorValues[0] as Cell[]??[],[...INTERCOMPANY_MIRROR_HEADERS]))return fail('headers_changed');
  const raw={sourceTitle:original.title,sourceGid:String(source.sourceGid),mirrorTitle:source.name,mirrorGid:String(source.mirrorGid),sourceValues,sourceFormulas,mirrorValues,capturedAt:new Date((options.now??Date.now)()).toISOString()};
  return {...raw,fingerprint:rawFingerprint(raw)};
 });
}

function stampComparison(raw:IntercompanySheetRaw,writes:IntercompanyIdentifierWrite[]){
 const normalize=(matrix:IntercompanySheetCell[][])=>Array.from({length:70},(_,index)=>{
  const row=Array.from({length:9},(_,column)=>matrix[index]?.[column]??null);
  if(index===46||writes.some(write=>write.row===index+1))row[7]=null;
  return row;
 });
 return JSON.stringify({sourceValues:normalize(raw.sourceValues),sourceFormulas:normalize(raw.sourceFormulas),mirrorValues:raw.mirrorValues});
}

/** Writes only missing persistent IDs in H; never changes financial cells or summary formulas. */
export async function stampIntercompanySourceIdentifiers(baseline:MirrorBaseline,raw:IntercompanySheetRaw,writes:IntercompanyIdentifierWrite[],options:Options={}):Promise<IntercompanySheetRaw>{
 if(writes.length===0)return raw;
 if(writes.length>23||new Set(writes.map(write=>write.row)).size!==writes.length||new Set(writes.map(write=>write.value)).size!==writes.length||writes.some(write=>!Number.isInteger(write.row)||write.row<48||write.row>70||!(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(write.value)||/^source-row-(?:4[89]|5[0-5])$/.test(write.value))||write.expectedRow.length!==9))return fail('invalid_entry');
 const source=target(baseline),before=await readIntercompanySheetSource(baseline,options);
 if(before.sourceTitle!==raw.sourceTitle||stampComparison(before,writes)!==stampComparison(raw,writes))return fail('source_changed');
 const header=before.sourceValues[46]?.[7];if(header!=null&&header!==''&&header!==SOURCE_ID_HEADER)return fail('headers_changed');
 const pending=writes.filter(write=>{
  const row=Array.from({length:9},(_,index)=>before.sourceValues[write.row-1]?.[index]??null);
  if(JSON.stringify(row.slice(0,7))!==JSON.stringify(write.expectedRow.slice(0,7))||row[8]!==write.expectedRow[8])return fail('source_changed');
  if(row[7]===write.value)return false;if(row[7]!==null&&row[7]!=='')return fail('row_conflict');return true;
 });
 if(pending.length===0)return before;
 const range=(cells:string)=>`'${before.sourceTitle.replace(/'/g,"''")}'!${cells}`;
 await withSheetClient(options,request=>request(`${API}/${source.id}/values:batchUpdate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'RAW',data:[...(!header?[{range:range('H47'),majorDimension:'ROWS',values:[[SOURCE_ID_HEADER]]}]:[]),...pending.map(write=>({range:range(`H${write.row}`),majorDimension:'ROWS',values:[[write.value]]}))]})}));
 const after=await readIntercompanySheetSource(baseline,options);
 if(stampComparison(before,writes)!==stampComparison(after,writes)||writes.some(write=>after.sourceValues[write.row-1]?.[7]!==write.value)||after.sourceValues[46]?.[7]!==SOURCE_ID_HEADER)return fail('source_changed');
 return after;
}

export type IntercompanySourceReconciliation={row:number;expectedRow:IntercompanySheetCell[];date:string;fromParty:string;toParty:string;amount:number;kind:'loan'|'repayment'};
/** A DB-leased, explicitly selected mirror edit may normalize only its linked source financial cells. */
export async function reconcileIntercompanySourceRows(baseline:MirrorBaseline,raw:IntercompanySheetRaw,updates:IntercompanySourceReconciliation[],options:Options={}):Promise<IntercompanySheetRaw>{
 if(!updates.length)return raw;
 const source=target(baseline);
 if(updates.length>23||new Set(updates.map(update=>update.row)).size!==updates.length)return fail('invalid_entry');
 const planned=updates.map(update=>{
  const timestamp=Date.parse(update.date+'T00:00:00Z'),from=baseline.businesses.find(party=>party.key===update.fromParty),to=baseline.businesses.find(party=>party.key===update.toParty);
  if(!Number.isInteger(update.row)||update.row<48||update.row>70||update.expectedRow.length!==9||!/^\d{4}-\d{2}-\d{2}$/.test(update.date)||!Number.isFinite(timestamp)||new Date(timestamp).toISOString().slice(0,10)!==update.date||!from||!to||from.key===to.key||!Number.isSafeInteger(update.amount)||update.amount<=0||!['loan','repayment'].includes(update.kind))return fail('invalid_entry');
  const serial=timestamp/86400000+25569,label=update.kind==='loan'?'대여금':'대여금 상환';
  const oldKind=typeof update.expectedRow[6]==='string'?update.expectedRow[6]:'';
  const kindValue=/^대여금(?:\s*상환)?(?:\s*[·;,].*)?$/.test(oldKind)?oldKind.replace(/^대여금(?:\s*상환)?/,label):label;
  return {...update,values:[serial,from.name,to.name,update.amount],kindValue};
 });
 const before=await readIntercompanySheetSource(baseline,options);
 if(before.fingerprint!==raw.fingerprint||before.sourceTitle!==raw.sourceTitle)return fail('source_changed');
 const pending=planned.filter(update=>{
  const cells=Array.from({length:9},(_,index)=>before.sourceValues[update.row-1]?.[index]??null);
  if(JSON.stringify(cells)!==JSON.stringify(update.expectedRow))return fail('source_changed');
  return !update.values.every((value,index)=>cells[index]===value)||cells[6]!==update.kindValue;
 });
 if(!pending.length)return before;
 const range=(cells:string)=>`'${before.sourceTitle.replace(/'/g,"''")}'!${cells}`;
 let attempted=false;
 try{
  attempted=true;
  await withSheetClient(options,request=>request(`${API}/${source.id}/values:batchUpdate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'RAW',data:pending.flatMap(update=>[{range:range(`A${update.row}:D${update.row}`),majorDimension:'ROWS',values:[update.values]},{range:range(`G${update.row}`),majorDimension:'ROWS',values:[[update.kindValue]]}])})}));
  const after=await readIntercompanySheetSource(baseline,options);
  const masked=(value:IntercompanySheetRaw)=>JSON.stringify({formulas:Array.from({length:70},(_,index)=>{
   const row=Array.from({length:9},(_,column)=>value.sourceFormulas[index]?.[column]??null);
   if(pending.some(update=>update.row===index+1))for(const column of [0,1,2,3,6])row[column]=null;
   return row;
  }),mirror:value.mirrorValues});
  if(masked(before)!==masked(after)||pending.some(update=>!update.values.every((value,index)=>after.sourceValues[update.row-1]?.[index]===value)||after.sourceValues[update.row-1]?.[6]!==update.kindValue))return fail('source_changed');
  return after;
 }catch(error){if(error instanceof IntercompanySheetError)throw new IntercompanySheetError(error.code,attempted);throw new IntercompanySheetError('unavailable',attempted);}
}

/** Repairs only previously verified source C/D formulas using explicit native UUID identity. */
export async function normalizeIntercompanySourceFormulas(baseline:MirrorBaseline,raw:IntercompanySheetRaw,parsed:IntercompanySheetSource,linkedIds:ReadonlySet<string>,options:Options={}):Promise<IntercompanySheetRaw>{
 if(parsed.issues.length||parsed.fingerprint!==raw.fingerprint||parsed.historicalBasePairs.length===0)return fail('verification');
 const source=target(baseline),sheet=`'${raw.mirrorTitle.replace(/'/g,"''")}'!`;
 const planned=parsed.historicalBasePairs.map(pair=>{
  const formula=(forward:boolean)=>{
   const a=forward?`A${pair.row}`:`B${pair.row}`,b=forward?`B${pair.row}`:`A${pair.row}`,from=forward?pair.business_a:pair.business_b,to=forward?pair.business_b:pair.business_a,base=forward?pair.base_a_expression??String(pair.a_to_b):pair.base_b_expression??String(pair.b_to_a);
   let value=`=(${base}+SUMIFS($D$48:$D$70,$B$48:$B$70,${a},$C$48:$C$70,${b}))+SUMIFS(${sheet}$E$2:$E$10000,${sheet}$C$2:$C$10000,${a},${sheet}$D$2:$D$10000,${b},${sheet}$G$2:$G$10000,"정상")`;
   for(const row of parsed.sourceRows.filter(row=>row.fromParty===from&&row.toParty===to)){
    const column=row.nativeId&&linkedIds.has(row.nativeId)?'E':linkedIds.has(row.id)&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(row.id)?'H':null;
    if(column)value+='-'+intercompanySourceDedupFormula(row.row,raw.mirrorTitle,column);
   }
   return value;
  };
  return {row:pair.row,values:[formula(true),formula(false)]};
 }).filter(update=>update.values.some((value,index)=>raw.sourceFormulas[update.row-1]?.[index+2]!==value));
 if(!planned.length)return raw;
 const before=await readIntercompanySheetSource(baseline,options);
 if(before.fingerprint!==raw.fingerprint)return fail('source_changed');
 const range=(row:number)=>`'${before.sourceTitle.replace(/'/g,"''")}'!C${row}:D${row}`;
 let attempted=false;
 try{
  attempted=true;
  await withSheetClient(options,request=>request(`${API}/${source.id}/values:batchUpdate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'USER_ENTERED',data:planned.map(update=>({range:range(update.row),majorDimension:'ROWS',values:[update.values]}))})}));
  const after=await readIntercompanySheetSource(baseline,options);
  const masked=(value:IntercompanySheetRaw)=>JSON.stringify({formulas:Array.from({length:70},(_,index)=>{
   const row=Array.from({length:9},(_,column)=>value.sourceFormulas[index]?.[column]??null);
   if(planned.some(update=>update.row===index+1)){row[2]=null;row[3]=null;}return row;
  }),mirror:value.mirrorValues});
  if(masked(before)!==masked(after)||planned.some(update=>update.values.some((value,index)=>after.sourceFormulas[update.row-1]?.[index+2]!==value)))return fail('source_changed');
  return after;
 }catch(error){if(error instanceof IntercompanySheetError)throw new IntercompanySheetError(error.code,attempted);throw new IntercompanySheetError('unavailable',attempted);}
}
