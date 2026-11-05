// Server transport: this module never accepts an arbitrary endpoint or tool.
import {Client,StreamableHTTPClientTransport,type CallToolResult} from '@modelcontextprotocol/client';
import {CLOBE_RESOURCE} from './auth';

export const CLOBE_READ_TOOLS=['get_my_context','get_bank_accounts','get_labeled_transactions','get_scraping_status','get_labeled_card_billing_items'] as const;
export type ClobeReadTool=typeof CLOBE_READ_TOOLS[number];
export type ClobeReadSession={call(tool:ClobeReadTool,input?:Record<string,unknown>,options?:{signal?:AbortSignal}):Promise<unknown>;close():Promise<void>};
export const CLOBE_MAX_RESPONSE_BYTES=2*1024*1024;
const REQUEST_TIMEOUT=20000;
export class ClobeReadError extends Error{
 constructor(public readonly code:'request_failed'|'invalid_response'|'forbidden'|'invalid_request'|'timeout'|'unsupported_currency'){
  super({request_failed:'Clobe 자료를 조회하지 못했습니다. 잠시 후 다시 조회해주세요.',invalid_response:'Clobe 원본 자료의 형식을 확인하지 못했습니다. 자료를 다시 조회해주세요.',forbidden:'연결된 Clobe 회사와 계좌만 조회할 수 있습니다.',invalid_request:'회사·계좌와 조회 기간을 확인해주세요.',timeout:'Clobe 조회 시간이 초과되었습니다. 잠시 후 다시 조회해주세요.',unsupported_currency:'외화 통장은 잔액만 조회할 수 있습니다. 거래 내역은 원화 통장을 선택해주세요.'}[code]);
 }
}

// Bounds decompressed bytes while preserving JSON or SSE streaming semantics.
// Reject redirects before credentials can be forwarded to another destination.
export function boundedClobeFetch(fetcher:typeof fetch=fetch):typeof fetch{
 return async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:input.toString());
  if(url.href!==CLOBE_RESOURCE)throw new ClobeReadError('request_failed');
  const signal=init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(REQUEST_TIMEOUT)]):AbortSignal.timeout(REQUEST_TIMEOUT);
  const response=await fetcher(input,{...init,signal,redirect:'error',cache:'no-store'});
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>CLOBE_MAX_RESPONSE_BYTES){await response.body?.cancel();throw new ClobeReadError('invalid_response');}
  if(!response.body)return response;
  let bytes=0;const reader=response.body.getReader();
  const body=new ReadableStream<Uint8Array>({
   async pull(controller){
    try{const next=await reader.read();if(next.done){controller.close();return;}bytes+=next.value.byteLength;if(bytes>CLOBE_MAX_RESPONSE_BYTES){await reader.cancel();controller.error(new ClobeReadError('invalid_response'));return;}controller.enqueue(next.value);}
    catch{controller.error(new ClobeReadError(signal.aborted?'timeout':'request_failed'));}
   },
   cancel:reason=>reader.cancel(reason),
  });
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
export function clobeToolPayload(result:CallToolResult):unknown{
 if(result.isError)throw new ClobeReadError('request_failed');
 if(result.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent;
 const blocks=result.content.filter(block=>block.type==='text');
 if(blocks.length!==1||blocks[0].type!=='text'||Buffer.byteLength(blocks[0].text,'utf8')>CLOBE_MAX_RESPONSE_BYTES)throw new ClobeReadError('invalid_response');
 try{return JSON.parse(blocks[0].text);}catch{throw new ClobeReadError('invalid_response');}
}
export async function createClobeReadSession(accessToken:string,options:{fetcher?:typeof fetch;signal?:AbortSignal}={}):Promise<ClobeReadSession>{
 if(typeof window!=='undefined'||!accessToken||accessToken.length>8192)throw new ClobeReadError('request_failed');
 const client=new Client({name:'merlin-finance-read',version:'1.0.0'});
 const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(50000)]):AbortSignal.timeout(50000);
 const transport=new StreamableHTTPClientTransport(new URL(CLOBE_RESOURCE),{authProvider:{token:async()=>accessToken},requestInit:{cache:'no-store',redirect:'error',signal},fetch:boundedClobeFetch(options.fetcher)});
 try{await client.connect(transport,{signal,timeout:REQUEST_TIMEOUT,maxTotalTimeout:REQUEST_TIMEOUT});}
 catch{await client.close().catch(()=>{});throw new ClobeReadError(signal.aborted?'timeout':'request_failed');}
 return {
  async call(tool,input={},options={}){
   if(!CLOBE_READ_TOOLS.includes(tool))throw new ClobeReadError('forbidden');
   const callSignal=options.signal?AbortSignal.any([signal,options.signal]):signal;
   try{return clobeToolPayload(await client.callTool({name:tool,arguments:{input}},{signal:callSignal,timeout:REQUEST_TIMEOUT,maxTotalTimeout:REQUEST_TIMEOUT}));}
   catch(error){if(error instanceof ClobeReadError)throw error;throw new ClobeReadError(callSignal.aborted?'timeout':'request_failed');}
  },
  async close(){await client.close().catch(()=>{});},
 };
}
