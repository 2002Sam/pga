/* Trusted native web overlays forward mouse gestures to the same DOM handlers
   used by PDF, conversations and file readers. Site scripts get no app bridge. */
let stNativeGesture = null;
function stNativeGestureEvent(state, phase, data = state.last) {
  const target = state.target.isConnected ? state.target : document.documentElement;
  const button = state.gesture === 'right' ? 2 : 1;
  target.dispatchEvent(new PointerEvent('pointer' + phase, {
    bubbles:true, cancelable:true, pointerType:'mouse', pointerId:state.pointerId,
    button, buttons:phase === 'up' || phase === 'cancel' ? 0 : button === 2 ? 2 : 4,
    clientX:data.clientX, clientY:data.clientY, screenX:data.clientX, screenY:data.clientY,
    ctrlKey:!!data.ctrlKey, shiftKey:!!data.shiftKey, metaKey:!!data.metaKey
  }));
}
function stNativeGestureCancel() {
  const state=stNativeGesture;stNativeGesture=null;
  if(state)stNativeGestureEvent(state,'cancel');
}
window.stNativePointer = function(data) {
  if(!data||!['right','middle'].includes(data.gesture)||!['down','move','up','cancel'].includes(data.phase)
    ||!Number.isSafeInteger(data.sequence)||data.sequence<0||typeof data.id!=='string')return false;
  if(data.phase==='cancel') {
    if(stNativeGesture?.sequence!==data.sequence||stNativeGesture.id!==data.id)return false;
    stNativeGestureCancel();return true;
  }
  if(!Number.isFinite(data.clientX)||!Number.isFinite(data.clientY))return false;
  if(data.phase==='down') {
    stNativeGestureCancel();
    if(S.view!=='stage'||data.metaKey)return false;
    const target=window.readingNativeStageTarget?.(data.id);
    if(!target?.isConnected)return false;
    const node=ST.nodes.find(n=>n.el===target);
    if(!node)return false;
    const state={id:data.id,sequence:data.sequence,gesture:data.gesture,target,node,uid:S.uid,
      pointerId:1000000+(data.sequence%1000000000),last:data};
    stNativeGesture=state;
    stNativeGestureEvent(state,'down',data);
    const active=data.gesture==='right'?ST.rightPan:ST.middlePan;
    if(active?.id!==state.pointerId){stNativeGesture=null;return false;}
    return true;
  }
  const state=stNativeGesture;
  if(!state||state.id!==data.id||state.sequence!==data.sequence||state.gesture!==data.gesture)return false;
  if(S.view!=='stage'||S.uid!==state.uid||!ST.nodes.includes(state.node)||state.node.el!==state.target||!state.target.isConnected){
    stNativeGestureCancel();return false;
  }
  state.last=data;
  // Clear before dispatch: pointerup may synchronously release capture or hide the overlay.
  if(data.phase==='up')stNativeGesture=null;
  stNativeGestureEvent(state,data.phase,data);
  return true;
};
window.addEventListener('blur',stNativeGestureCancel);
window.addEventListener('pagehide',stNativeGestureCancel);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stNativeGestureCancel();});
