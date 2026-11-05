import {z} from 'zod';
import {today} from './format';

export type PaymentKind='general'|'tax';
export type PaymentStatus='pending'|'paid';
export type CashPlanEdit = {
 id:string;
 business_id:string;
 source_type:'estimated'|'registered'|'manual';
 source_key:string;
 month:string;
 title:string;
 account_id:string|null;
 plan_date:string|null;
 amount:number;
 memo:string;
 excluded:boolean;
 /** Legacy responses omit these fields; omission means an ordinary pending plan. */
 payment_kind?:PaymentKind;
 payment_status?:PaymentStatus;
 /** User-confirmed payment is plan evidence only, never a bank transaction. */
 confirmed_amount?:number|null;
 confirmed_date?:string|null;
 confirmation_complete?:boolean;
 confirmation_memo?:string;
 version:number;
 updated_at:string;
};

const monthPattern=/^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/;
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const saveSchema=z.object({
 action:z.literal('save'),
 id:z.string().uuid(),
 business_id:z.string().uuid(),
 source_type:z.enum(['estimated','registered','manual']),
 source_key:z.string().min(1).max(1500),
 month:z.string().refine(value=>value==='*'||monthPattern.test(value),'수정할 월을 확인해주세요.'),
 title:z.string().trim().min(1).max(500),
 account_id:z.string().uuid().nullable(),
 plan_date:z.string().refine(validDate,'올바른 지출일을 입력해주세요.').nullable(),
 amount:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
 memo:z.string().max(2000),
 excluded:z.boolean(),
 payment_kind:z.enum(['general','tax']).optional(),
 payment_status:z.enum(['pending','paid']).optional(),
 version:z.number().int().min(0).max(2147483646),
}).strict();
const deleteSchema=z.object({action:z.literal('delete'),id:z.string().uuid(),version:z.number().int().min(1).max(2147483646)}).strict();
const paymentStatusSchema=z.object({action:z.literal('payment_status'),id:z.string().uuid(),version:z.number().int().min(1).max(2147483646),payment_status:z.enum(['pending','paid'])}).strict();
const paymentConfirmationSchema=saveSchema.omit({action:true,payment_kind:true,payment_status:true}).extend({
 action:z.literal('payment_confirmation'),
 confirmed_amount:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
 confirmed_date:z.string().refine(validDate,'올바른 실제 출금일을 입력해주세요.').nullable(),
 confirmation_complete:z.boolean(),
 confirmation_memo:z.string().max(2000).default(''),
}).strict();

export const cashPlanChangeSchema=z.discriminatedUnion('action',[saveSchema,deleteSchema,paymentStatusSchema,paymentConfirmationSchema]).superRefine((change,ctx)=>{
 if(change.action!=='save'&&change.action!=='payment_confirmation')return;
 if(change.month==='*'&&(!change.excluded||change.source_type==='manual'))ctx.addIssue({code:z.ZodIssueCode.custom,message:'전체 기간에는 기존 항목의 제외만 저장할 수 있습니다.',path:['month']});
 if(change.plan_date&&(change.month==='*'||!change.plan_date.startsWith(`${change.month}-`)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'지출일은 수정할 월 안에서 선택해주세요.',path:['plan_date']});
 if(change.source_type!=='estimated'&&!z.string().uuid().safeParse(change.source_key).success)ctx.addIssue({code:z.ZodIssueCode.custom,message:'원본 항목 식별자를 확인해주세요.',path:['source_key']});
 if(change.action==='payment_confirmation'){
  const cleared=change.confirmed_amount===null&&change.confirmed_date===null&&!change.confirmation_complete;
  if(cleared&&change.confirmation_memo!=='')ctx.addIssue({code:z.ZodIssueCode.custom,message:'확인을 해제하면 확인 메모도 함께 해제됩니다.',path:['confirmation_memo']});
  if(change.month==='*'||change.excluded)ctx.addIssue({code:z.ZodIssueCode.custom,message:'제외된 계획에는 출금 확인을 저장할 수 없습니다.',path:['month']});
  if(!cleared&&(change.confirmed_amount===null||change.confirmed_date===null))ctx.addIssue({code:z.ZodIssueCode.custom,message:'실제 출금일과 금액을 함께 입력해주세요.',path:['confirmed_date']});
  if(change.confirmed_date&&(!change.confirmed_date.startsWith(`${change.month}-`)||change.confirmed_date>today()))ctx.addIssue({code:z.ZodIssueCode.custom,message:'실제 출금일은 해당 월의 오늘 이전 날짜로 입력해주세요.',path:['confirmed_date']});
  if(cleared&&change.version===0)ctx.addIssue({code:z.ZodIssueCode.custom,message:'저장된 출금 확인만 해제할 수 있습니다.',path:['version']});
 }else{
  if(change.payment_kind==='tax'&&(change.source_type!=='manual'||change.month==='*'||change.plan_date===null||change.amount<=0))ctx.addIssue({code:z.ZodIssueCode.custom,message:'세금은 금액과 납부기일이 있는 일회성 직접 추가 항목으로 등록해주세요.',path:['payment_kind']});
  if(change.payment_kind==='general'&&change.payment_status==='paid')ctx.addIssue({code:z.ZodIssueCode.custom,message:'납부완료 표시는 세금 일정에만 적용할 수 있습니다.',path:['payment_status']});
 }
});
export const cashPlanChangesSchema=z.object({changes:z.array(cashPlanChangeSchema).min(1).max(100)}).strict().superRefine(({changes},ctx)=>{
 if(new Set(changes.map(change=>change.id)).size!==changes.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'같은 항목을 한 번만 수정해주세요.',path:['changes']});
 const saves=changes.filter(change=>change.action==='save'||change.action==='payment_confirmation');
 const keys=saves.map(change=>JSON.stringify([change.business_id,change.source_type,change.source_key,change.month]));
 if(new Set(keys).size!==keys.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'같은 원본과 월의 수정이 중복되었습니다.',path:['changes']});
});
export type CashPlanChange=z.infer<typeof cashPlanChangeSchema>;
