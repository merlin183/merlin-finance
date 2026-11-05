/** A collected bank balance is independent of the imported transaction ledger.
 * collected_at retains the provider's original timestamp spelling. A source
 * without a timezone is not presented as a timezone-converted bank timestamp. */
export type AccountBalanceSnapshot={
 account_id:string;business_id:string;balance:number;balance_date:string;
 collected_at:string;synced_at:string;source:'clobe';currency:'KRW';
};
