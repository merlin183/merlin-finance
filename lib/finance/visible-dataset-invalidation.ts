type VisibleDatasetInvalidationOptions={isVisible:()=>boolean;refreshAfterChange:()=>Promise<void>};

/** Hidden documents remember invalidations instead of queuing full DB reads.
 * A new signal during a visible read still requires a snapshot started later. */
export function createVisibleDatasetInvalidation({isVisible,refreshAfterChange}:VisibleDatasetInvalidationOptions){
 let active=true,dirty=false,current:Promise<void>|null=null;
 function resume():Promise<void>|null{
  if(!active||!isVisible())return null;
  if(current)return current;
  if(!dirty)return null;
  const pending=Promise.resolve().then(async()=>{
   while(active&&dirty&&isVisible()){
    dirty=false;
    try{await refreshAfterChange();}
    catch(error){dirty=true;throw error;}
   }
  }).finally(()=>{if(current===pending)current=null;});
  current=pending;
  // The workspace read reports its error. Keep the dirty marker for the next
  // actual signal/focus event, without retrying a failed read in a loop.
  void pending.catch(()=>{});
  return pending;
 }
 function invalidate(){if(!active)return null;dirty=true;return resume();}
 function dispose(){active=false;dirty=false;}
 return {invalidate,resume,dispose};
}
