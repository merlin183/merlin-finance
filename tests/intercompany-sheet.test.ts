import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {INTERCOMPANY_MIRROR_HEADERS,INTERCOMPANY_MIRROR_SHEET_NAME,IntercompanySheetError,syncIntercompanySheetEntry,readIntercompanySheetSource,stampIntercompanySourceIdentifiers,reconcileIntercompanySourceRows,normalizeIntercompanySourceFormulas} from '../lib/finance/intercompany-sheet';
import {parseIntercompanySheetSource} from '../lib/finance/intercompany-sheet-source';
import type {IntercompanyBaseline,IntercompanyEntry} from '../lib/finance/intercompany-register';

// Synthetic parties, IDs, financial amounts, and a throwaway RSA key only.
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const env:NodeJS.ProcessEnv={NODE_ENV:'test',FINANCE_GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',client_email:'synthetic-service@synthetic-project.iam.gserviceaccount.com',private_key:keys.privateKey.export({type:'pkcs8',format:'pem'}),private_key_id:'synthetic-key',token_uri:'https://untrusted.example.test/token'})};
const now=Date.parse('2026-10-21T00:00:00Z');
const baseline:IntercompanyBaseline={
 source_url:'https://docs.google.com/spreadsheets/d/synthetic_workbook_identifier_12345/edit?gid=123#gid=123',gid:'123',mirror_gid:'456',mirror_sheet_name:INTERCOMPANY_MIRROR_SHEET_NAME,
 as_of:'2026-10-20',coverage_start:null,opening_balance_known:false,totals_include_additions:true,notes:[],
 businesses:[{key:'company-a',name:'가상사업자 A',business_id:null},{key:'company-b',name:'가상사업자 B',business_id:null}],pairs:[],additions:[],
};
const entry:IntercompanyEntry={id:'10000000-0000-4000-8000-000000000001',from_party:'company-a',to_party:'company-b',entry_date:'2026-10-21',amount:1000,kind:'loan',memo:'합성 대여 기록',version:1,voided:false,sheet_row:2,created_at:'2026-10-21T00:00:00Z',updated_at:'2026-10-21T00:00:00Z',sheet_status:'pending',sheet_synced_at:null,sheet_error:''};
type Row=(string|number)[];
const desired=(value:IntercompanyEntry=entry):Row=>[value.id,value.entry_date,'가상사업자 A','가상사업자 B',value.amount,value.kind==='loan'?'대여금':'대여금 상환',value.voided?'취소':'정상',value.version,value.memo];
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function harness(){
 let row:Row[]=[],headers:Row=[...INTERCOMPANY_MIRROR_HEADERS],sourcePresent=true,mirrorName=INTERCOMPANY_MIRROR_SHEET_NAME,rowCount=10000;
 let uncertainWrite=false,badVerification=false,unavailable=false,token:unknown={access_token:'synthetic-access-token',token_type:'Bearer',expires_in:3600};
 const calls:{url:string;init:RequestInit}[]=[];
 const fetcher:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input));calls.push({url:url.href,init});
  if(unavailable)throw Error('SENSITIVE_PROVIDER_ERROR_DO_NOT_EXPOSE');
  if(url.hostname==='oauth2.googleapis.com')return reply(token);
  if(!url.pathname.includes('/values/'))return reply({sheets:[...(sourcePresent?[{properties:{sheetId:123,title:'가상 원본 요약'}}]:[]),{properties:{sheetId:456,title:mirrorName,gridProperties:{rowCount,columnCount:9}}}]});
  const a1=decodeURIComponent(url.pathname.split('/values/')[1]);
  if(a1.endsWith('A1:I1'))return reply({values:[headers]});
  if(init.method==='PUT'){
   const body=JSON.parse(String(init.body));row=structuredClone(body.values);
   if(uncertainWrite){uncertainWrite=false;throw Error('SENSITIVE_PROVIDER_TIMEOUT');}
   if(badVerification)row[0][4]=9999;
   return reply({updatedRows:1,updatedCells:9});
  }
  return reply({values:row});
 };
 return {fetcher,calls,options:{fetcher,env,now:()=>now},row:()=>row,setRow:(value:Row[])=>{row=structuredClone(value);},setHeaders:(value:Row)=>{headers=value;},setMissingSource:()=>{sourcePresent=false;},setMirrorName:(value:string)=>{mirrorName=value;},setRowCount:(value:number)=>{rowCount=value;},setUncertainWrite:()=>{uncertainWrite=true;},setBadVerification:()=>{badVerification=true;},setUnavailable:()=>{unavailable=true;},setToken:(value:unknown)=>{token=value;}};
}
const puts=(h:ReturnType<typeof harness>)=>h.calls.filter(call=>call.init.method==='PUT');
async function rejectsCode(promise:Promise<unknown>,code:string,uncertain?:boolean){
 await assert.rejects(promise,(error:unknown)=>{
  assert.ok(error instanceof IntercompanySheetError);assert.equal(error.code,code);
  if(uncertain!==undefined)assert.equal(error.writeMayHaveSucceeded,uncertain);
  assert.doesNotMatch(error.message,/SENSITIVE_|synthetic-access-token|BEGIN PRIVATE KEY/);return true;
 });
}

