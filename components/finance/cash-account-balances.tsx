import {latestAccountBalanceRows,type LatestCashBusiness} from '@/lib/finance/latest-cash-balances';

export function CashAccountBalances({business}:{business:LatestCashBusiness|undefined}){
 const rows=latestAccountBalanceRows(business);
 if(!rows.length)return null;
 return <ul className="cash-account-balances" aria-label={`${business?.business.name??''} 계좌별 현재 기록 잔액, 단위 원`}>
  {rows.map(row=><li key={row.id} title={`${row.label} · ${row.basis}`}>
   <span>{row.label}</span><b className={row.balance===null?'cash-plan-unknown':row.balance<0?'negative':''}>{row.balance===null?'확인 필요':row.balance.toLocaleString('ko-KR')}</b>
  </li>)}
 </ul>;
}
