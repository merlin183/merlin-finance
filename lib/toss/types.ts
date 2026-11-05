/** Public DTOs contain no API keys or customer payment details. */
export type TossMerchant={merchantId:string;businessId:string;accountId:string;label:string};
export type TossSettlement={merchant_id:string;transaction_key:string;payment_key:string;business_id:string;account_id:string;paid_out_date:string;sold_date:string;amount:number;pay_out_amount:number;fee_amount:number;synced_at:string};
export type TossSettlementResponse={configured:boolean;merchants:TossMerchant[];settlements:TossSettlement[];lastSyncedAt:string|null;range:{from:string;to:string}|null;sync?:{saved:number;from:string;to:string}};
export type TossSettlementGroup={id:string;businessId:string;accountId:string;date:string;merchantIds:string[];amount:number;receivedAmount:number;pendingAmount:number;status:'pending'|'received'|'confirmation-needed'|'overdue';matchedTransactionIds:string[];reason:string|null};
