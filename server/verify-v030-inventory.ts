import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const temp=mkdtempSync(join(tmpdir(),'homechef-inventory-'));process.env.HOME_CHEF_DB_PATH=join(temp,'test.db')
const {db,sqlite}=await import('./src/db/index.js');const {migrate}=await import('drizzle-orm/better-sqlite3/migrator');migrate(db,{migrationsFolder:resolve('server/drizzle')})
const {createApp}=await import('./src/app.js');const app=createApp({logger:false});let checks=0
const check=(name:string,value:unknown)=>{assert.ok(value,name);checks++;console.log('PASS '+name)}
async function call(method:string,path:string,body?:unknown,status=200){const r=await app.inject({method:method as 'POST',url:'/api'+path,...(body===undefined?{}:{payload:body as object})});assert.equal(r.statusCode,status,method+' '+path+' '+r.body);return r.json()}
try{
 const def=await call('POST','/definitions',{name:'牛排测试',units:['个','克'],estimated_shelf_life_days:7},201)
 const stock=await call('POST','/ingredients',{definition_id:def.id,quantity:3,unit:'个',secondary_unit:'克',secondary_ratio:200,purchase_date:'2026-11-01',shelf_life_days:30},201)
 check('本批保质期计算',stock.expiry_date==='2026-12-01');check('默认保质期不变',(await call('GET','/definitions/'+def.id)).estimated_shelf_life_days===7)
 const second=await call('POST','/ingredients',{definition_id:def.id,quantity:2,unit:'个',secondary_unit:'克',secondary_ratio:300,purchase_date:'2026-11-01',shelf_life_days:30},201)
 check('不同换算关系不合并',second.id!==stock.id)
 for(const relation of [{secondary_unit:'个',secondary_ratio:200},{secondary_unit:'克',secondary_ratio:0},{secondary_unit:'克'},{secondary_ratio:200}])await call('POST','/ingredients',{definition_id:def.id,quantity:1,unit:'个',...relation},400)
 check('非法数量关系拒绝',true)
 const {createSessionWithDishes}=await import('./src/services/cookingService.js');const {previewSettlement,settleSession}=await import('./src/services/settlementService.js')
 const make=async(name:string,quantity:number,unit:string)=>call('POST','/recipes',{name,ingredients:[{definition_id:def.id,quantity,unit}],steps:['烹饪']},201)
 const recipe=await make('换算煎牛排',200,'克');const session=createSessionWithDishes([{recipe_id:recipe.id,servings:1}]);const before=JSON.stringify(await call('GET','/ingredients'));const preview=previewSettlement(session.id)
 check('克需求匹配个数库存',preview.items[0].available_quantity===1200&&preview.items[0].can_consume)
 check('结算预览不改库存',before===JSON.stringify(await call('GET','/ingredients')))
 settleSession(session.id);check('200克只扣1个',(await call('GET','/ingredients/'+stock.id)).quantity===2)
 const smallRecipe=await make('小量测试',1,'克');const smallSession=createSessionWithDishes([{recipe_id:smallRecipe.id,servings:1}]);settleSession(smallSession.id);check('小数换算不丢量',Math.abs((await call('GET','/ingredients/'+stock.id)).quantity-1.995)<1e-10)
 const beforeManual=(await call('GET','/ingredients/'+second.id)).quantity;await call('POST','/ingredients/'+second.id+'/consume',{amount:1/300});check('手动小量换算保留精度',Math.abs((await call('GET','/ingredients/'+second.id)).quantity-(beforeManual-1/300))<1e-10)
 const {evaluateCombination}=await import('./src/services/recommendationAlgorithm.js')
 const evaluated=evaluateCombination([{recipe_id:1,servings:1,recipe_name:'双单位测试',tags:[],lines:[{definition_id:def.id,definition_name:'牛排',quantity:3,unit:'个'},{definition_id:def.id,definition_name:'牛排',quantity:600,unit:'克'}]}],new Map([[def.id,[{definition_id:def.id,unit:'个',quantity:3,secondary_unit:'克',secondary_ratio:200,expiry_status:'normal'}]]]),new Map([[def.id,{is_seasoning:false,category_name:null}]]))
 check('同一份库存不能被两种单位重复占用',evaluated.missing_count>0)
 const all=await call('GET','/inventory-transfer');check('库存导出保留数量关系',all.rows.some((r:any)=>r.secondary_ratio===200))
 const dbBefore=JSON.stringify(sqlite.prepare('SELECT * FROM standard_ingredient').all());const defsBefore=JSON.stringify(sqlite.prepare('SELECT * FROM ingredient_definition').all())
 const row={name:'导入青菜',quantity:500,unit:'克',purchase_date:'2026-11-01',production_date:null,expiry_date:'2026-11-10',storage_method:'冷藏',note:'测试',secondary_unit:null,secondary_ratio:null,seasoning:false}
 const p=await call('POST','/inventory-transfer/preview',{rows:[row,row]});check('重复文件行仅新增一次',p.add===1&&p.skip===1);check('预览完整回滚试写',dbBefore===JSON.stringify(sqlite.prepare('SELECT * FROM standard_ingredient').all())&&defsBefore===JSON.stringify(sqlite.prepare('SELECT * FROM ingredient_definition').all()))
 const imported=await call('POST','/inventory-transfer/import',{rows:[row,row],token:p.token});check('整批确认仅新增一次',imported.added===1&&imported.skipped===1)
 const replay=await call('POST','/inventory-transfer/preview',{rows:[row]});check('重复导入跳过不加倍',replay.add===0&&replay.skip===1)
 const invalid={...row,name:'坏日期',production_date:'2027-01-01'};const bad=await call('POST','/inventory-transfer/preview',{rows:[{...row,name:'本不应创建'},invalid]});check('逐行显示错误',bad.errors===1&&bad.add===1)
 await call('POST','/inventory-transfer/import',{rows:[{...row,name:'本不应创建'},invalid],token:bad.token},400);check('有错整批不写',(await call('GET','/definitions')).every((d:any)=>d.name!=='本不应创建'))
 const stale=await call('POST','/inventory-transfer/preview',{rows:[{...row,name:'过期预览'}]});await call('POST','/ingredients/'+stock.id+'/consume',{amount:0.1});await call('POST','/inventory-transfer/import',{rows:[{...row,name:'过期预览'}],token:stale.token},409);check('库存变化须重新预览',true)
 const expired={...row,name:'已过期测试',production_date:'2026-10-01',expiry_date:'2026-10-03'};const exp=await call('POST','/inventory-transfer/preview',{rows:[expired]});check('历史已过期批次允许往返且不重置日期',exp.add===1&&exp.errors===0)
 await call('POST','/inventory-transfer/import',{rows:[expired],token:exp.token});check('历史到期日保留',(await call('GET','/inventory-transfer')).rows.some((r:any)=>r.name==='已过期测试'&&r.expiry_date==='2026-10-03'))
 console.log(JSON.stringify({passed:checks,database:temp}))
}finally{await app.close();sqlite.close()}
