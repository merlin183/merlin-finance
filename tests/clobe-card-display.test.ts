import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmedClobeCardBusinesses,reviewedClobeCardBill} from '../lib/finance/clobe-card-display';
import type {ClobeCardBill,ClobeCardBillsResponse} from '../lib/clobe/card-billing-types';
import type {Dataset} from '../lib/finance/types';
const bill:ClobeCardBill={key:'approval-group',date:'2027-02-15',amount:1200,maskedCard:'•••• 1111',kind:'REGULAR',itemCount:2,replaceable:true,reason:null};
const response:ClobeCardBillsResponse={fetchedAt:'2027-02-01T00:00:00Z',startDate:'2027-02-01',endDate:'2027-02-28',companies:[{id:'company',name:'Example',bills:[bill],error:null,scraping:{status:'SUCCESS',lastCollectedAt:null,error:null},warnings:[]}]};
test('restores only previously confirmed, unambiguous business mappings',()=>{
 const data={accounts:[{id:'account1',business_id:'business1'},{id:'account2',business_id:'business2'}]} as Pick<Dataset,'accounts'>;
 assert.deepEqual([...confirmedClobeCardBusinesses([{company_id:'one',external_account_id:'1',account_id:'account1'},{company_id:'ambiguous',external_account_id:'2',account_id:'account1'},{company_id:'ambiguous',external_account_id:'3',account_id:'account2'},{company_id:'deleted',external_account_id:'4',account_id:'missing'}],data)],[['one','business1']]);
});
test('fresh unchanged bill is required before applying a reviewed source',()=>{
 assert.equal(reviewedClobeCardBill(response,'company',bill),bill);
 for(const patch of [{amount:1300},{date:'2027-02-16'},{kind:'PRE_PAYMENT' as const},{replaceable:false},{amount:null},{itemCount:3}])assert.equal(reviewedClobeCardBill({...response,companies:[{...response.companies[0],bills:[{...bill,...patch}]}]},'company',bill),undefined);
 assert.equal(reviewedClobeCardBill({...response,companies:[{...response.companies[0],error:'Source incomplete'}]},'company',bill),undefined);
 assert.equal(reviewedClobeCardBill({...response,companies:[]},'company',bill),undefined);
});
