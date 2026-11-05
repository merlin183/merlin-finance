// Safe display DTOs shared by the upload screen and server read endpoints.
export type ClobeScrapingStatus={status:string;lastCollectedAt:string|null;error:string|null};
export type ClobeBankAccount={id:number;name:string;bankName:string|null;maskedNumber:string;currency:string;balance:number|null;krwBalance:number|null;isHidden:boolean};
export type ClobeCompany={id:string;name:string;role:string;accounts:ClobeBankAccount[];scraping:ClobeScrapingStatus;error:string|null};
export type ClobeAccountsResponse={fetchedAt:string;companies:ClobeCompany[]};
export type ClobeTransactionRow={id:string;date:string;time:string;description:string;party:string|null;category:string|null;memo:string|null;direction:'in'|'out';amount:number;balance:number|null;currency:string};
export type ClobeTransactionsRequest={companyId:string;bankAccountId:number;startDate:string;endDate:string;cursor?:string;size?:number};
export type ClobeTransactionsResponse={fetchedAt:string;companyId:string;bankAccountId:number;startDate:string;endDate:string;rows:ClobeTransactionRow[];hasNext:boolean;nextCursor:string|null;totalElements:number|null;inAmountSum:number|null;outAmountSum:number|null;scraping:ClobeScrapingStatus};
