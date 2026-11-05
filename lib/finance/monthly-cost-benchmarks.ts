import type {MonthlyMetricId} from './monthly-report';
import {installationPolicy,type BenchmarkIndustryPolicy} from './installation-policy';

export const MONTHLY_COST_BENCHMARK_SOURCE={
 year:2025,
 title:'한국은행 2025년 기업경영분석',
 url:'https://www.bok.or.kr/portal/bbs/P0000599/view.do?menuNo=200455&nttId=11065774',
} as const;

type ComparedMetric='payroll'|'rent'|'advertising';
type BenchmarkIndustry={code:'P85'|'J582';label:string;provisional:boolean};
export type MonthlyCostComparison={reference:number|null;current:number|null};

/** Observed annual SG&A ratios, not recommended limits or total employment costs. */
const industries={
 P85:{label:'교육 서비스업',ratios:{payroll:25.12,rent:6.49,advertising:3.19}},
 J582:{label:'소프트웨어 개발 및 공급업',ratios:{payroll:18.27,rent:1.22,advertising:4.70}},
} as const;
const businessKey=(name:string)=>name.normalize('NFKC').replace(/\s+/g,'');

/** Exact names only: missing industry information must not inherit another peer. */
export function monthlyCostBenchmarkIndustry(businessName:string,policies:readonly BenchmarkIndustryPolicy[]=installationPolicy.benchmarkIndustries):BenchmarkIndustry|null {
 const key=businessKey(businessName);
 const matches=policies.filter(policy=>businessKey(policy.businessName)===key);
 if(!key||matches.length!==1)return null;
 const {code,provisional=false}=matches[0];
 return {code,label:industries[code].label,provisional};
}

/** Compare saved monthly cash actuals with a separate annual industry reference. */
export function monthlyCostComparison(businessName:string,metric:MonthlyMetricId,amount:number,sales:number,policies:readonly BenchmarkIndustryPolicy[]=installationPolicy.benchmarkIndustries):MonthlyCostComparison|null {
 if(metric!=='payroll'&&metric!=='rent'&&metric!=='advertising')return null;
 const industry=monthlyCostBenchmarkIndustry(businessName,policies);
 let current:number|null=null;
 if(Number.isFinite(amount)&&amount>=0&&Number.isFinite(sales)&&sales>0){
  const ratio=amount/sales*100;
  if(Number.isFinite(ratio))current=ratio===0?0:ratio;
 }
 return {reference:industry?industries[industry.code].ratios[metric as ComparedMetric]:null,current};
}
