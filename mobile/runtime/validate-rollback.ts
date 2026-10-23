import { localRequest } from './router';
import { sqlite } from '@homechef/server/src/db/index';
export async function validateRollback(){
 const checks:string[]=[];
 const assert=(ok:unknown,name:string)=>{if(!ok)throw Error(name);checks.push(name);};
 const call=async(method:string,path:string,body?:unknown,status=200)=>{const r=await localRequest('/api'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});const data=r.status===204?null:await r.json();if(r.status!==status)throw Error(`${path}: ${r.status} ${JSON.stringify(data)}`);return data;};
 const recipe=await call('GET','/recipes/1');
 (globalThis as any).__homechefFault='recipe_full_save_after_links';
 try{await call('PATCH','/recipes/1/full',{name:'模拟失败改名',ingredients:recipe.ingredients.map((i:any)=>({definition_id:i.definition_id,quantity:i.quantity,unit:i.unit,line_key:i.line_key})),tags:recipe.tags,steps:recipe.steps.map((s:any)=>s.content)},500);}finally{delete (globalThis as any).__homechefFault;}
 assert(JSON.stringify(await call('GET','/recipes/1'))===JSON.stringify(recipe),'正式菜谱保存中途故障完整回滚');
 const before=await call('GET','/ingredients');
 const session=await call('POST','/cooking/sessions',{},201);
 let detail=await call('POST',`/cooking/sessions/${session.id}/dishes`,{recipe_id:1,servings:100},201);
 for(const dish of detail.dishes)detail=await call('PATCH',`/cooking/sessions/${session.id}/dishes/${dish.id}/progress`,{status:'done'});
 const shortage=await call('POST',`/cooking/sessions/${session.id}/settle`,{},409);
 assert(shortage.error.code==='INSUFFICIENT_STOCK','库存不足的正式错误语义');
 assert(JSON.stringify(await call('GET','/ingredients'))===JSON.stringify(before),'库存不足结算不留下部分扣减');
 assert((sqlite.prepare('SELECT count(*) n FROM cooking_settlement WHERE session_id=?').get(session.id) as {n:number}).n===0,'库存不足不留下结算凭证');
 await call('POST',`/cooking/sessions/${session.id}/abandon`,{});
 const stock1=await call('POST','/ingredients',{definition_id:1,quantity:1,unit:'个'},201),stock2=await call('POST','/ingredients',{definition_id:1,quantity:1,unit:'个'},201);
 await call('POST','/ingredients/bulk-delete',{ids:[stock1.id,stock2.id]});
 assert((await call('GET','/ingredients')).length===before.length,'库存批量删除原生事务');
 await call('GET','/recipes?tags=荤菜&tags=素菜&tag_mode=or');checks.push('重复查询参数与标签筛选');
 assert((sqlite.pragma('foreign_key_check') as unknown[]).length===0,'额外检查后外键完整');
 console.log('HOMECHEF_ROLLBACK_RESULT '+JSON.stringify({passed:checks.length,checks}));
}
