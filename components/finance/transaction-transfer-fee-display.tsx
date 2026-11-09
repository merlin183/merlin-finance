
import {FinancialValue} from './financial-visibility';
import {transferFeeDetails} from '@/lib/finance/transaction-accounting';
import type {Dataset,Transaction} from '@/lib/finance/types';
import {won} from '@/lib/finance/format';

/** A classification breakdown of one bank row, never an additional bank entry. */
export function TransferFeeBreakdown({data,transaction}:{data:Pick<Dataset,'categories'>;transaction:Transaction}){
 const details=transferFeeDetails(data,transaction);
 if(!details)return null;
 return <small className="transfer-fee-breakdown" aria-label="출금액 분류 내역"><span>{details.transferCategory.name} <FinancialValue value={won(details.principal)}/></span><span>{details.feeCategory.name} <FinancialValue value={won(details.fee)}/></span></small>;
}
