import {z} from 'zod';
import {googleSheetUrl,type SheetMapping} from './google-sheets';

const mapping=z.object({
 sheet:z.string().min(1).max(200).refine(value=>value.trim().length>0),
 account_id:z.string().uuid().nullable(),
 selected:z.boolean(),
}).strict().refine(value=>!value.selected||value.account_id!==null);
const source=z.object({url:z.string().min(1).max(2000),mappings:z.array(mapping).min(1).max(40)}).strict()
 .refine(value=>new Set(value.mappings.map(item=>item.sheet)).size===value.mappings.length)
 .refine(value=>value.mappings.some(item=>item.selected));

export type SheetImportSource={url:string;mappings:SheetMapping[]};

/** Server configuration supplies reviewed defaults, never a second fetch URL. */
export function parseSheetImportSource(raw:string|undefined):SheetImportSource|null{
 if(!raw?.trim())return null;
 if(raw.length>30000)throw Error('등록된 스프레드시트 설정이 너무 큽니다. 시트 연결 설정을 확인해주세요.');
 let value:unknown;
 try{value=JSON.parse(raw);}catch{throw Error('등록된 스프레드시트 설정을 읽지 못했습니다. 시트 연결 설정 형식을 확인해주세요.');}
 const parsed=source.safeParse(value);
 if(!parsed.success)throw Error('등록된 스프레드시트의 시트·계좌 연결 설정이 올바르지 않습니다. 설정을 확인해주세요.');
 let canonicalUrl:string;
 try{canonicalUrl=googleSheetUrl(parsed.data.url).url;}catch{throw Error('등록된 원본 링크가 올바른 Google 스프레드시트 주소가 아닙니다. 연결 설정을 확인해주세요.');}
 return {url:canonicalUrl,mappings:parsed.data.mappings};
}

export function resolveSheetImportMappings(url:string,explicitMappings:SheetMapping[]|undefined,rawConfig:string|undefined):SheetMapping[]|undefined{
 // An explicitly reviewed choice is authoritative, including an empty list.
 if(explicitMappings!==undefined)return explicitMappings;
 const configured=parseSheetImportSource(rawConfig);
 if(!configured||googleSheetUrl(url).url!==configured.url)return undefined;
 return configured.mappings;
}
