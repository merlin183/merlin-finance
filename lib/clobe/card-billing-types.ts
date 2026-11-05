import type {ClobeScrapingStatus} from './types';

// Only payment dates and bill sums leave the server. Card users, merchants,
// purchase dates, individual items and full card numbers are not display data.
export type ClobeCardBillKind='REGULAR'|'PRE_PAYMENT'|'ADJUSTMENT';
export type ClobeCardBill={
 key:string;
 maskedCard:string;
 date:string;
 amount:number|null;
 kind:ClobeCardBillKind;
 itemCount:number;
 replaceable:boolean;
 reason:string|null;
};
export type ClobeCardBillsCompany={
 id:string;
 name:string;
 bills:ClobeCardBill[];
 error:string|null;
 scraping:ClobeScrapingStatus;
 warnings:string[];
};
export type ClobeCardBillsRequest={startDate:string;endDate:string};
export type ClobeCardBillsResponse=ClobeCardBillsRequest&{
 fetchedAt:string;
 companies:ClobeCardBillsCompany[];
};
