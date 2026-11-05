import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const publicNames=['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','NEXT_PUBLIC_SUPABASE_ANON_KEY'];

/** Read only the public names used here. Never return or print other secrets. */
export function readPublicConfig(directory,environment=process.env){
 const config={};
 for(const filename of ['.env','.env.development','.env.local','.env.development.local']){
  const path=resolve(directory,filename);if(!existsSync(path))continue;
  for(const line of readFileSync(path,'utf8').split(/\r?\n/)){
   const match=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
   if(!match||!publicNames.includes(match[1]))continue;
   let value=match[2];
   if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
   else value=value.replace(/\s+#.*$/,'').trim();
   config[match[1]]=value;
  }
 }
 for(const name of publicNames)if(environment[name]!==undefined)config[name]=environment[name];
 return config;
}

const payload=value=>{try{const parsed=JSON.parse(Buffer.from(value.split('.')[1]||'','base64url').toString());return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}};
const placeholder=value=>/your[-_ ]|PROJECT_REF|PUBLISHABLE_KEY|ANON_KEY|replace/i.test(value);

/** Validate installer-provided public configuration; no network or key output. */
export function checkPublicSupabaseConfig(config){
 const checks=[],report=(status,message)=>checks.push({status,message});
 const url=config.NEXT_PUBLIC_SUPABASE_URL||'';
 let parsed;
 if(!url||placeholder(url))report('WARN','Supabase URL 미설정 · .env.example을 참고해 자신의 .env.local을 작성하세요.');
 else{
  let valid=false;
  try{
   parsed=new URL(url);
   const local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
   valid=(parsed.protocol==='https:'||(local&&parsed.protocol==='http:'))&&!parsed.username&&!parsed.password&&['','/'].includes(parsed.pathname)&&!parsed.search&&!parsed.hash;
  }catch{}
  report(valid?'OK':'FAIL',valid?'Supabase URL 형식 확인 · 실제 연결과 소유권은 별도로 확인하세요.':'Supabase URL 형식 오류 · HTTPS 또는 로컬 Supabase 주소를 사용하고 계정정보·경로·query를 제거하세요.');
 }
 const key=config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||config.NEXT_PUBLIC_SUPABASE_ANON_KEY||'';
 const secret=publicNames.filter(name=>name.endsWith('KEY')).some(name=>config[name]?.startsWith('sb_secret_')||payload(config[name]||'').role==='service_role');
 if(secret)report('FAIL','비밀 서버 키가 NEXT_PUBLIC 설정에 있습니다. 공개 키로 교체하세요.');
 else if(!key||placeholder(key))report('WARN','Supabase 공개 키 미설정 · 자신의 publishable/anon 키를 설정하세요.');
 else{
  const jwt=payload(key),publishable=/^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  const anon=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)&&jwt.role==='anon';
  const ref=parsed?.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  if(anon&&ref&&jwt.ref&&jwt.ref!==ref)report('FAIL','Supabase anon 키의 프로젝트가 설정한 URL과 다릅니다.');
  else report(publishable||anon?'OK':'FAIL',publishable||anon?'Supabase 공개 키 형식 확인 · 실제 권한과 만료는 이 검사로 확인하지 않습니다.':'Supabase 공개 키 형식을 확인하세요. 키 값은 출력하지 않습니다.');
 }
 return checks;
}

export function runDoctor({directory=root,environment=process.env,strict=false,log=console.log}={}){
 const checks=[];
 log('멀린 개발환경 진단 — 로컬 설정만 검사하며 외부 서비스에는 연결하지 않습니다.');
 checks.push({status:Number(process.versions.node.split('.')[0])===22?'OK':'WARN',message:`Node ${process.versions.node} · 개발/CI 기준은 Node 22입니다.`});
 for(const name of ['next','tsx','@electric-sql/pglite']){
  try{require.resolve(name);checks.push({status:'OK',message:`${name} 설치됨`});}
  catch{checks.push({status:'WARN',message:`${name} 미설치 · npm ci를 실행하세요.`});}
 }
 checks.push(...checkPublicSupabaseConfig(readPublicConfig(directory,environment)));
 for(const {status,message} of checks)log(`[${status}] ${message}`);
 const failures=checks.filter(check=>check.status==='FAIL').length,warnings=checks.filter(check=>check.status==='WARN').length;
 log(`검사 결과: 오류 ${failures}개 · 확인할 항목 ${warnings}개. 인증 정보는 출력하지 않았습니다.`);
 return failures>0||(strict&&warnings>0)?1:0;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 process.exitCode=runDoctor({strict:process.argv.includes('--strict')});
}
