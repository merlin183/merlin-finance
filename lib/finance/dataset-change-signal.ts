const channelName='finance-dataset-change-v2';
const legacyChannelName='finance-dataset-change-v1';
const changed='changed';
const channels=new Map<string,BroadcastChannel>();

function connection(name:string){
 if(typeof window==='undefined'||typeof BroadcastChannel==='undefined')return null;
 try{
  let channel=channels.get(name);
  if(!channel){channel=new BroadcastChannel(name);channels.set(name,channel);}
  return channel;
 }catch{return null;}
}

/** No transactions, account identifiers, user IDs or credentials cross tabs. */
export function publishDatasetChange(){
 // Old bundles read eagerly in every hidden tab. Only current clients receive
 // new notifications; their visibility gate coalesces background invalidations.
 try{connection(channelName)?.postMessage(changed);}catch{/* This tab still refreshes directly. */}
}

export function subscribeDatasetChanges(onChange:()=>void){
 // Accept old writers until their tabs reload, without waking them ourselves.
 const sources=[connection(channelName),connection(legacyChannelName)].filter((source):source is BroadcastChannel=>source!==null);
 const receive=(event:MessageEvent<unknown>)=>{if(event.data===changed)onChange();};
 for(const source of sources)source.addEventListener('message',receive);
 // Current-channel publish shares this document's receive object, so it never
 // receives its own notification. Reuse channels but remove every view listener.
 return()=>{for(const source of sources)source.removeEventListener('message',receive);};
}
