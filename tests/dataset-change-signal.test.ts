import test from 'node:test';
import assert from 'node:assert/strict';

const currentName='finance-dataset-change-v2',legacyName='finance-dataset-change-v1';
let moduleIndex=0;
async function freshSignal(){return await import(`../lib/finance/dataset-change-signal.ts?test=${++moduleIndex}`) as typeof import('../lib/finance/dataset-change-signal');}

type Listener=(event:{data:unknown})=>void;
function mockChannels(){
 const instances:MockChannel[]=[],messages:{name:string;body:unknown}[]=[],denied=new Set<string>();
 class MockChannel{
  listeners=new Set<Listener>();
  constructor(readonly name:string){if(denied.has(name))throw Error('synthetic unavailable channel');instances.push(this);}
  postMessage(body:unknown){
   if(denied.has(this.name))throw Error('synthetic denied publish');
   messages.push({name:this.name,body});
   for(const peer of instances)if(peer!==this&&peer.name===this.name)for(const listener of peer.listeners)listener({data:body});
  }
  addEventListener(type:string,listener:Listener){assert.equal(type,'message');this.listeners.add(listener);}
  removeEventListener(type:string,listener:Listener){assert.equal(type,'message');this.listeners.delete(listener);}
 }
 return {MockChannel,instances,messages,denied};
}
async function withChannels(run:(context:ReturnType<typeof mockChannels>)=>Promise<void>){
 const context=mockChannels();
 const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),previousChannel=Object.getOwnPropertyDescriptor(globalThis,'BroadcastChannel');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
 Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:context.MockChannel});
 try{await run(context);}
 finally{
  if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else Reflect.deleteProperty(globalThis,'window');
  if(previousChannel)Object.defineProperty(globalThis,'BroadcastChannel',previousChannel);else Reflect.deleteProperty(globalThis,'BroadcastChannel');
 }
}

test('new writes notify other current clients only, with no own signal or legacy fan-out',async()=>{
 await withChannels(async({MockChannel,messages})=>{
  const writer=await freshSignal(),reader=await freshSignal(),oldTab=new MockChannel(legacyName);
  let ownCalls=0,newCalls=0,oldCalls=0;
  const unsubscribeWriter=writer.subscribeDatasetChanges(()=>{ownCalls++;});
  const unsubscribeReader=reader.subscribeDatasetChanges(()=>{newCalls++;});
  oldTab.addEventListener('message',()=>{oldCalls++;});
  writer.publishDatasetChange();
  assert.equal(ownCalls,0);assert.equal(newCalls,1);assert.equal(oldCalls,0);
  assert.deepEqual(messages,[{name:currentName,body:'changed'}]);
  assert.equal(typeof messages[0].body,'string');
  unsubscribeWriter();unsubscribeReader();
 });
});

test('current clients receive both protocol versions and ignore all other message bodies',async()=>{
 await withChannels(async({MockChannel})=>{
  const signal=await freshSignal();let received=0;
  const unsubscribe=signal.subscribeDatasetChanges(()=>{received++;});
  const current=new MockChannel(currentName),legacy=new MockChannel(legacyName);
  current.postMessage('changed');legacy.postMessage('changed');assert.equal(received,2);
  for(const other of [null,undefined,0,'other',{type:'changed'},['changed']]){
   current.postMessage(other);legacy.postMessage(other);
  }
  assert.equal(received,2);unsubscribe();
 });
});

test('subscriptions reuse document channels and unsubscribe every protocol listener independently',async()=>{
 await withChannels(async({MockChannel,instances})=>{
  const signal=await freshSignal();let first=0,second=0;
  const offFirst=signal.subscribeDatasetChanges(()=>{first++;});
  const offSecond=signal.subscribeDatasetChanges(()=>{second++;});
  const documentChannels=[...instances];
  assert.deepEqual(documentChannels.map(channel=>channel.name),[currentName,legacyName]);
  assert.ok(documentChannels.every(channel=>channel.listeners.size===2));
  signal.publishDatasetChange();assert.equal(first,0);assert.equal(second,0);assert.equal(instances.length,2);
  const current=new MockChannel(currentName),legacy=new MockChannel(legacyName);
  current.postMessage('changed');assert.equal(first,1);assert.equal(second,1);
  offFirst();legacy.postMessage('changed');assert.equal(first,1);assert.equal(second,2);
  offSecond();assert.ok(documentChannels.every(channel=>channel.listeners.size===0));
  current.postMessage('changed');legacy.postMessage('changed');assert.equal(second,2);
  const offThird=signal.subscribeDatasetChanges(()=>{second++;});
  assert.equal(instances.length,4);offThird();
  assert.ok(documentChannels.every(channel=>channel.listeners.size===0));
 });
});

test('missing browser APIs make publish and subscribe harmless without creating channels',async()=>{
 await withChannels(async({instances,MockChannel})=>{
  const signal=await freshSignal();let calls=0;
  Reflect.deleteProperty(globalThis,'window');
  assert.doesNotThrow(signal.publishDatasetChange);signal.subscribeDatasetChanges(()=>{calls++;})();
  Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
  Reflect.deleteProperty(globalThis,'BroadcastChannel');
  assert.doesNotThrow(signal.publishDatasetChange);signal.subscribeDatasetChanges(()=>{calls++;})();
  assert.equal(instances.length,0);assert.equal(calls,0);
  Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:MockChannel});
  const off=signal.subscribeDatasetChanges(()=>{calls++;});
  assert.equal(instances.length,2);off();
 });
});

test('channel failures never fall back to legacy publishing or prevent the available receive protocol',async()=>{
 await withChannels(async({MockChannel,denied,messages})=>{
  const signal=await freshSignal();let calls=0;
  denied.add(currentName);
  assert.doesNotThrow(signal.publishDatasetChange);
  const off=signal.subscribeDatasetChanges(()=>{calls++;});
  new MockChannel(legacyName).postMessage('changed');assert.equal(calls,1);
  assert.deepEqual(messages,[{name:legacyName,body:'changed'}]);
  off();denied.delete(currentName);
  signal.publishDatasetChange();assert.deepEqual(messages.at(-1),{name:currentName,body:'changed'});
  denied.add(currentName);assert.doesNotThrow(signal.publishDatasetChange);
  assert.equal(messages.length,2);
 });
});