test('고정 할당 행만 RAW로 기록하고 읽기 대조 후 완료한다',async()=>{
 const h=harness();await syncIntercompanySheetEntry(baseline,entry,h.options);
 assert.deepEqual(h.row(),[desired()]);assert.equal(puts(h).length,1);
 const write=puts(h)[0],url=new URL(write.url);
 assert.equal(url.searchParams.get('valueInputOption'),'RAW');
 assert.equal(decodeURIComponent(url.pathname.split('/values/')[1]),`'${INTERCOMPANY_MIRROR_SHEET_NAME}'!A2:I2`);
 assert.ok(h.calls.every(call=>!call.url.includes(':append')));
 assert.ok(h.calls.every(call=>call.init.cache==='no-store'&&call.init.redirect==='error'&&!!call.init.signal));
 const reads=h.calls.filter(call=>call.url.includes('/values/')&&call.init.method!=='PUT');
 assert.equal(reads.length,3);assert.ok(reads.every(call=>new URL(call.url).searchParams.get('valueRenderOption')==='FORMULA'));
});

test('RS256 JWT는 Sheets 범위와 고정 토큰 주소만 사용하고 위임·키 내용을 노출하지 않는다',async()=>{
 const h=harness();await syncIntercompanySheetEntry(baseline,entry,h.options);
 const auth=h.calls[0];assert.equal(auth.url,'https://oauth2.googleapis.com/token');
 const form=new URLSearchParams(String(auth.init.body));assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
 const jwt=form.get('assertion')!,[header,payload,signature]=jwt.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(header,'base64url').toString()),{alg:'RS256',typ:'JWT',kid:'synthetic-key'});
 assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url').toString()),{iss:'synthetic-service@synthetic-project.iam.gserviceaccount.com',scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now/1000,exp:now/1000+3600});
 assert.equal(verify('RSA-SHA256',Buffer.from(`${header}.${payload}`),keys.publicKey,Buffer.from(signature,'base64url')),true);
 assert.doesNotMatch(String(auth.init.body),/PRIVATE KEY|untrusted|drive/);
 assert.ok(h.calls.slice(1).every(call=>new URL(call.url).hostname==='sheets.googleapis.com'&&new Headers(call.init.headers).get('Authorization')==='Bearer synthetic-access-token'));
});

test('응답이 유실된 기록은 같은 행을 조회해 재시도하며 중복 쓰지 않는다',async()=>{
 const h=harness();h.setUncertainWrite();
 await rejectsCode(syncIntercompanySheetEntry(baseline,entry,h.options),'unavailable',true);
 assert.deepEqual(h.row(),[desired()]);
 await syncIntercompanySheetEntry(baseline,entry,h.options);
 assert.equal(puts(h).length,1);assert.equal(h.row().length,1);
});

test('동일 버전·동일 내용이면 쓰지 않고 이미 반영된 것으로 확인한다',async()=>{
 const h=harness();h.setRow([desired()]);await syncIntercompanySheetEntry(baseline,entry,h.options);assert.equal(puts(h).length,0);
});

test('취소·복원은 동일 행 상태와 버전만 바꾸고 기존 금액·종류를 유지한다',async()=>{
 const h=harness();h.setRow([desired()]);
 const cancelled={...entry,voided:true,version:2};await syncIntercompanySheetEntry(baseline,cancelled,h.options);
 assert.deepEqual(h.row(),[desired(cancelled)]);
 const restored={...entry,version:3};await syncIntercompanySheetEntry(baseline,restored,h.options);
 assert.deepEqual(h.row(),[desired(restored)]);assert.equal(new Set(puts(h).map(call=>call.url)).size,1);
});

