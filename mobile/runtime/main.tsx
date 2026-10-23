import { migrate } from './migrate';
import '@homechef/client/src/styles.css';
import '@homechef/client/src/home.css';
import '@homechef/client/src/recommend.css';
import './mobile.css';
async function start(){
 (window as any).homechefBack=()=>{
   if(document.querySelector('[role="dialog"],.modal-backdrop')){
     document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;
   }
   if(history.state?.homechefView && history.state.homechefView!=='home'){
     history.back();return true;
   }
   return false;
 };
 migrate();
 globalThis.HomeChefSQLite.confirmRestore();
 if(import.meta.env.MODE==='validation' && globalThis.HomeChefSQLite.consumeValidationFlag()){try{await (await import('./validate-core')).validateCore();}catch(e){console.error('HOMECHEF_CORE_FAILURE '+String(e));throw e;}}
 if(import.meta.env.MODE==='content-validation' && globalThis.HomeChefSQLite.consumeValidationFlag()){try{await (await import('./validate-content')).validateContent();}catch(e){console.error('HOMECHEF_CONTENT_FAILURE '+String(e));throw e;}}
 await import('@homechef/client/src/main');
}
void start().catch(error=>{const root=document.getElementById('root')!;root.innerHTML='';const h=document.createElement('h1');h.textContent='HomeChef 暂时无法打开';const p=document.createElement('p');p.textContent=error instanceof Error?error.message:String(error);root.append(h,p);});
