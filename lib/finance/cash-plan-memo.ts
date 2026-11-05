import {readFixedCostMemo,stripFixedCostMarkerLines} from './cash-plan-series-memo';

const clobeCardLabel='클로브 카드 청구 반영';
const cardMarker=/^\[clobe-card-bill:[^\]\r\n]+\]$/;
const replacementPrefix='대체 계획 키: ';

/** Stored provenance is kept separate from the administrator's editable note.
 * This module has no finance/model imports so every display layer can use it. */
function parts(memo:string):{internal:string[];user:string;provider:boolean;fixed:boolean}{
 const lines=memo.split('\n');
 const provider=lines.some(line=>cardMarker.test(line.trim()));
 const fixed=readFixedCostMemo(memo);
 if(!provider&&!fixed)return {internal:[],user:memo,provider:false,fixed:false};
 const internal:string[]=[],user:string[]=[];
 for(const line of lines){
  if(cardMarker.test(line.trim())||(provider&&line.startsWith(replacementPrefix))||(fixed&&line.trim()===fixed.marker))internal.push(line);
  else user.push(line);
 }
 return {internal,user:user.join('\n').trim(),provider,fixed:!!fixed};
}

/** Financial reports never show bill UUIDs or original plan-key JSON. */
export function cashPlanMemoDisplay(memo:string):string{
 const value=parts(memo);
 return value.provider?[clobeCardLabel,value.user].filter(Boolean).join(' · '):value.fixed?value.user:memo;
}

/** The form edits only user-authored text, not import identity metadata. */
export function cashPlanUserMemo(memo:string):string{return parts(memo).user;}

/** Save and live-preview retain original provenance even when the visible note
 * is cleared. Version conflict checks remain the responsibility of the RPC. */
export function mergeCashPlanUserMemo(originalMemo:string,userMemo:string):string{
 const value=parts(originalMemo);
 if(value.fixed&&!value.provider&&userMemo.split('\n').some(line=>cardMarker.test(line.trim())))throw Error('카드 연동 내부 표식은 고정비 메모에 입력할 수 없습니다.');
 const visible=value.fixed?stripFixedCostMarkerLines(userMemo):userMemo;
 return value.provider||value.fixed?[...value.internal,...(visible?[visible]:[])].join('\n'):userMemo;
}
