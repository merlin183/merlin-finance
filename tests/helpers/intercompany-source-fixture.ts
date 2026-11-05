import type {IntercompanyBaseline,IntercompanyEntry,IntercompanyRegisterData} from '../../lib/finance/intercompany-register';
import type {IntercompanySheetRaw} from '../../lib/finance/intercompany-sheet-source';

export const ids={native:'20000000-0000-4000-8000-000000000001',second:'20000000-0000-4000-8000-000000000002',source:'30000000-0000-4000-8000-000000000001',token:'40000000-0000-4000-8000-000000000001',request:'50000000-0000-4000-8000-000000000001'};
export const syntheticBaseline=():IntercompanyBaseline=>({source_url:'https://docs.google.com/spreadsheets/d/synthetic-source-document-id/edit?gid=1',gid:'1',mirror_gid:'2',mirror_sheet_name:'사업자간 대여금_대시보드기록',as_of:'2020-10-20',coverage_start:'2020-01-01',opening_balance_known:false,totals_include_additions:true,notes:[],businesses:[{key:'a',name:'합성회사A',business_id:null},{key:'b',name:'합성회사B',business_id:null}],pairs:[{business_a:'a',business_b:'b',a_to_b:1200,b_to_a:400,note:''}],additions:[{id:'source-row-48',date:'2020-10-02',from_business:'a',to_business:'b',amount:200,kind:'loan',memo:'대여금'}]});
export const syntheticEntry=(extra:Partial<IntercompanyEntry>={}):IntercompanyEntry=>({id:ids.native,from_party:'a',to_party:'b',entry_date:'2020-10-21',amount:100,kind:'loan',memo:'합성 등록 메모',version:1,voided:false,sheet_row:2,created_at:'2020-10-21T00:00:00Z',updated_at:'2020-10-21T00:00:00Z',sheet_status:'synced',sheet_synced_at:'2020-10-21T00:01:00Z',sheet_error:'',...extra});
export const syntheticRegister=(entries=[syntheticEntry()]):IntercompanyRegisterData=>({baseline:syntheticBaseline(),entries});
export function syntheticRaw(register=syntheticRegister()):IntercompanySheetRaw{
 const sourceValues:Array<Array<string|number|null>>=Array.from({length:70},()=>[]),sourceFormulas:Array<Array<string|number|null>>=Array.from({length:70},()=>[]);
 sourceValues[1]=['원장 기록 2020-01-01~2020-10-01 · 확인 2020-10-20 · 단위: 원'];
 sourceValues[46]=['기재일','보낸 사업자','받은 사업자','반영 금액','반영 위치','근거','비고','연동ID'];
 sourceValues[47]=['2020-10-02','합성회사A','합성회사B',200,'','','대여금','source-row-48'];
 const mirrorValues:Array<Array<string|number>>=[['기록ID','일자','보낸 사업자','받은 사업자','금액','구분','상태','버전','메모']];
 for(const e of register.entries)mirrorValues[e.sheet_row-1]=[e.id,e.entry_date,e.from_party==='a'?'합성회사A':'합성회사B',e.to_party==='a'?'합성회사A':'합성회사B',e.amount,e.kind==='loan'?'대여금':'대여금 상환',e.voided?'취소':'정상',e.version,e.memo];
 const raw:IntercompanySheetRaw={sourceTitle:'합성 원본',sourceGid:'1',mirrorTitle:'사업자간 대여금_대시보드기록',mirrorGid:'2',sourceValues,sourceFormulas,mirrorValues,capturedAt:'2020-10-21T00:02:00Z',fingerprint:'synthetic-v1'};
 return refreshSyntheticRaw(raw);
}
export function refreshSyntheticRaw(raw:IntercompanySheetRaw){
 let a=1000,b=400;const linked:number[]=[];
 for(let n=48;n<=70;n++){const r=raw.sourceValues[n-1];if(!r?.length)continue;const forward=r[1]==='합성회사A';if(forward)a+=Number(r[3]);else b+=Number(r[3]);const m=raw.mirrorValues.find(v=>v[0]===(r[4]||r[7]));if(m){if(forward)a-=Number(r[3]);else b-=Number(r[3]);linked.push(n);}}
 for(const m of raw.mirrorValues.slice(1)){if(!m?.length||m[6]!=='정상')continue;if(m[2]==='합성회사A')a+=Number(m[4]);else b+=Number(m[4]);}
 raw.sourceValues[8]=['합성회사A','합성회사B',a,b,a-b,'방향','합성 근거'];
 const sheet="'사업자간 대여금_대시보드기록'!";
 const formula=(forward:boolean)=>{const from=forward?'A9':'B9',to=forward?'B9':'A9';let f=`=(${forward?1000:400}+SUMIFS($D$48:$D$70,$B$48:$B$70,${from},$C$48:$C$70,${to}))+SUMIFS(${sheet}$E$2:$E$10000,${sheet}$C$2:$C$10000,${from},${sheet}$D$2:$D$10000,${to},${sheet}$G$2:$G$10000,"정상")`;for(const n of linked){const r=raw.sourceValues[n-1];if((r[1]==='합성회사A')!==forward)continue;const col=r[4]?'E':'H';f+=`-IF(AND($${col}$${n}<>"",COUNTIF(${sheet}$A$2:$A$10000,$${col}$${n})=1),$D$${n},0)`;}return f;};
 raw.sourceFormulas=raw.sourceValues.map(r=>[...r]);raw.sourceFormulas[8][2]=formula(true);raw.sourceFormulas[8][3]=formula(false);return raw;
}