test('다른 기록ID·수동 변경·같은 버전의 충돌은 덮어쓰지 않는다',async()=>{
 for(const column of [0,1,2,3,4,5,6,8]){
  const h=harness(),row=desired();row[column]=typeof row[column]==='number'?2000:'시트에서 바꾼 값';h.setRow([row]);
  await rejectsCode(syncIntercompanySheetEntry(baseline,entry,h.options),'row_conflict',false);assert.equal(puts(h).length,0);
 }
 const h=harness();h.setRow([['','','','',2000]]);
 await rejectsCode(syncIntercompanySheetEntry(baseline,entry,h.options),'row_conflict');assert.equal(puts(h).length,0);
});

test('오래된 버전은 최신 취소 상태를 되돌리지 않는다',async()=>{
 const h=harness();h.setRow([desired({...entry,version:3,voided:true})]);
 await rejectsCode(syncIntercompanySheetEntry(baseline,{...entry,version:2},h.options),'stale_version',false);
 assert.equal(puts(h).length,0);assert.equal(h.row()[0][6],'취소');
});

test('더 새 버전을 반영할 때도 기존 메모·금융 값의 수동 변경은 보존한다',async()=>{
 const h=harness(),row=desired();row[8]='시트에서 직접 수정한 메모';h.setRow([row]);
 await rejectsCode(syncIntercompanySheetEntry(baseline,{...entry,version:2,voided:true},h.options),'row_conflict',false);
 assert.equal(h.row()[0][8],'시트에서 직접 수정한 메모');assert.equal(puts(h).length,0);
});

test('상환 종류와 수식처럼 생긴 메모·사업자명도 문자열 그대로 저장한다',async()=>{
 const h=harness(),value={...entry,kind:'repayment' as const,memo:'=HYPERLINK("https://example.test","확인")'};
 const source={...baseline,businesses:[{...baseline.businesses[0],name:'=가상사업자 A'},baseline.businesses[1]]};
 await syncIntercompanySheetEntry(source,value,h.options);
 assert.equal(h.row()[0][2],'=가상사업자 A');assert.equal(h.row()[0][5],'대여금 상환');assert.equal(h.row()[0][8],value.memo);
 assert.equal(new URL(puts(h)[0].url).searchParams.get('valueInputOption'),'RAW');
});

test('시트 주소·원본/기록 탭 식별자가 잘못되면 인증 전에 중단한다',async()=>{
 for(const source of [
  {...baseline,source_url:'https://docs.google.com.evil.test/spreadsheets/d/synthetic_workbook_identifier_12345/edit'},
  {...baseline,source_url:'http://docs.google.com/spreadsheets/d/synthetic_workbook_identifier_12345/edit'},
  {...baseline,source_url:'https://user:password@docs.google.com/spreadsheets/d/synthetic_workbook_identifier_12345/edit'},
  {...baseline,source_url:'https://docs.google.com:444/spreadsheets/d/synthetic_workbook_identifier_12345/edit'},
  {...baseline,source_url:'https://docs.google.com/spreadsheets/d/too_short/edit'},
  {...baseline,mirror_gid:baseline.gid},{...baseline,mirror_gid:'invalid'},{...baseline,mirror_sheet_name:'다른 시트'},
 ]){
  const h=harness();await rejectsCode(syncIntercompanySheetEntry(source,entry,h.options),'invalid_source',false);assert.equal(h.calls.length,0);
 }
});

test('없는 자격증명·잘못된 키는 외부 요청 없이 안전한 오류를 반환한다',async()=>{
 for(const value of [undefined,'not json',JSON.stringify({type:'service_account',client_email:'not a service account',private_key:'SENSITIVE_FAKE_KEY'})]){
  const h=harness();await rejectsCode(syncIntercompanySheetEntry(baseline,entry,{...h.options,env:{NODE_ENV:'test',FINANCE_GOOGLE_SERVICE_ACCOUNT_JSON:value}}),'configuration',false);assert.equal(h.calls.length,0);
 }
});

test('검증되지 않은 날짜·금액·사업자·행은 인증 전에 중단한다',async()=>{
 for(const value of [
  {...entry,sheet_row:1},{...entry,sheet_row:2.5},{...entry,sheet_row:1000001},
  {...entry,entry_date:'2026-02-30'},{...entry,amount:0},{...entry,amount:1.5},{...entry,amount:Number.MAX_SAFE_INTEGER+1},
  {...entry,from_party:'missing'},{...entry,to_party:entry.from_party},{...entry,version:0},
 ]){
  const h=harness();await rejectsCode(syncIntercompanySheetEntry(baseline,value,h.options),'invalid_entry',false);assert.equal(h.calls.length,0);
 }
});

