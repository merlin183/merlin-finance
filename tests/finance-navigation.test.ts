import test from 'node:test';
import assert from 'node:assert/strict';
import {businessHref,financeView,financeViews,settingsSections,navigateAfterSave,isClientFinanceNavigation} from '../app/(finance)/routes';

test('공유 작업공간의 알려진 화면만 서버 왕복 없이 이동한다',()=>{
 for(const path of ['/','/classification','/transactions','/monthly-report','/upload','/settings/admins'])assert.equal(isClientFinanceNavigation('/classification',`${path}?biz=synthetic`),true);
 for(const path of ['/login','/auth/callback','/api/data','/unknown','/settings/unknown','https://example.test/transactions','//example.test/transactions','/\\example.test/transactions'])assert.equal(isClientFinanceNavigation('/classification',path),false);
 assert.equal(isClientFinanceNavigation('/login','/classification'),false);
});

test('직접 URL과 뒤로가기에서 같은 화면을 선택하며 로그인·잘못된 경로는 재무 화면으로 해석하지 않는다',()=>{
 assert.equal(financeView('/'),'overview');
 for(const view of financeViews)assert.equal(financeView(`/${view}`),view);
 for(const section of settingsSections)assert.equal(financeView(`/settings/${section}`),`settings/${section}`);
 assert.equal(financeView('/transactions/'),'transactions');
 for(const path of ['/login','/auth/callback','/unknown','/settings/unknown','/settings/admins/extra'])assert.equal(financeView(path),null);
});

test('사업자 쿼리를 바꿔도 현재 경로와 다른 필터를 유지하고 식별자를 안전하게 인코딩한다',()=>{
 const href=businessHref('/transactions','sort=amount&biz=previous&filter=pending','synthetic-business&x=1');
 const url=new URL(href,'https://example.test');
 assert.equal(url.pathname,'/transactions');assert.equal(url.searchParams.get('biz'),'synthetic-business&x=1');
 assert.equal(url.searchParams.get('sort'),'amount');assert.equal(url.searchParams.get('filter'),'pending');assert.equal(url.searchParams.has('x'),false);
 assert.equal(url.searchParams.getAll('biz').length,1);
});

test('메모 저장이 끝난 뒤에만 이동하고 저장 충돌 때 초안을 남긴 화면을 유지한다',async()=>{
 const events:string[]=[];let finish:()=>void=()=>{};
 const saved=new Promise<void>(resolve=>{finish=resolve;});
 const pending=navigateAfterSave(async()=>{events.push('saving');await saved;events.push('saved');},()=>{events.push('navigate');});
 assert.deepEqual(events,['saving']);finish();await pending;assert.deepEqual(events,['saving','saved','navigate']);
 let navigated=false;
 await assert.rejects(navigateAfterSave(async()=>{throw Error('synthetic note conflict');},()=>{navigated=true;}),/synthetic note conflict/);
 assert.equal(navigated,false);
});

test('저장 중 다른 메뉴를 선택하거나 세션이 끝나면 오래된 이동을 실행하지 않는다',async()=>{
 let current=true,finish:()=>void=()=>{},navigated=false;
 const saved=new Promise<void>(resolve=>{finish=resolve;});
 const pending=navigateAfterSave(()=>saved,()=>{navigated=true;},()=>current);
 current=false;finish();await pending;assert.equal(navigated,false);
});
