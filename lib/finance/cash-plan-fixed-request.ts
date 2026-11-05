import {readFixedCostSaveResult,type FixedCostForwardRequest,type FixedCostSaveResult} from './cash-plan-series-forward';

export class FixedCostRequestError extends Error{
 constructor(message:string,readonly status:number){super(message);}
}

/** One atomic write response updates both the recurrence and monthly override.
 * No financial drafts or authentication material are stored in the browser. */
export async function requestFixedCostSave(change:FixedCostForwardRequest,fetcher:typeof fetch=fetch):Promise<FixedCostSaveResult>{
 const response=await fetcher('/api/cash-plan/fixed-costs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(change),cache:'no-store'});
 let value:unknown;
 try{value=await response.json();}catch{throw new FixedCostRequestError('저장 응답을 확인하지 못했습니다. 최신 계획을 다시 불러와 저장 여부를 확인해주세요.',response.status);}
 if(!response.ok){
  const message=typeof value==='object'&&value!==null&&'error' in value&&typeof value.error==='string'?value.error:'고정비 반복 계획을 저장하지 못했습니다.';
  throw new FixedCostRequestError(response.status===401?'로그인이 만료되었습니다. 다시 로그인해주세요.':response.status===403?'초대된 관리자만 공동 계획을 수정할 수 있습니다.':response.status===409?'다른 관리자가 이 계획을 변경했습니다. 입력은 유지했습니다. 최신 계획을 확인한 뒤 다시 편집해주세요.':message,response.status);
 }
 try{return readFixedCostSaveResult(value);}catch{throw new FixedCostRequestError('저장 결과 형식을 확인하지 못했습니다. 최신 계획을 다시 불러와 저장 여부를 확인해주세요.',response.status);}
}