test('원본 탭 누락·기록 탭 이름 변경·할당 행 범위 부족이면 쓰지 않는다',async()=>{
 for(const change of [(h:ReturnType<typeof harness>)=>h.setMissingSource(),(h:ReturnType<typeof harness>)=>h.setMirrorName('다른 기록 탭'),(h:ReturnType<typeof harness>)=>h.setRowCount(1)]){
  const h=harness();change(h);await rejectsCode(syncIntercompanySheetEntry(baseline,entry,h.options),'tab_changed',false);assert.equal(puts(h).length,0);
 }
 const h=harness();h.setHeaders(['바뀐 헤더',...INTERCOMPANY_MIRROR_HEADERS.slice(1)]);
 await rejectsCode(syncIntercompanySheetEntry(baseline,entry,h.options),'headers_changed',false);assert.equal(puts(h).length,0);
});

test('인증·원격 오류 메시지나 토큰을 외부에 반환하지 않는다',async()=>{
 const unavailable=harness();unavailable.setUnavailable();await rejectsCode(syncIntercompanySheetEntry(baseline,entry,unavailable.options),'unavailable',false);
 for(const token of [{access_token:'synthetic-access-token',token_type:'Other',expires_in:3600},{access_token:'bad token',token_type:'Bearer',expires_in:3600},{access_token:'synthetic-access-token',token_type:'Bearer',expires_in:0}]){
  const h=harness();h.setToken(token);await rejectsCode(syncIntercompanySheetEntry(baseline,entry,h.options),'authorization',false);assert.equal(puts(h).length,0);
 }
 const h=harness(),fetcher:typeof fetch=async()=>reply({error:'SENSITIVE_PROVIDER_ERROR'},403);
 await rejectsCode(syncIntercompanySheetEntry(baseline,entry,{...h.options,fetcher}),'authorization',false);
});

test('쓰기 후 값이 다르면 성공으로 보고하지 않는다',async()=>{
 const h=harness();h.setBadVerification();await rejectsCode(syncIntercompanySheetEntry(baseline,entry,h.options),'verification',true);assert.equal(puts(h).length,1);
});

test('응답이 멈춰도 전체 작업 제한 시간 안에 중단하고 자동 append하지 않는다',async()=>{
 const h=harness(),fetcher:typeof fetch=async(input,init)=>{
  if(init?.method==='PUT')return await new Promise<Response>(()=>{});
  return h.fetcher(input,init);
 };
 await rejectsCode(syncIntercompanySheetEntry(baseline,entry,{...h.options,fetcher,timeoutMs:25}),'unavailable',true);
 assert.ok(h.calls.every(call=>!call.url.includes(':append')));
});

test('서버가 보관한 정확한 이전 9셀과 더 새 버전에서만 금융값 수정을 허용한다',async()=>{
 const h=harness(),prior=desired();h.setRow([prior]);const amended={...entry,amount:2000,version:2,memo:'수정된 합성 금액'};
 await syncIntercompanySheetEntry(baseline,amended,{...h.options,expectedPreviousRow:prior});assert.deepEqual(h.row(),[desired(amended)]);
 const bad=harness();bad.setRow([prior]);const wrong=[...prior];wrong[4]=999;
 await rejectsCode(syncIntercompanySheetEntry(baseline,amended,{...bad.options,expectedPreviousRow:wrong}),'row_conflict');assert.equal(puts(bad).length,0);
 const same=harness();same.setRow([prior]);await rejectsCode(syncIntercompanySheetEntry(baseline,{...entry,amount:2000},{...same.options,expectedPreviousRow:prior}),'row_conflict');assert.equal(puts(same).length,0);
});

