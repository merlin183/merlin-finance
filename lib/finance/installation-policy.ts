/**
 * Optional installation policy. These values are compiled into the app: use
 * non-sensitive display names only, then rebuild after changing them.
 * Empty defaults never infer an installer's industry, exclusions or cut-off.
 */
export type BenchmarkIndustryPolicy={businessName:string;code:'P85'|'J582';provisional?:boolean};
export type CashEstimateExclusionPolicy={businessName:string;categoryName:string};
export type SheetBusinessAliasPolicy={businessName:string;aliases:readonly string[]};
export type InstallationPolicy={
 benchmarkIndustries:readonly BenchmarkIndustryPolicy[];
 excludedCashEstimateCategories:readonly CashEstimateExclusionPolicy[];
 sheetBusinessAliases:readonly SheetBusinessAliasPolicy[];
 historicalCompletionBefore:string|null;
};

export const installationPolicy:InstallationPolicy={
 // Example: [{businessName:'예시 교육회사',code:'P85'}]
 benchmarkIndustries:[],
 // Example: [{businessName:'예시 회사',categoryName:'급여'}]
 // Excludes estimated future budgets only; recorded payments remain intact.
 excludedCashEstimateCategories:[],
 // Example: [{businessName:'예시 교육회사',aliases:['예시교육']}]
 sheetBusinessAliases:[],
 // Opt in with an ISO date AND a saved category named 과거완료.
 // Example: '2024-01-01'. Null leaves every unresolved transaction for review.
 historicalCompletionBefore:null,
};
