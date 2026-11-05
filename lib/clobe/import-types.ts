import type {SourceDetails} from '../finance/types';
import type {ClobeAccountMapping,ClobeImportConflict,ClobeImportScope,ClobeImportSummary} from '../finance/clobe-import';

export type ClobeImportPreviewRow={
 key:string;kind:'insert'|'reference';account_id:string;company_id:string;
 external_account_id:string;external_transaction_id:string;txn_date:string;txn_time:string|null;
 amount:number;direction:'in'|'out';balance:number|null;description:string;
 source_details:SourceDetails|null;category_id:string|null;is_internal:boolean;
 existing_transaction_id:string|null;
};
export type ClobeImportPreview={previewId:string;expiresAt:string;scope:ClobeImportScope;
 rows:ClobeImportPreviewRow[];summary:ClobeImportSummary;conflicts:ClobeImportConflict[]};
export type ClobeImportChoice={key:string;category_id:string|null};
export type ClobeImportInput={action:'preview';start_date:string;end_date:string;mappings:ClobeAccountMapping[]}
 |{action:'apply';previewId:string;choices:ClobeImportChoice[]}
 |{action:'sync_prepare';month:string}|{action:'sync_apply';previewId:string};
export type ClobeImportResult=ClobeImportSummary&{run_id:string;replayed?:boolean};
export type ClobeImportSettings={mappings:ClobeAccountMapping[]};
export type ClobeSyncAccountScope={account_id:string;from:string;to:string;collected_at:string};
export type ClobeSyncSkip={account_id:string;code:'collection'|'access'|'currency'|'pagination'|'timeout'|'source';reason:string};
export type ClobeSyncSource={rows:import('../finance/clobe-import').ClobeImportRow[];accounts:ClobeSyncAccountScope[];skipped?:ClobeSyncSkip[]};
export type ClobeSyncPrepared={previewId:string;expiresAt:string;month:string;scope:{start_date:string;end_date:string;account_count:number;configured_account_count?:number;business_count:number;accounts:ClobeSyncAccountScope[]};summary:ClobeImportSummary;unclassified:number;conflicts:ClobeImportConflict[];conflicts_truncated?:boolean;skipped?:ClobeSyncSkip[]};
export type ClobeSyncApplied=ClobeImportResult&{unclassified:number|null};