function sourceHarness(){
 const source=Array.from({length:170},()=>[] as (string|number)[]),formulas=Array.from({length:170},()=>[] as (string|number)[]);
 source[46]=['기재일','보낸 사업자','받은 사업자','반영 금액','반영 위치','근거','비고'];source[47]=[46307,'가상사업자 A','가상사업자 B',1000,entry.id,'원본 근거','대여금','','원본 마지막 메모'];
 for(let i=0;i<source.length;i++)formulas[i]=[...source[i]];
 const calls:{url:string;init:RequestInit}[]=[];let concurrentEdit=false,uncertain=false;
 const fetcher:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input));calls.push({url:url.href,init});
  if(url.hostname==='oauth2.googleapis.com')return reply({access_token:'synthetic-access-token',token_type:'Bearer',expires_in:3600});
  if(url.pathname.endsWith('/values:batchGet'))return reply({valueRanges:[{values:formulas},{values:[[...INTERCOMPANY_MIRROR_HEADERS]]}]});
  if(url.pathname.endsWith('/values:batchUpdate')){
   const body=JSON.parse(String(init.body));
   for(const update of body.data){const match=String(update.range).match(/!([A-I])(\d+)(?::[A-I]\d+)?$/)!;const row=Number(match[2])-1,column=match[1].charCodeAt(0)-65;for(let j=0;j<update.values[0].length;j++){source[row][column+j]=update.values[0][j];formulas[row][column+j]=update.values[0][j];}}
   if(concurrentEdit){source[47][5]='다른 관리자가 바꾼 근거';formulas[47][5]=source[47][5];}
   if(uncertain){uncertain=false;throw Error('SENSITIVE_UNCERTAIN_STAMP');}
   return reply({totalUpdatedCells:body.data.length});
  }
  if(url.pathname.includes('/values/'))return reply({values:source});
  return reply({sheets:[{properties:{sheetId:123,title:'가상 원본 요약',gridProperties:{rowCount:170,columnCount:9}}},{properties:{sheetId:456,title:INTERCOMPANY_MIRROR_SHEET_NAME,gridProperties:{rowCount:10000,columnCount:9}}}]});
 };
 return {source,formulas,calls,options:{fetcher,env,now:()=>now},concurrent:()=>{concurrentEdit=true;},uncertain:()=>{uncertain=true;}};
}
const sourceWrites=(h:ReturnType<typeof sourceHarness>)=>h.calls.filter(call=>call.url.includes('/values:batchUpdate'));
test('원본·수식·mirror를 bounded 읽고 자동 표시 영역은 fingerprint에서 제외한다',async()=>{
 const h=sourceHarness(),raw=await readIntercompanySheetSource(baseline,h.options);assert.equal(raw.sourceTitle,'가상 원본 요약');assert.equal(raw.sourceValues.length,170);assert.equal(raw.mirrorValues.length,1);assert.equal(sourceWrites(h).length,0);
 h.source[74]=['자동 표시 100'];h.formulas[74]=['자동 표시 100'];const next=await readIntercompanySheetSource(baseline,h.options);assert.equal(next.fingerprint,raw.fingerprint);
 const query=new URL(h.calls.find(call=>call.url.includes('/values:batchGet'))!.url);assert.deepEqual(query.searchParams.getAll('ranges'),["'가상 원본 요약'!A1:I170",`'${INTERCOMPANY_MIRROR_SHEET_NAME}'!A1:I10000`]);
});
test('원본 H 식별자와 H47 제목만 쓰고 금융값·원문은 보존한다',async()=>{
 const h=sourceHarness(),raw=await readIntercompanySheetSource(baseline,h.options),before=structuredClone(h.source[47]);
 const after=await stampIntercompanySourceIdentifiers(baseline,raw,[{row:48,value:'source-row-48',expectedRow:Array.from({length:9},(_,i)=>raw.sourceValues[47]?.[i]??null)}],h.options);
 assert.equal(after.sourceValues[47][7],'source-row-48');assert.equal(after.sourceValues[46][7],'연동ID');
 for(const column of [0,1,2,3,4,5,6,8])assert.equal(h.source[47][column],before[column]);
 const data=JSON.parse(String(sourceWrites(h)[0].init.body));assert.equal(data.valueInputOption,'RAW');assert.deepEqual(data.data.map((row:{range:string})=>row.range),["'가상 원본 요약'!H47","'가상 원본 요약'!H48"]);
 await stampIntercompanySourceIdentifiers(baseline,after,[],h.options);assert.equal(sourceWrites(h).length,1);
});
test('H 쓰기 전 원본 금액이 바뀌면 식별자를 쓰지 않는다',async()=>{
 const h=sourceHarness(),raw=await readIntercompanySheetSource(baseline,h.options);h.source[47][3]=2000;h.formulas[47][3]=2000;
 await rejectsCode(stampIntercompanySourceIdentifiers(baseline,raw,[{row:48,value:'source-row-48',expectedRow:Array.from({length:9},(_,i)=>raw.sourceValues[47]?.[i]??null)}],h.options),'source_changed');assert.equal(sourceWrites(h).length,0);
});
test('H 쓰기 응답이 유실돼도 같은 ID를 다시 확인하고 새 쓰기를 만들지 않는다',async()=>{
 const h=sourceHarness(),raw=await readIntercompanySheetSource(baseline,h.options),writes=[{row:48,value:'source-row-48',expectedRow:Array.from({length:9},(_,i)=>raw.sourceValues[47]?.[i]??null)}];h.uncertain();
 await rejectsCode(stampIntercompanySourceIdentifiers(baseline,raw,writes,h.options),'unavailable');await stampIntercompanySourceIdentifiers(baseline,raw,writes,h.options);assert.equal(sourceWrites(h).length,1);
});
test('선택한 linked 원본의 A:D/G만 바꾸고 날짜는 Google serial로 보관한다',async()=>{
 const h=sourceHarness(),raw=await readIntercompanySheetSource(baseline,h.options),before=structuredClone(h.source[47]);
 const after=await reconcileIntercompanySourceRows(baseline,raw,[{row:48,expectedRow:Array.from({length:9},(_,i)=>raw.sourceValues[47]?.[i]??null),date:'2026-10-22',fromParty:'company-b',toParty:'company-a',amount:2000,kind:'repayment'}],h.options);
 assert.deepEqual(after.sourceValues[47].slice(0,4),[46317,'가상사업자 B','가상사업자 A',2000]);assert.equal(after.sourceValues[47][6],'대여금 상환');for(const column of [4,5,7,8])assert.equal(h.source[47][column],before[column]);
 const data=JSON.parse(String(sourceWrites(h)[0].init.body));assert.deepEqual(data.data.map((row:{range:string})=>row.range),["'가상 원본 요약'!A48:D48","'가상 원본 요약'!G48"]);
});
test('원본 정규화 중 다른 금융 외 원문이 바뀌어도 성공으로 확정하지 않는다',async()=>{
 const h=sourceHarness(),raw=await readIntercompanySheetSource(baseline,h.options);h.concurrent();
 await rejectsCode(reconcileIntercompanySourceRows(baseline,raw,[{row:48,expectedRow:Array.from({length:9},(_,i)=>raw.sourceValues[47]?.[i]??null),date:'2026-10-22',fromParty:'company-a',toParty:'company-b',amount:2000,kind:'loan'}],h.options),'source_changed',true);
});

