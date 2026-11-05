export const won=(n:number|null|undefined)=>n==null?'미설정':new Intl.NumberFormat('ko-KR',{maximumFractionDigits:0}).format(n)+'원';
export const compact=(n:number)=>Math.abs(n)>=100000000?`${(n/100000000).toFixed(1)}억`:Math.abs(n)>=10000?`${Math.round(n/10000).toLocaleString()}만`:n.toLocaleString();
export const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const dateISO=(d:Date)=>d.toISOString().slice(0,10);
export const addDays=(date:string,n:number)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return dateISO(d)};
