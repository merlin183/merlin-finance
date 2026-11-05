export const financeViews=['consolidated','cash-utilization','monthly-report','transactions','classification','upload','settings'] as const;
export const settingsSections=['businesses','rules','aliases','recurring','admins','account'] as const;

export function financeView(pathname:string){
 const path=pathname.replace(/\/$/,'')||'/';
 if(path==='/')return 'overview';
 const parts=path.slice(1).split('/');
 if(parts.length===1&&financeViews.some(view=>view===parts[0]))return parts[0];
 if(parts.length===2&&parts[0]==='settings'&&settingsSections.some(section=>section===parts[1]))return `settings/${parts[1]}`;
 return null;
}

export function businessHref(pathname:string,search:string,business:string){
 const query=new URLSearchParams(search);query.set('biz',business);
 return `${pathname}?${query.toString()}`;
}

/** These views share a mounted, authenticated workspace and have no page payload. */
export function isClientFinanceNavigation(pathname:string,href:string){
 if(!financeView(pathname)||!href.startsWith('/')||href.startsWith('//')||href.includes('\\'))return false;
 const target=new URL(href,'https://finance.invalid');
 return target.origin==='https://finance.invalid'&&!!financeView(target.pathname);
}

/** Failed or superseded note saves must never navigate away from the draft. */
export async function navigateAfterSave(save:()=>Promise<void>,navigate:()=>void,isCurrent:()=>boolean=()=>true){
 await save();
 if(isCurrent())navigate();
}
