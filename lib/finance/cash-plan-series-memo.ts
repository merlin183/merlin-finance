const marker=/^\[cash-plan-fixed:v1:([^\]\r\n]+)\]$/;
const validGroup=(value:string)=>value.trim().length>0&&value.trim().length<=100&&!/[\u0000-\u001f\u007f]/.test(value);

/** Explicit user-selected classification for one stored manual month. It is
 * provenance, not a payment, authorization claim or inferred account category. */
export function readFixedCostMemo(memo:string):{marker:string;groupLabel:string;userMemo:string}|null{
 const lines=memo.split('\n'),matches=lines.map(line=>line.trim()).filter(line=>marker.test(line));
 if(matches.length!==1)return null;
 const stored=matches[0],token=marker.exec(stored)![1];
 let groupLabel:string;
 try{groupLabel=decodeURIComponent(token);}catch{return null;}
 if(!validGroup(groupLabel)||groupLabel!==groupLabel.trim())return null;
 return {marker:stored,groupLabel,userMemo:lines.filter(line=>line.trim()!==stored).join('\n').trim()};
}

export function fixedCostMemo(groupLabel:string,userMemo:string):string{
 if(!validGroup(groupLabel))throw Error('고정비 분류는 100자 이내로 입력해주세요.');
 if(userMemo.split('\n').some(line=>marker.test(line.trim())))throw Error('고정비 메모의 내부 표식은 직접 입력하지 마세요.');
 if(/^\[clobe-card-bill:[^\]\r\n]+\]$/m.test(userMemo))throw Error('카드 연동 내부 표식은 고정비 메모에 입력할 수 없습니다.');
 const stored=`[cash-plan-fixed:v1:${encodeURIComponent(groupLabel.trim())}]`;
 return [stored,userMemo].filter(Boolean).join('\n');
}

/** A generic memo editor retains the original classification when the user
 * changes or clears visible text. Pasted duplicate markers cannot replace it. */
export function stripFixedCostMarkerLines(memo:string):string{
 return memo.split('\n').filter(line=>!marker.test(line.trim())).join('\n').trim();
}
