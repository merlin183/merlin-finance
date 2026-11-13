// Display preferences never alter stored financial values or calculation inputs.
export const FINANCIAL_MASK='••••••';
export const FINANCIAL_VISIBILITY_KEY='merlin.financial-visibility.v1';

export type FinancialVisibilitySnapshot={amountsVisible:boolean;preferenceReady:boolean};
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>;
const initialSnapshot:FinancialVisibilitySnapshot=Object.freeze({amountsVisible:false,preferenceReady:false});
const financialStatusLabels=new Set(['확인 필요','잔액 확인 필요','등록 전','미설정','미지정','제외','없음','대상 없음','미연결','—','-','']);

export function isFinancialStatus(value:unknown):value is string{
 return typeof value==='string'&&financialStatusLabels.has(value);
}

export function financialDisplayValue(value:string|number,amountsVisible:boolean){
 return amountsVisible||isFinancialStatus(value)?String(value):FINANCIAL_MASK;
}

// Match financial tokens only; dates, transaction counts and item names remain
// readable. Explicit account-number fields use FinancialValue instead.
const financialTokens=/[₩￦$€¥]\s*[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:천만원?|백만원?|조원?|억원?|만원?|천원?|원|KRW|USD|달러|유로|엔|%)|[+−-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?/gi;
const accountTokens=/\b\d{10,18}\b|\b\d{1,6}(?:[- ]\d{1,6}){1,5}\b/g;
export function redactFinancialText(text:string){
 const preserved=new Map<string,string>();
 // Protect dates, years and explicit counts before account matching so a date
 // and its following count cannot be consumed as one separated bank number.
 // Valid date boundaries also exclude date-like fragments inside accounts.
 // Placeholders contain no ASCII digits that could be redacted.
 const protectedText=text.replace(/(?<![\d-])\d{4}[-/.](?:0?[1-9]|1[0-2])(?:[-/.](?:0?[1-9]|[12]\d|3[01]))?(?![\d-])(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:년|개월|건|개|명|회차|회|일|월)/g,token=>{
  const id=preserved.size.toString(36).replace(/\d/g,digit=>String.fromCharCode(0xe100+Number(digit)));
  const placeholder=`\uE000${id}\uE001`;preserved.set(placeholder,token);return placeholder;
 });
 return protectedText.replace(accountTokens,token=>{
  const digits=token.replace(/\D/g,'').length;
  return digits>=10&&digits<=18?FINANCIAL_MASK:token;
 }).replace(/((?:계좌|통장)(?:번호)?[\s:：]*)(\d[\d -]{5,23}\d)/g,(_match,prefix:string)=>prefix+FINANCIAL_MASK)
  .replace(financialTokens,FINANCIAL_MASK)
  .replace(/(?<![\dA-Za-z])[+−-]?\d{4,}(?:\.\d+)?(?![\dA-Za-z])/g,FINANCIAL_MASK)
  .replace(/\uE000[^\uE001]*\uE001/g,token=>preserved.get(token)??token);
}

// Each provider owns its snapshot. Browser storage is read only after hydration,
// so a stored OFF preference never passes through an initially visible render.
export function createFinancialVisibilityStore(storage:()=>PreferenceStorage){
 let snapshot=initialSnapshot;
 const listeners=new Set<()=>void>();
 function publish(amountsVisible:boolean){
  if(snapshot.preferenceReady&&snapshot.amountsVisible===amountsVisible)return;
  snapshot={amountsVisible,preferenceReady:true};
  for(const listener of listeners)listener();
 }
 function reload(){
  try{
   const saved=storage().getItem(FINANCIAL_VISIBILITY_KEY);
   publish(saved===null||saved==='on');
  }catch{publish(false);}
 }
 return {
  getSnapshot:()=>snapshot,
  getServerSnapshot:()=>initialSnapshot,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  reload,
  toggle(){
   if(!snapshot.preferenceReady)return;
   const next=!snapshot.amountsVisible;
   try{storage().setItem(FINANCIAL_VISIBILITY_KEY,next?'on':'off');}catch{/* Keep this session usable when browser storage is unavailable. */}
   publish(next);
  },
 };
}
