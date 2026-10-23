import { localRequest } from './router';
import { sqlite } from '@homechef/server/src/db/index';
export async function validateCore(){
 const checks:string[]=[];
 function check(value:unknown,name:string){if(!value)throw Error(name);checks.push(name);}
 const call=async(method:string,path:string,body?:unknown,expected=200)=>{const response=await localRequest('/api'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});const data=response.status===204?null:await response.json();if(response.status!==expected)throw Error(`${method} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`);return data;};
 check((sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get() as {n:number}).n===15,'15个正式迁移已执行');
 if((sqlite.prepare('SELECT count(*) n FROM ingredient_definition').get() as {n:number}).n){await (await import('./validate-rollback')).validateRollback();return;}
 await call('POST','/definitions',{name:'非法',units:['个'],extra:true},400);checks.push('未知字段拒绝');
 await call('POST','/definitions',{name:'非法',units:['个'],estimated_shelf_life_days:'7'},400);checks.push('禁止字符串数字强制转换');
 const defs=[];for(const name of ['鸡蛋','番茄','青菜'])defs.push(await call('POST','/definitions',{name,units:['个'],estimated_shelf_life_days:7},201));
 check(defs.every(d=>Number.isInteger(d.id)),'食材新增与RETURNING');
 await call('POST','/definitions',{name:'鸡蛋',units:['个']},409);checks.push('重复名称返回409');
 const stocks=[];for(const def of defs)stocks.push(await call('POST','/ingredients',{definition_id:def.id,quantity:30,unit:'个',storage_method:'冷藏'},201));
 check(stocks.every(s=>s.quantity===30),'新增库存');
 await call('POST','/ingredients',{definition_id:defs[0].id,quantity:-1,unit:'个'},400);checks.push('负库存拒绝');
 const categories=await call('GET','/categories');const seasoning=categories.find((c:any)=>c.name==='调味品');
 const salt=await call('POST','/definitions',{name:'盐',units:[],category_id:seasoning.id},201);
 const recipes=[];for(const [i,name]of ['番茄炒蛋','清炒青菜','蒸鸡蛋'].entries())recipes.push(await call('POST','/recipes',{name,ingredients:[{definition_id:defs[i===1?2:0].id,quantity:2,unit:'个'},{definition_id:salt.id,quantity:null,unit:null}],tags:i===1?['素菜']:['荤菜'],steps:['准备食材','烹饪完成']},201));
 check(recipes.every(r=>r.id&&r.ingredients.length===2),'菜谱完整保存与步骤');
 await call('PUT',`/recipes/${recipes[0].id}/preference`,{value:'like'});checks.push('菜谱偏好');
 const recommendations=await call('POST','/recommendation/meal-plans',{people:2});check(recommendations.plans.length>0,'离线整餐推荐');
 const plan=recommendations.plans[0],request_id=crypto.randomUUID();const payload={people:2,dishes:plan.dishes.map((d:any)=>({recipe_id:d.recipe_id,servings:d.servings})),snapshot_id:plan.snapshot_id,request_id};
 const applied=await call('POST','/recommendation/apply',payload);const replay=await call('POST','/recommendation/apply',payload);
 check(applied.session_id===replay.session_id&&replay.idempotent_replay,'推荐创建持久化幂等');
 await call('POST','/recommendation/apply',{...payload,people:3},409);checks.push('同幂等键异载荷拒绝');
 const detail=await call('GET',`/cooking/sessions/${applied.session_id}`);
 const preview=await call('GET',`/cooking/sessions/${applied.session_id}/settle/preview`);
 check(preview.items.filter((i:any)=>i.is_seasoning).every((i:any)=>!i.required_reason),'调味品无需确认');
 for(const dish of detail.dishes)await call('PATCH',`/cooking/sessions/${detail.id}/dishes/${dish.id}/progress`,{status:'done'});
 const before=await call('GET','/ingredients');
 await call('POST',`/cooking/sessions/${detail.id}/settle`,{});checks.push('正式烹饪结算');
 const after=await call('GET','/ingredients');check(after.reduce((s:number,x:any)=>s+x.quantity,0)<before.reduce((s:number,x:any)=>s+x.quantity,0),'结算实际扣减库存');
 await call('POST',`/cooking/sessions/${detail.id}/settle`,{},409);const repeated=await call('GET','/ingredients');check(JSON.stringify(after)===JSON.stringify(repeated),'重复结算不多扣库存');
 check((sqlite.prepare('SELECT count(*) n FROM cooking_settlement').get() as {n:number}).n===1,'只有一张结算凭证');
 const settings=await call('GET','/settings');check(settings.expiry_warning_mode,'默认保质期设置可读');
 await call('PATCH','/settings',{expiry_warning_threshold:4});checks.push('设置持久化');
 await call('GET','/unknown',undefined,404);checks.push('未知入口404');
 check((sqlite.pragma('foreign_key_check') as unknown[]).length===0,'完整业务后外键无错误');
 check(sqlite.pragma('integrity_check',{simple:true})==='ok','完整业务后数据库完整');
 console.log('HOMECHEF_CORE_RESULT '+JSON.stringify({passed:checks.length,checks,session_id:detail.id,request_id}));
 return {passed:checks.length,checks};
}
