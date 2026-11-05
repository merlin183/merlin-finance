import {authenticated,apiError,assertSameOrigin} from '@/lib/supabase/server';
import {digest,type ParsedRow,type ParseOptions} from '@/lib/finance/parser';
import {detect,headerSignature,matchingPreset,validateMapping} from '@/lib/finance/auto-mapping';
import {previewSheets,type SheetPlan} from '@/lib/finance/import-preview';
import {readTransactions,sheetRows,transactionSheet} from '@/lib/finance/workbook';
import {z} from 'zod';

export async function POST(request:Request){
 let rollback:(()=>Promise<void>)|undefined;
 try{
  assertSameOrigin(request);
  const {db,ownerId}=await authenticated();
  const form=await request.formData(),file=form.get('file');
  if(!(file instanceof File)||file.size>4*1024*1024||!file.size||!/^.+\.(xlsx|xls|csv)$/i.test(file.name))throw Error('4MB 이하의 Excel 또는 CSV 파일을 선택하세요.');
  const account=z.string().uuid().parse(form.get('account'));
  const {data:a,error:ae}=await db.from('fd_accounts').select('id').eq('id',account).single();
  if(ae||!a)throw Error('계좌를 확인하세요.');
  const workbook=readTransactions(await file.arrayBuffer());
  const {data:preset}=await db.from('fd_mapping_presets').select('mapping').eq('account_id',account).maybeSingle();
  const configSchema=z.array(z.object({name:z.string().min(1),mapping:z.unknown(),options:z.object({headerRow:z.number().int().min(0),year:z.number().int().min(1900).max(9999).optional(),month:z.number().int().min(1).max(12).optional(),amountMode:z.enum(['signed','in','out']).optional()})})).min(1).max(100);
  let configs:z.infer<typeof configSchema>;
  if(form.get('sheets'))configs=configSchema.parse(JSON.parse(String(form.get('sheets'))));
  else{
   const name=String(form.get('sheet')||transactionSheet(workbook,file.name)),rows=sheetRows(workbook,name),auto=detect(rows,{fileName:file.name,sheetName:name});
   const headerRow=Number(form.get('headerRow')??auto.headerRow),d=detect(rows,{fileName:file.name,sheetName:name,headerRow}),p=matchingPreset(preset?.mapping,d,rows);
   configs=configSchema.parse([{name,mapping:form.get('mapping')?JSON.parse(String(form.get('mapping'))):p?.columns||d.mapping,options:{headerRow,year:Number(form.get('year'))||d.year,month:Number(form.get('month'))||d.month,amountMode:form.get('amountMode')||p?.amountMode||d.amountMode}}]);
  }
  if(new Set(configs.map(s=>s.name)).size!==configs.length)throw Error('같은 시트를 중복 선택할 수 없습니다.');
  const plans:SheetPlan[]=configs.map(config=>{
   const rows=sheetRows(workbook,config.name),headerRow=config.options.headerRow;
   if(headerRow>=rows.length)throw Error(`${config.name}: 헤더 행을 확인하세요.`);
   return {name:config.name,rows,selected:true,detected:detect(rows,{fileName:file.name,sheetName:config.name,headerRow}),mapping:validateMapping(config.mapping,rows,headerRow),options:config.options};
  });
  const [{data:categories,error:ce},{data:rules,error:re},{data:aliases,error:al}]=await Promise.all([
   db.from('fd_categories').select('*'),db.from('fd_category_rules').select('*'),db.from('fd_gwamok_aliases').select('*')]);
  if(ce||re||al)throw Error('분류 규칙을 불러오지 못했습니다.');
  const result=previewSheets(plans,categories!,rules!,aliases!,account);
  if(result.problems.length)throw Error(result.problems.join(' '));
  if(result.errors.length&&form.get('allowPartial')!=='true')throw Error(`${result.errors.length}행을 읽지 못했습니다. 확인 필요 행을 수정하거나 제외 저장을 선택해주세요.`);
  if(!result.parsed.length)throw Error('저장할 거래를 찾지 못했습니다. 인식 결과의 확인 필요 항목을 확인해주세요.');
  const parsed:ParsedRow[]=[];
  for(const row of result.parsed){const {sheet:sourceSheet,source_row,...transaction}=row;parsed.push({...transaction,source_sheet:sourceSheet,source_row,dedup_hash:await digest(account,row.txn_date,row.amount,row.direction,row.description,row.balance)});}
  const uid=crypto.randomUUID(),path=`${ownerId}/${uid}.${file.name.split('.').pop()!.toLowerCase()}`;
  const {error:storageError}=await db.storage.from('finance-uploads').upload(path,file,{contentType:file.type||'application/octet-stream',upsert:false});
  if(storageError)throw Error('원본 파일을 비공개 보관함에 저장하지 못했습니다.');
  rollback=async()=>{
   const {error:rowError}=await db.from('fd_uploads').delete().eq('id',uid);
   const {error:fileError}=await db.storage.from('finance-uploads').remove([path]);
   if(rowError||fileError)throw Error('저장 중 오류가 났고 취소를 완료하지 못했습니다. 업로드 기록에서 취소하세요.');
  };
  const {error:uploadError}=await db.from('fd_uploads').insert({id:uid,owner_id:ownerId,account_id:account,filename:file.name.slice(0,200),storage_path:path,error_count:result.errors.length,errors:result.errors});
  if(uploadError)throw Error('업로드 기록을 저장하지 못했습니다.');
  let success=0;
  for(let i=0;i<parsed.length;i+=500){
   const {data,error}=await db.rpc('fd_import_transactions',{p_account:account,p_upload:uid,p_rows:parsed.slice(i,i+500)});
   if(error)throw Error('거래 저장에 실패했습니다. 이번 업로드는 취소됩니다.');success+=Number(data);
  }
  const duplicate=result.parsed.length-success;
  const {error:finishError}=await db.from('fd_uploads').update({success_count:success,duplicate_count:duplicate}).eq('id',uid);
  if(finishError)throw Error('업로드 결과를 저장하지 못했습니다.');
  let warning:string|undefined;
  if(form.get('savePreset')==='true'&&!result.errors.length){
   const selected=plans.find(p=>p.name===form.get('sheet'))||plans[0],mapping=selected.mapping,opts:ParseOptions=selected.options,detected=selected.detected,headerRow=opts.headerRow;
   const {error}=await db.from('fd_mapping_presets').upsert({owner_id:ownerId,account_id:account,mapping:{version:2,columns:mapping,signature:headerSignature(detected.headers),amountMode:opts.amountMode},header_row:headerRow},{onConflict:'owner_id,account_id'});
   if(error)warning='거래는 저장했지만 파일 형식을 기억하지 못했습니다. 다음 업로드에서도 자동 인식합니다.';
  }
  await db.from('fd_audit_log').insert({owner_id:ownerId,action:'거래 업로드',detail:`${success}건 저장 · 중복 ${duplicate}건 · 확인필요 ${result.errors.length}건`});
  rollback=undefined;
  return Response.json({success,duplicate,errors:result.errors,skipped:result.skipped,warning});
 }catch(e){
  if(rollback){try{await rollback()}catch(cleanup){return apiError(cleanup)}}return apiError(e);
 }
}
