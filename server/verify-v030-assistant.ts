/** Isolated API contract + real shared recommendation + parser verification. No real DB imports before isolation. */
import { isDeepStrictEqual } from 'node:util'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeDbPath } from './src/db/safe-db-path.js'
import { parseAssistantInput } from '../client/src/assistant.js'

let checks = 0
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; console.log('PASS '+label) }
for (const text of ['两个人吃，清淡点', '今晚两个人吃，清淡点，半小时搞定', '不要辣，再简单点', '换掉汤', '看备料', '开始做饭', '改成十二个人']) check('识别 '+text, parseAssistantInput(text, { hasSelectedPlan: true }).ok)
for (const text of ['不是三个人', '两人，三人', '不要不辣', '不清淡', '两个人吃，删除库存', '13人', '换掉汤，重新开始', '明天三个人吃', '辣一点', '半小时搞定，删除库存']) check('拒绝 '+text, !parseAssistantInput(text).ok)
const naturalCases: Array<[string, object]> = [
 ['两个人简单吃吃', {people:2,simplify:true}], ['两个人简单吃吃就行', {people:2,simplify:true}],
 ['我们俩简简单单吃点吧', {people:2,simplify:true}], ['嗯两个人简单吃吃', {people:2,simplify:true}],
 ['两个人吃吃，清淡点吧啊', {people:2,light:true}], ['清清淡淡一点点', {light:true}],
 ['简单一点点', {simplify:true}], ['简单做做就好', {simplify:true}],
 ['两个人简单吃点', {people:2,simplify:true}], ['我们俩简单吃点', {people:2,simplify:true}],
 ['简单点两个人吃', {people:2,simplify:true}], ['今晚我们俩，简单吃点，别放辣', {people:2,simplify:true,no_spicy:true}],
 ['我俩吃清淡一点', {people:2,light:true}], ['两人份，做点简单的', {people:2,simplify:true}],
 ['还是太麻烦了', {simplify:true}], ['再省事一点吧', {simplify:true}], ['别太麻烦', {simplify:true}],
 ['再换一套', {action:'another'}], ['再换一个汤', {action:'replace-soup'}], ['再换个汤', {action:'replace-soup'}], ['再换一下汤', {action:'replace-soup'}],
 ['换成三个人', {people:3}], ['快手菜', {simplify:true}], ['不用太麻烦', {simplify:true}],
 ['汤换一个', {action:'replace-soup'}], ['这个汤不要了', {action:'replace-soup'}], ['不用清淡', {light:false}],
 ['不用简单的', {simplify:false}], ['就我一个人吃', {people:1}], ['清淡点，然后简单吃点', {light:true,simplify:true}],
 ['可以，就这个', {action:'start'}], ['辣不辣都行', {no_spicy:false}],
]
for(const [text,command] of naturalCases)check('自然表达 '+text,isDeepStrictEqual(parseAssistantInput(text,{hasSelectedPlan:true}),{ok:true,command}))
for(const text of ['两个人简单吃吃不要花生','简单吃吃但不要简单的','两个人简单吃吃少放盐','两个人吃吃辣','嗯不要辣但我想吃辣','不要简简单单的','不要清淡','不要太辣','少放点辣','不要吃太辣的','两个人简单吃点，不要香菜','不想换汤','别换掉汤','两个人，改成三人','清淡点，不用清淡','不要辣，辣不辣都行','简单点，不用简单','两个人或者三个人吃'])check('不猜测 '+text,!parseAssistantInput(text,{hasSelectedPlan:true,hasPlans:true}).ok)
check('没有上下文时换一个要澄清',!parseAssistantInput('换一个').ok)
check('没有选餐时可以不能直接开始',!parseAssistantInput('可以就这个').ok)
check('看过方案后省略换一套',JSON.stringify(parseAssistantInput('换一个',{hasPlans:true}))===JSON.stringify({ok:true,command:{action:'another'}}))
check('刚换过汤则继续换汤',JSON.stringify(parseAssistantInput('再换一个',{hasSelectedPlan:true,hasPlans:true,focus:'soup'}))===JSON.stringify({ok:true,command:{action:'replace-soup'}}))
check('清空方案后不能沿用汤指代',!parseAssistantInput('换一个',{focus:'soup'}).ok)
const root = dirname(fileURLToPath(import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'homechef-v030-'))
assert.equal(realpathSync(temp), resolve(temp))
process.env.HOME_CHEF_DB_PATH = assertSafeDbPath(join(temp,'test.db'),root)
const {db,sqlite} = await import('./src/db/index.js')
const {migrate} = await import('drizzle-orm/better-sqlite3/migrator')
const {createApp} = await import('./src/app.js')
migrate(db,{migrationsFolder:join(root,'drizzle')})
const app=createApp({logger:false})
async function call(method: string,url: string,body?: unknown,status=200) {
  const r=await app.inject({method:method as 'GET'|'POST'|'PUT'|'PATCH',url:'/api'+url,...(body===undefined?{}:{payload:body as object})})
  assert.equal(r.statusCode,status,method+' '+url+' '+r.body)
  return r.json()
}
try {
  const common=await call('POST','/definitions',{name:'测试青菜',units:['克']},201)
  const chili=await call('POST','/definitions',{name:'辣椒',units:['克']},201)
  await call('POST','/ingredients',{definition_id:common.id,quantity:250,unit:'克',storage_method:'冷藏'},201)
  const recipe=async(name:string,tags:string[],quantity=100,definition=common.id)=>call('POST','/recipes',{name,tags,ingredients:[{definition_id:definition,quantity,unit:'克'}],steps:['洗净食材','煮熟装盘']},201)
  const meat=await recipe('清淡荤菜',['荤菜','清淡','快手菜'])
  const vegetable=await recipe('清淡素菜',['素菜','清淡','快手菜'])
  const soup=await recipe('清汤甲',['汤','清淡','快手菜'])
  const soup2=await recipe('清汤乙',['汤','清淡','快手菜'],150)
  const spicy=await recipe('辣汤',['汤','辣','快手菜'],50,chili.id)
  const mislabeled=await recipe('错误清淡汤',['汤','清淡','快手菜'],50,chili.id)
  await recipe('未标注的菜',['素菜'])
  const stockBefore=JSON.stringify(await call('GET','/ingredients'))
  const countBefore=sqlite.prepare('SELECT count(*) n FROM cooking_session').get() as {n:number}
  const generate=(assistant:object={},people=2)=>call('POST','/recommendation/meal-plans',{people,assistant})
  const light=await generate({light:true,no_spicy:true,simple:1})
  check('有符合条件的方案',light.plans.length>0)
  check('不辣筛选有正向清淡标签且排除辣椒与未标注',light.plans.every((p:any)=>p.dishes.every((d:any)=>d.tags.includes('清淡')&&![spicy.id,mislabeled.id].includes(d.recipe_id))))
  const fresh=await generate({keep_recipe_ids:[meat.id,vegetable.id],exclude_recipe_ids:[soup.id],replacement_role:'soup'})
  check('只替换汤，保留其余菜',fresh.plans.length===1 && fresh.plans[0].dishes.some((d:any)=>d.recipe_id===soup2.id)&&[meat.id,vegetable.id].every(id=>fresh.plans[0].dishes.some((d:any)=>d.recipe_id===id)))
  const replacement=fresh.plans[0]
  check('共享食材整餐合并且正确报告缺料',replacement.requirements.some((r:any)=>r.definition_id===common.id&&r.required_quantity===350&&r.missing_quantity===100))
  check('稳定汤身份已提供',replacement.dishes.find((d:any)=>d.recipe_id===soup2.id).is_soup===true)
  const three=await generate({keep_recipe_ids:[meat.id,vegetable.id],exclude_recipe_ids:[soup.id],replacement_role:'soup'},3)
  check('改人数重算份量与快照',three.plans[0].snapshot_id!==replacement.snapshot_id&&three.plans[0].dishes.every((d:any)=>d.servings===1.5))
  const simple=await generate({simple:2})
  check('再次简化为两道快手菜',simple.plans.every((p:any)=>p.dishes.length===2&&p.dishes.every((d:any)=>d.tags.includes('快手菜'))))
  const empty=await generate({keep_recipe_ids:[meat.id,vegetable.id],exclude_recipe_ids:[soup.id,soup2.id,spicy.id,mislabeled.id],replacement_role:'soup'})
  check('无替代汤时不悄悄缩餐',empty.plans.length===0)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{simple:3}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{keep_recipe_ids:[meat.id,meat.id]}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{keep_recipe_ids:[meat.id],exclude_recipe_ids:[meat.id]}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{keep_recipe_ids:[999999]}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{fake:true}},400)
  check('非法条件与保留菜完整校验',true)
  check('选餐及换菜不改库存',stockBefore===JSON.stringify(await call('GET','/ingredients')))
  check('选餐及换菜不创建烹饪会话',(sqlite.prepare('SELECT count(*) n FROM cooking_session').get() as {n:number}).n===countBefore.n)
  const payload={people:2,dishes:replacement.dishes.map((d:any)=>({recipe_id:d.recipe_id,servings:d.servings})),snapshot_id:replacement.snapshot_id,request_id:'v030-assistant-isolated-test'}
  const applied=await call('POST','/recommendation/apply',payload)
  const replay=await call('POST','/recommendation/apply',payload)
  check('确认仍走原幂等入口',applied.session_id===replay.session_id&&replay.idempotent_replay)
  check('进入烹饪不预扣库存',stockBefore===JSON.stringify(await call('GET','/ingredients')))
  await call('POST','/ingredients',{definition_id:common.id,quantity:10,unit:'克',storage_method:'冷藏'},201)
  await call('POST','/recommendation/apply',{...payload,request_id:'v030-assistant-stale-snapshot'},409)
  check('库存变化后拒绝旧快照',true)
  const twoDish=await generate({keep_recipe_ids:[meat.id],exclude_recipe_ids:[soup.id],replacement_role:'soup'})
  check('两道菜的简餐换汤保持两道',twoDish.plans.length>0&&twoDish.plans[0].dishes.length===2)
  const soupOnly=await generate({exclude_recipe_ids:[soup.id],replacement_role:'soup'})
  check('仅一道汤也可替换',soupOnly.plans.length>0&&soupOnly.plans[0].dishes.length===1&&soupOnly.plans[0].dishes[0].is_soup)
  sqlite.prepare("UPDATE recipe_tag SET name='煲汤',name_normalized='煲汤' WHERE code='dish_type.soup'").run()
  const renamed=await generate({keep_recipe_ids:[meat.id,vegetable.id],exclude_recipe_ids:[soup.id],replacement_role:'soup'})
  check('汤标签改名后仍可正确替换',renamed.plans.length>0&&renamed.plans[0].dishes.some((d:any)=>d.is_soup&&d.tags.includes('煲汤')))
  sqlite.prepare("UPDATE recipe_tag SET name='清爽',name_normalized='清爽' WHERE code='flavor.light'").run()
  const renamedLight=await generate({light:true,no_spicy:true})
  check('清淡标签改名后稳定身份仍有效',renamedLight.plans.length>0&&renamedLight.plans.every((p:any)=>p.dishes.every((d:any)=>d.tags.includes('清爽'))))
  // Exceed the normal 40-recipe window, then pin a late recipe that would otherwise be truncated.
  for(let i=0;i<42;i++) await recipe('候选汤'+i,['煲汤'],1)
  const late=await recipe('必须保留的后置主菜',['荤菜'],1000)
  const truncated=await generate({keep_recipe_ids:[late.id,vegetable.id],replacement_role:'soup'})
  check('候选截断仍保留指定菜且不退回旧汤',truncated.candidate_truncated&&truncated.plans.length>0&&truncated.plans[0].dishes.some((d:any)=>d.recipe_id===late.id)&&truncated.plans[0].dishes.length===3)
  check('外键与数据库完整性',sqlite.pragma('foreign_key_check').length===0&&sqlite.pragma('integrity_check',{simple:true})==='ok')
  const beforeUndoStock=JSON.stringify(await call('GET','/ingredients'))
  const beforeUndoSessions=(sqlite.prepare('SELECT count(*) n FROM cooking_session').get() as {n:number}).n
  const originalIds=[meat.id,vegetable.id,soup.id]
  const restore=await generate({exact_keep:true,keep_recipe_ids:originalIds})
  check('撤回重算仅返回原三道菜',restore.plans.length===1&&restore.plans[0].dishes.length===3&&originalIds.every(id=>restore.plans[0].dishes.some((d:any)=>d.recipe_id===id)))
  const twoRestore=await generate({exact_keep:true,keep_recipe_ids:[meat.id,soup.id]})
  check('两道菜撤回不擅自补第三道',twoRestore.plans.length===1&&twoRestore.plans[0].dishes.length===2)
  const oneRestore=await generate({exact_keep:true,keep_recipe_ids:[soup.id]})
  check('一道汤撤回不擅自加菜',oneRestore.plans.length===1&&oneRestore.plans[0].dishes.length===1)
  check('撤回重算不改库存或建会话',beforeUndoStock===JSON.stringify(await call('GET','/ingredients'))&&beforeUndoSessions===(sqlite.prepare('SELECT count(*) n FROM cooking_session').get() as {n:number}).n)
  await call('POST','/ingredients',{definition_id:common.id,quantity:7,unit:'克',storage_method:'冷藏'},201)
  const changedRestore=await generate({exact_keep:true,keep_recipe_ids:originalIds})
  check('撤回使用新库存生成新快照',changedRestore.plans[0].snapshot_id!==restore.plans[0].snapshot_id)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{exact_keep:true,keep_recipe_ids:[]}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{exact_keep:true,keep_recipe_ids:originalIds,replacement_role:'soup'}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{exact_keep:true,keep_recipe_ids:originalIds,exclude_recipe_ids:[soup2.id]}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{exact_keep:'true',keep_recipe_ids:originalIds}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{exact_keep:true,keep_recipe_ids:[999999]}},400)
  check('撤回清单及组合参数严格校验',true)
  const beef=await call('POST','/definitions',{name:'牛肉',units:['克']},201)
  const existingTags=await call('GET','/tags')
  for(const name of ['川菜','西餐'])if(!existingTags.some((t:any)=>t.name===name))await call('POST','/tags',{name,category:'cuisine'},201)
  const beefDish=await recipe('川式牛肉',['荤菜','川菜','清爽','快手菜'],80,beef.id)
  await recipe('川式青菜',['素菜','川菜','清爽','快手菜'])
  await recipe('川式清汤',['煲汤','川菜','清爽','快手菜'])
  await recipe('西式牛肉',['荤菜','西餐','清爽','快手菜'],80,beef.id)
  const beefBefore=JSON.stringify(await call('GET','/ingredients'))
  const beefPlans=await generate({ingredients:['牛肉'],cuisine:'川菜'})
  check('川菜牛肉要求从菜谱和标签筛选',beefPlans.plans.length>0&&beefPlans.plans.every((p:any)=>p.dishes.every((d:any)=>d.tags.includes('川菜'))&&p.dishes.some((d:any)=>d.recipe_id===beefDish.id)))
  check('指定食材不要求所有配菜都含牛肉',beefPlans.plans.some((p:any)=>p.dishes.some((d:any)=>!d.ingredients.some((i:any)=>i.definition_name==='牛肉'))))
  check('指定食材不伪造库存已有',beefPlans.plans.every((p:any)=>p.requirements.some((r:any)=>r.definition_id===beef.id&&r.missing_quantity>0)))
  const western=await generate({ingredients:['牛肉'],cuisine:'西餐'})
  check('西餐不混入川菜',western.plans.length>0&&western.plans.every((p:any)=>p.dishes.every((d:any)=>d.tags.includes('西餐'))))
  const absent=await generate({ingredients:['不存在的食材'],cuisine:'川菜'})
  check('指定食材无匹配不放宽',absent.plans.length===0)
  const absentCuisine=await generate({cuisine:'不存在的菜系'})
  check('菜系无匹配不放宽',absentCuisine.plans.length===0)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{ingredients:['牛肉','牛肉']}},400)
  await call('POST','/recommendation/meal-plans',{people:2,assistant:{ingredients:[1]}},400)
  check('食材要求参数严格校验',true)
  check('食材菜系筛选不改库存',beefBefore===JSON.stringify(await call('GET','/ingredients')))
  console.log(JSON.stringify({passed:checks,isolatedDatabase:process.env.HOME_CHEF_DB_PATH}))
} finally { await app.close();sqlite.close() }
