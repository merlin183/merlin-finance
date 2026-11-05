import type {Rule,Transaction} from './types';

export type ClassificationTransactionPatch=Pick<Transaction,'id'|'category_id'|'is_internal'|'manually_classified'>;
export type ClassificationResult={
 updated:number;
 learned:number;
 transactions?:ClassificationTransactionPatch[];
 rules?:Rule[];
 /** Only rules written by this operation; merge by id without replacing other rules. */
 rulesDelta?:Rule[];
 /** The atomic write succeeded, but its confirmed delta is unavailable. Refresh without retrying. */
 needsRefresh?:boolean;
};
