import type {CashEstimateOptions} from './cash-estimates';
import type {Dataset} from './types';
import {installationPolicy,type CashEstimateExclusionPolicy} from './installation-policy';

const key=(value:string)=>value.normalize('NFKC').replace(/\s/g,'');
/** Installer-selected estimate exclusions never remove actual ledger costs. */
export function cashPlanEstimateOptions(data:Pick<Dataset,'businesses'|'categories'>,policies:readonly CashEstimateExclusionPolicy[]=installationPolicy.excludedCashEstimateCategories):CashEstimateOptions {
 const excludedBusinessCategories=data.businesses
  .flatMap(business=>data.categories.filter(category=>policies.some(policy=>key(policy.businessName)===key(business.name)&&key(policy.categoryName)===key(category.name)))
   .map(category=>({businessId:business.id,categoryId:category.id})));
 return {excludedBusinessCategories};
}
