import {useMemo,useState} from 'react';
import {Tabs,TabsContent,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {Panel} from './common';
import {FundingTimeline} from './funding-timeline';
import {buildAccountFunding,type AccountFundingItem,type AccountFundingIncome} from '@/lib/finance/account-funding';
import {buildCashCalendarModel} from '@/lib/finance/cash-calendar';
import type {CashPlanBusiness} from '@/lib/finance/cash-plan';
import type {CashEstimateBusiness} from '@/lib/finance/cash-estimates';
import type {CashPlanEditorItem} from '@/lib/finance/editable-cash-plan';
import type {DateRange} from '@/lib/finance/date-range';
import type {LatestCashBusiness} from '@/lib/finance/latest-cash-balances';
import type {Dataset} from '@/lib/finance/types';
import type {TossCalendarIncome} from '@/lib/finance/toss-funding';
import './account-funding.css';

type FundingProps={plans:CashPlanBusiness[];estimates:Map<string,CashEstimateBusiness>;latestBalances:Map<string,LatestCashBusiness>;basis:'registered'|'estimated';range:DateRange;asOf:string;focusDate?:string;incoming?:AccountFundingIncome[];calendarIncome?:TossCalendarIncome[];data?:Dataset;planItems?:CashPlanEditorItem[]};
const digits=(value:number)=>value.toLocaleString('ko-KR');
const money=(value:number|null)=>value===null?'확인 필요':digits(value);
const valueClass=(value:number|null)=>value===null?'account-funding-unknown':value<0?'negative':'';

function FundingItems({title,items,total,estimated}:{title:string;items:AccountFundingItem[];total:number|null;estimated:boolean}){
 return <section className="account-funding-detail" aria-label={title}>
  <header><div><h3>{title}</h3><p>{items.length}건 · {estimated?'추정 예산':'등록 일정'} · 단위 원</p></div><strong>합계 {money(total)}{total===null?'':'원'}</strong></header>
  {items.length>0?<div className="account-funding-item-scroll" role="region" tabIndex={0} aria-label={`${title} 목록`}><table className="account-funding-items">
   <caption className="sr-only">{title}. 날짜와 품목, 금액을 표시합니다.</caption>
   <thead><tr><th scope="col">날짜</th><th scope="col">거래처·품목</th><th scope="col">금액</th></tr></thead>
   <tbody>{items.map(item=><tr key={item.key}><td>{item.date?<><time dateTime={item.date}>{item.date}</time>{estimated&&<small>예상일</small>}</>:<>날짜 미정{item.from&&item.to&&<small>{item.from} ~ {item.to}</small>}<small>기간 예산</small></>}</td><td>{item.title}<small>{item.note}</small></td><td>{digits(item.amount)}</td></tr>)}</tbody>
  </table></div>:<p className="account-funding-no-items">{total===null?'출금 계좌 또는 지난 일정의 지급 여부를 확인해야 이 통장의 지출을 계산할 수 있습니다.':estimated?'이 통장에서 추정할 남은 반복 지출이 없습니다. 실제 지출이 없다는 뜻은 아닙니다.':'이 통장에 지정된 남은 예정 지출이 없습니다.'}</p>}
 </section>;
}

export function AccountFundingPanel({plans,estimates,latestBalances,basis,range,asOf,focusDate='',incoming,calendarIncome,data,planItems}:FundingProps){
 const businesses=useMemo(()=>buildAccountFunding(plans,estimates,basis,incoming),[plans,estimates,basis,incoming]);
 const [selectedBusiness,setSelectedBusiness]=useState('all');
 const [selectedAccount,setSelectedAccount]=useState('all');
 const [selectedView,setSelectedView]=useState('dates');
 const businessValue=selectedBusiness==='all'||businesses.some(item=>item.business.id===selectedBusiness)?selectedBusiness:'all';
 const shownBusinesses=useMemo(()=>businessValue==='all'?businesses:businesses.filter(item=>item.business.id===businessValue),[businesses,businessValue]);
 const accounts=shownBusinesses.flatMap(business=>business.accounts.map(account=>({business,...account})));
 const accountValue=selectedAccount==='all'||accounts.some(item=>item.account.id===selectedAccount)?selectedAccount:'all';
 const shownCalendarIncome=useMemo(()=>{
  if(calendarIncome===undefined)return undefined;
  const businessIds=new Set(shownBusinesses.map(item=>item.business.id));
  return calendarIncome.filter(item=>businessIds.has(item.businessId)&&(accountValue==='all'||item.accountId===accountValue));
 },[calendarIncome,shownBusinesses,accountValue]);
 const cashCalendar=useMemo(()=>data&&planItems?buildCashCalendarModel({data,items:planItems,funding:shownBusinesses,range,asOf,basis,businessId:businessValue,accountId:accountValue}):undefined,[data,planItems,shownBusinesses,range,asOf,basis,businessValue,accountValue]);
 const shownAccounts=accountValue==='all'?accounts:accounts.filter(item=>item.account.id===accountValue);
 const detailAccount=accountValue==='all'?undefined:shownAccounts[0];
 const required=accountValue==='all'?
  (shownBusinesses.length>0&&shownBusinesses.every(item=>item.requiredTopUp!==null)?shownBusinesses.reduce((sum,item)=>sum+item.requiredTopUp!,0):null):
  (detailAccount?.requiredTopUp??null);
 const knownRequired=accountValue==='all'?shownBusinesses.reduce((sum,item)=>sum+item.knownRequiredTopUp,0):(detailAccount?.requiredTopUp??0);
 const knownCount=shownAccounts.filter(item=>item.requiredTopUp!==null).length;
 const unknownCount=shownAccounts.length-knownCount;
 const missingAccountBusinesses=accountValue==='all'?shownBusinesses.filter(item=>item.accounts.length===0).length:0;
 const shortageCount=shownAccounts.filter(item=>item.requiredTopUp!==null&&item.requiredTopUp>0).length;
 const unassignedBusinesses=shownBusinesses.filter(item=>item.unassignedItems.length>0);
 const unassignedTotal=unassignedBusinesses.reduce((sum,item)=>sum+item.unassignedExpenses,0);
 const unconfirmedBusinesses=shownBusinesses.filter(item=>(item.unconfirmedItems?.length??0)>0);
 const unconfirmedItems=unconfirmedBusinesses.flatMap(item=>item.unconfirmedItems??[]);
 const estimated=basis==='estimated';
 return <Panel title="사업자·계좌별 지출 계획" subtitle={`${range.from} ~ ${range.to} · ${estimated?'반복 출금 추정 기준':'등록된 예정 지출 기준'}`} className="account-funding-panel">
  <Tabs value={businessValue} onValueChange={value=>{setSelectedBusiness(value);setSelectedAccount('all');}} className="account-funding-tabs">
   <TabsList className="account-funding-tabbar" aria-label="지출 계획 사업자">
    <TabsTrigger value="all">전체 사업자</TabsTrigger>
    {businesses.map(({business})=><TabsTrigger key={business.id} value={business.id}><i className="account-funding-tab-dot" style={{background:business.color}} aria-hidden="true"/>{business.name}</TabsTrigger>)}
   </TabsList>
   <TabsContent value={businessValue}>
    <Tabs value={accountValue} onValueChange={setSelectedAccount} className="account-funding-tabs">
     <TabsList className="account-funding-tabbar account-funding-account-tabs" aria-label="지출 계획 계좌">
      <TabsTrigger value="all">전체 계좌</TabsTrigger>
      {accounts.map(item=><TabsTrigger key={item.account.id} value={item.account.id}>{[businessValue==='all'?item.business.business.name:'',item.account.name,item.account.bank,item.account.masked_number].filter(Boolean).join(' · ')}</TabsTrigger>)}
     </TabsList>
     <TabsContent value={accountValue}>
      {shownAccounts.length>0&&<section className="account-funding-current" aria-label="선택 계좌의 현재 기록 잔액">
       <header><h3>현재 기록 잔액</h3><p>통장별 수집·기록 기준</p></header>
       <div className="account-funding-current-grid">{shownAccounts.map(item=>{
        const current=latestBalances.get(item.business.business.id)?.accounts.find(account=>account.account.id===item.account.id)?.snapshot;
        return <div className="account-funding-current-account" key={item.account.id}>
         <span>{item.business.business.name} · {item.account.name}</span><small>{[item.account.bank,item.account.masked_number].filter(Boolean).join(' · ')}</small>
         <strong className={valueClass(current?.balance??null)}>{money(current?.balance??null)}{current?.balance==null?'':'원'}</strong>
         <small>{current?.date?`${current.date} ${current.source==='clobe'?'Clobe 수집 잔액':'기록'}`:'잔액 근거일 확인 필요'}{current?.source==='conflict'?' · 원본 잔액 충돌':''}</small>
         {current?.source==='clobe'&&current.message&&<details className="account-funding-balance-source"><summary>잔액 출처</summary><p>{current.message}</p></details>}
        </div>;
       })}</div>
      </section>}
      {unconfirmedItems.length>0&&<details className="account-funding-unassigned"><summary>지난 일정 확인 필요 <strong>{unconfirmedItems.length}건 · {digits(unconfirmedItems.reduce((sum,item)=>sum+item.amount,0))}원</strong></summary><p>남은 지출에서 제외한 일정입니다. 지급 확인 전 전체 필요금액은 미확정입니다.</p>{unconfirmedBusinesses.map(item=><FundingItems key={item.business.id} title={`${item.business.name} · 지급 여부 미확인 일정`} items={item.unconfirmedItems??[]} total={(item.unconfirmedItems??[]).reduce((sum,row)=>sum+row.amount,0)} estimated={false}/>)}</details>}
      <Tabs value={selectedView} onValueChange={setSelectedView} className="account-funding-tabs">
       <TabsList className="account-funding-tabbar" aria-label="지출 계획 표시 방식"><TabsTrigger value="dates">날짜별 지출 계획</TabsTrigger><TabsTrigger value="period">기간 전체</TabsTrigger></TabsList>
       <TabsContent value="dates"><FundingTimeline businesses={shownBusinesses} accountId={accountValue} range={range} asOf={asOf} focusDate={focusDate} cashCalendar={cashCalendar} calendarIncome={shownCalendarIncome}/></TabsContent>
       <TabsContent value="period">
      <div className="account-funding-summary">
       <div><span>{accountValue==='all'?'부족 계좌에 추가로 넣을 금액 합계':'이 계좌에 추가로 넣을 금액'}</span><strong className={required===null?'account-funding-unknown':required>0?'negative':''}>{money(required)}{required===null?'':'원'}</strong>{required===null&&<small>계산 가능한 {knownCount}개 계좌 소계 {digits(knownRequired)}원</small>}</div>
       <p className="account-funding-summary-meta">{shownAccounts.length}개 계좌 · 부족 {shortageCount}개{unknownCount>0&&<> · 확인 필요 {unknownCount}개</>}{missingAccountBusinesses>0&&<> · 계좌 미등록 사업자 {missingAccountBusinesses}개</>}<br/>다른 통장 여유금 상계 제외</p>
      </div>
      {shownAccounts.length>0?<div className="account-funding-table-scroll" role="region" aria-label="계좌별 잔액과 추가 필요금액" tabIndex={0}><table className="account-funding-table">
       <caption className="sr-only">계좌별 {estimated?'추정':'등록'} 지출, 지출 후 잔액과 추가 필요금액. 금액 단위는 원입니다.</caption>
       <thead><tr><th scope="col">사업자 / 계좌</th><th scope="col">{estimated?'추정 지출':'등록 지출'}</th><th scope="col">지출 후 잔액</th><th scope="col">추가 필요금액<small>단위: 원</small></th></tr></thead>
       <tbody>{shownAccounts.map(item=><tr key={item.account.id}>
        <th scope="row"><button type="button" className="account-funding-account-link" onClick={()=>setSelectedAccount(item.account.id)} aria-label={`${item.business.business.name} ${item.account.name} ${item.account.masked_number} 지출 내역 보기`}><i className="account-funding-tab-dot" style={{background:item.business.business.color}} aria-hidden="true"/>{item.business.business.name} · {item.account.name}</button><small className="account-funding-account-meta">{[item.account.bank,item.account.masked_number].filter(Boolean).join(' · ')||'은행·계좌번호 정보 없음'}</small></th>
        <td className={item.expenses===null?'account-funding-unknown':''}>{money(item.expenses)}{item.expenses===null&&<small>계좌·지급 여부 확인 필요</small>}{estimated&&item.undatedExpenses>0&&<small>날짜 미정 예산 {digits(item.undatedExpenses)} 포함</small>}</td>
        <td className={valueClass(item.afterExpenses)}>{money(item.afterExpenses)}{(item.income??0)>0&&<small className="positive">토스 예정 +{digits(item.income!)}<br/>정산 반영 {money(item.afterIncome??null)}</small>}</td>
        <td className={`account-funding-required ${item.requiredTopUp===null?'account-funding-unknown':item.requiredTopUp>0?'negative':''}`}>{money(item.requiredTopUp)}{item.requiredTopUp===0&&<small>추가 필요 없음</small>}</td>
       </tr>)}</tbody>
      </table></div>:<p className="account-funding-no-items">등록된 계좌가 없어 추가 입금 계획을 계산할 수 없습니다.</p>}
      <div className="account-funding-explanation"><details><summary>필요금액 계산 기준</summary><p>{incoming?.length?'토스 입금 예정액은 지정 계좌의 지급일부터 반영합니다. 입금 전 부족분은 유지하고 날짜 미정 지출은 먼저 준비하는 기준입니다. 그 밖의 예정 수입·다른 통장 잔액·유보액은 제외합니다.':'남은 지출에서 현재 기록 잔액을 뺀 부족분입니다. 예정 수입·다른 통장 잔액·유보액은 제외합니다.'}</p><p>{estimated?'반영 실적을 뺀 반복 출금 추정 예산으로, 확정 청구액이나 지급일이 아닙니다. 날짜 미정 예산도 기간 합계에 포함합니다.':'내일부터의 등록 일정 기준입니다. 지난 일정의 지급 여부와 출금 계좌를 확인해야 합니다.'} 잔액·계좌·지급 여부가 미확인이면 전체 필요금액은 미확정입니다.</p></details></div>
      {unassignedBusinesses.length>0&&<details className="account-funding-unassigned"><summary>계좌 미지정 {estimated?'추정':'예정'} 지출 <strong>{digits(unassignedTotal)}원 · {unassignedBusinesses.reduce((sum,item)=>sum+item.unassignedItems.length,0)}건</strong></summary><p>아래 지출은 출금 계좌를 확인할 수 없어 특정 통장에 배분하지 않았습니다.</p>{unassignedBusinesses.map(item=><FundingItems key={item.business.id} title={`${item.business.name} · 계좌 미지정 지출`} items={item.unassignedItems} total={item.unassignedExpenses} estimated={estimated}/>)}</details>}
      {detailAccount&&<FundingItems title={`${detailAccount.business.business.name} · ${detailAccount.account.name} 지출 내역`} items={detailAccount.items} total={detailAccount.expenses} estimated={estimated}/>}
       </TabsContent>
      </Tabs>
     </TabsContent>
    </Tabs>
   </TabsContent>
  </Tabs>
 </Panel>;
}