test('명시적 native UUID에 대해서만 원본 C/D dedup 수식을 수리하고 반복 쓰지 않는다',async()=>{
 const h=sourceHarness();h.source[1]=['원장 기록 2023-01-01~2026-10-01 · 확인 2026-10-20'];h.formulas[1]=[...h.source[1]];
 h.source[8]=['가상사업자 A','가상사업자 B',1500,100,1400,'','합성 근거'];h.formulas[8]=[...h.source[8]];
 const sheet=`'${INTERCOMPANY_MIRROR_SHEET_NAME}'!`,formula=(reverse:boolean)=>{const a=reverse?'B9':'A9',b=reverse?'A9':'B9';return `=(${reverse?100:500}+SUMIFS($D$48:$D$70,$B$48:$B$70,${a},$C$48:$C$70,${b}))+SUMIFS(${sheet}$E$2:$E$10000,${sheet}$C$2:$C$10000,${a},${sheet}$D$2:$D$10000,${b},${sheet}$G$2:$G$10000,"정상")`;};
 h.formulas[8][2]=formula(false);h.formulas[8][3]=formula(true);
 const sourceBaseline={...baseline,pairs:[{business_a:'company-a',business_b:'company-b',a_to_b:1500,b_to_a:100,note:''}]};
 const raw=await readIntercompanySheetSource(sourceBaseline,h.options),parsed=parseIntercompanySheetSource(raw,sourceBaseline);assert.deepEqual(parsed.issues,[]);
 const after=await normalizeIntercompanySourceFormulas(sourceBaseline,raw,parsed,new Set([entry.id]),h.options);
 const data=JSON.parse(String(sourceWrites(h)[0].init.body));assert.equal(data.valueInputOption,'USER_ENTERED');assert.deepEqual(data.data.map((row:{range:string})=>row.range),["'가상 원본 요약'!C9:D9"]);
 assert.ok(String(after.sourceFormulas[8][2]).includes(`COUNTIF(${sheet}$A$2:$A$10000,$E$48)=1`));assert.equal(after.sourceValues[47][4],entry.id);assert.equal(after.sourceValues[47][3],1000);
 await normalizeIntercompanySourceFormulas(sourceBaseline,after,{...parsed,fingerprint:after.fingerprint},new Set([entry.id]),h.options);assert.equal(sourceWrites(h).length,1);
});
