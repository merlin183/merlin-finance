import test from 'node:test';
import assert from 'node:assert/strict';
import {MONTHLY_COST_BENCHMARK_SOURCE,monthlyCostBenchmarkIndustry as industry,monthlyCostComparison as compare} from '../lib/finance/monthly-cost-benchmarks';
import {monthlyReportMetrics,type MonthlyMetricId} from '../lib/finance/monthly-report';
import type {BenchmarkIndustryPolicy} from '../lib/finance/installation-policy';
const policies:BenchmarkIndustryPolicy[]=[{businessName:'예시교육회사',code:'P85'},{businessName:'TEST교육회사',code:'P85'},{businessName:'예시개발회사',code:'J582',provisional:true}];
const monthlyCostComparison=(business:string,metric:MonthlyMetricId,amount:number,sales:number)=>compare(business,metric,amount,sales,policies);
const monthlyCostBenchmarkIndustry=(business:string)=>industry(business,policies);

test('기존 월간 비용 세 항목에만 판관비 업종 참고 비율을 제공한다',()=>{
 for(const business of ['예시교육회사','TEST교육회사']){
  assert.deepEqual(monthlyCostComparison(business,'payroll',250,1000),{reference:25.12,current:25});
  assert.deepEqual(monthlyCostComparison(business,'rent',60,1000),{reference:6.49,current:6});
  assert.deepEqual(monthlyCostComparison(business,'advertising',30,1000),{reference:3.19,current:3});
 }
 assert.deepEqual(monthlyCostComparison('예시개발회사','payroll',250,1000),{reference:18.27,current:25});
 assert.deepEqual(monthlyCostComparison('예시개발회사','rent',60,1000),{reference:1.22,current:6});
 assert.deepEqual(monthlyCostComparison('예시개발회사','advertising',30,1000),{reference:4.70,current:3});
 for(const metric of monthlyReportMetrics){
  if(metric.id==='payroll'||metric.id==='rent'||metric.id==='advertising')continue;
  assert.equal(monthlyCostComparison('예시교육회사',metric.id,250,1000),null);
 }
});

test('업종 이름은 공백과 NFKC만 정규화하고 불명확한 이름에 참고치를 추정하지 않는다',()=>{
 assert.deepEqual(monthlyCostComparison('  예시 교육회사\t','payroll',250,1000),{reference:25.12,current:25});
 assert.deepEqual(monthlyCostComparison('ＴＥＳＴ 교육 회사','payroll',250,1000),{reference:25.12,current:25});
 for(const name of ['예시미지정회사','합성 사업자','예시교육회사 별도','주식회사 예시개발회사','test교육회사','toString','__proto__','']){
  assert.deepEqual(monthlyCostComparison(name,'payroll',250,1000),{reference:null,current:25});
  assert.equal(monthlyCostBenchmarkIndustry(name),null);
 }
});

test('현재 비율은 실적 금액만 계산하며 100% 초과와 매출 대비 0%를 보존한다',()=>{
 assert.deepEqual(monthlyCostComparison('예시개발회사','payroll',1250,1000),{reference:18.27,current:125});
 assert.deepEqual(monthlyCostComparison('예시교육회사','rent',0,1000),{reference:6.49,current:0});
 assert.deepEqual(monthlyCostComparison('예시교육회사','rent',-0,1000),{reference:6.49,current:0});
 assert.equal(monthlyCostComparison('합성 사업자','advertising',1,3)?.current,1/3*100);
});

test('매출이 없거나 유효하지 않은 값은 현재 비율을 만들지 않는다',()=>{
 for(const sales of [0,-1,NaN,Infinity,-Infinity]){
  assert.deepEqual(monthlyCostComparison('예시교육회사','payroll',250,sales),{reference:25.12,current:null});
 }
 assert.deepEqual(monthlyCostComparison('예시교육회사','payroll',0,0),{reference:25.12,current:null});
 for(const amount of [-1,NaN,Infinity,-Infinity]){
  assert.deepEqual(monthlyCostComparison('예시교육회사','payroll',amount,1000),{reference:25.12,current:null});
 }
 assert.equal(monthlyCostComparison('합성 사업자','payroll',Number.MAX_VALUE,Number.MIN_VALUE)?.current,null);
});

test('참고 자료는 관측 연도와 출처를 보관하고 AI 개발 업종은 잠정 매핑으로 표시한다',()=>{
 assert.equal(MONTHLY_COST_BENCHMARK_SOURCE.year,2025);
 assert.equal(MONTHLY_COST_BENCHMARK_SOURCE.title,'한국은행 2025년 기업경영분석');
 assert.equal(new URL(MONTHLY_COST_BENCHMARK_SOURCE.url).hostname,'www.bok.or.kr');
 assert.deepEqual(monthlyCostBenchmarkIndustry('예시교육회사'),{code:'P85',label:'교육 서비스업',provisional:false});
 assert.deepEqual(monthlyCostBenchmarkIndustry('예시개발회사'),{code:'J582',label:'소프트웨어 개발 및 공급업',provisional:true});
});


test('빈 설치 정책은 업종을 추정하지 않고 명시한 중복 매핑도 보류한다',()=>{
 assert.deepEqual(compare('예시교육회사','payroll',250,1000),{reference:null,current:25});
 assert.equal(industry('예시교육회사'),null);
 assert.equal(industry('예시교육회사',[...policies,policies[0]]),null);
});
