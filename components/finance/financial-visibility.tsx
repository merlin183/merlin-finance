"use client";
import {createContext,useCallback,useContext,useEffect,useMemo,useState,useSyncExternalStore,type ComponentProps,type ReactNode} from 'react';
import {Eye,EyeOff} from 'lucide-react';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {FINANCIAL_MASK,FINANCIAL_VISIBILITY_KEY,createFinancialVisibilityStore,financialDisplayValue,isFinancialStatus,redactFinancialText} from '@/lib/finance/financial-visibility';

type FinancialVisibility={
 amountsVisible:boolean;
 preferenceReady:boolean;
 toggleAmountsVisible:()=>void;
 privateValue:(value:string|number)=>string;
 privateText:(text:string)=>string;
};
// Standalone renderers retain their normal behavior. The workspace always
// supplies the provider below, whose server and hydration snapshots are masked.
export const FinancialVisibilityContext=createContext<FinancialVisibility>({amountsVisible:true,preferenceReady:true,toggleAmountsVisible:()=>{},privateValue:String,privateText:text=>text});

export function FinancialVisibilityProvider({children}:{children:ReactNode}){
 const [store]=useState(()=>createFinancialVisibilityStore(()=>window.localStorage));
 const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getServerSnapshot);
 useEffect(()=>{
  store.reload();
  const onStorage=(event:StorageEvent)=>{if(event.key===FINANCIAL_VISIBILITY_KEY||event.key===null)store.reload();};
  window.addEventListener('storage',onStorage);
  return()=>window.removeEventListener('storage',onStorage);
 },[store]);
 const privateValue=useCallback((value:string|number)=>financialDisplayValue(value,snapshot.amountsVisible),[snapshot.amountsVisible]);
 const privateText=useCallback((text:string)=>snapshot.amountsVisible?text:redactFinancialText(text),[snapshot.amountsVisible]);
 const value=useMemo(()=>({...snapshot,toggleAmountsVisible:store.toggle,privateValue,privateText}),[snapshot,store,privateValue,privateText]);
 return <FinancialVisibilityContext.Provider value={value}>{children}</FinancialVisibilityContext.Provider>;
}

export function useFinancialVisibility(){return useContext(FinancialVisibilityContext);}

export function FinancialVisibilityToggle(){
 const {amountsVisible,preferenceReady,toggleAmountsVisible}=useFinancialVisibility();
 const Icon=amountsVisible?Eye:EyeOff;
 return <button type="button" role="switch" aria-checked={amountsVisible} aria-label="금액 표시" aria-busy={!preferenceReady} disabled={!preferenceReady} className="financial-visibility-toggle" data-visible={amountsVisible} onClick={toggleAmountsVisible} title={amountsVisible?'금액 숨기기':'금액 보기'}><Icon size={16} aria-hidden="true"/><span className="financial-visibility-label">금액 표시</span><span className="financial-visibility-switch" aria-hidden="true"><span className="financial-visibility-state">{amountsVisible?'ON':'OFF'}</span><span className="financial-visibility-thumb"/></span></button>;
}

type FinancialValueProps=Omit<ComponentProps<'span'>,'children'|'dangerouslySetInnerHTML'> & {value:ReactNode};
export function FinancialValue({value,className,...props}:FinancialValueProps){
 const {amountsVisible}=useFinancialVisibility();
 if(amountsVisible)return className===undefined&&Object.keys(props).length===0?<>{value}</>:<span {...props} className={className}>{value}</span>;
 if(isFinancialStatus(value))return className===undefined&&Object.keys(props).length===0?<>{value}</>:<span {...props} className={className} title={undefined} aria-label={value} aria-labelledby={undefined} aria-describedby={undefined} aria-valuenow={undefined} aria-valuetext={undefined} aria-valuemin={undefined} aria-valuemax={undefined}>{value}</span>;
 return <span {...props} className={['financial-value-masked',className].filter(Boolean).join(' ')} title={undefined} aria-label="금액 숨김" aria-labelledby={undefined} aria-describedby={undefined} aria-valuenow={undefined} aria-valuetext={undefined} aria-valuemin={undefined} aria-valuemax={undefined} data-financial-masked="true">{FINANCIAL_MASK}</span>;
}

export function FinancialText({value,...props}:Omit<FinancialValueProps,'value'> & {value:string}){
 const {amountsVisible,privateText}=useFinancialVisibility();
 const text=privateText(value);
 if(Object.keys(props).length===0&&(amountsVisible||text===value))return <>{text}</>;
 return <span {...props} title={amountsVisible?props.title:props.title?privateText(props.title):undefined} aria-label={props['aria-label']?privateText(props['aria-label']):undefined}>{text}</span>;
}

// Keep the caller's controlled form state untouched. No original amount or
// numeric constraint is emitted into the hidden input's text or attributes.
export function FinancialInput(props:ComponentProps<typeof Input>){
 const {amountsVisible}=useFinancialVisibility();
 if(amountsVisible)return <Input {...props}/>;
 return <Input {...props} type="text" value={FINANCIAL_MASK} defaultValue={undefined} name={undefined} min={undefined} max={undefined} step={undefined} placeholder={undefined} title="금액 표시를 켜면 수정할 수 있습니다" aria-label="금액 숨김 · 금액 표시를 켜면 수정할 수 있습니다" aria-labelledby={undefined} aria-describedby={undefined} aria-valuenow={undefined} aria-valuetext={undefined} aria-valuemin={undefined} aria-valuemax={undefined} readOnly onChange={undefined} onInput={undefined} className={['financial-input-masked',props.className].filter(Boolean).join(' ')} data-financial-masked="true"/>;
}

export function FinancialTextarea(props:ComponentProps<typeof Textarea>){
 const {amountsVisible}=useFinancialVisibility();
 if(amountsVisible)return <Textarea {...props}/>;
 return <Textarea {...props} value={FINANCIAL_MASK} defaultValue={undefined} name={undefined} placeholder={undefined} title="금액 표시를 켜면 수정할 수 있습니다" aria-label="금융 메모 숨김 · 금액 표시를 켜면 수정할 수 있습니다" aria-labelledby={undefined} aria-describedby={undefined} readOnly onChange={undefined} onInput={undefined} className={['financial-input-masked',props.className].filter(Boolean).join(' ')} data-financial-masked="true"/>;
}

export function FinancialChart({children,className,...props}:ComponentProps<'div'>){
 const {amountsVisible}=useFinancialVisibility();
 if(amountsVisible)return <div {...props} className={['financial-chart-visible',className].filter(Boolean).join(' ')}>{children}</div>;
 return <div {...props} className={['financial-chart-masked',className].filter(Boolean).join(' ')} title={undefined} aria-label="차트 금액 숨김" aria-labelledby={undefined} aria-describedby={undefined}><EyeOff size={19} aria-hidden="true"/><span>금액 숨김 중</span></div>;
}
