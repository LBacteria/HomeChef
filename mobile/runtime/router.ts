import { registerContentRoutes } from '@homechef/server/src/routes/content';
import Ajv from 'ajv';
import { registerErrorHandler } from '@homechef/server/src/routes/errorHandler';
import { registerDefinitionRoutes } from '@homechef/server/src/routes/definitions';
import { registerIngredientRoutes } from '@homechef/server/src/routes/ingredients';
import { registerSettingsRoutes } from '@homechef/server/src/routes/settings';
import { registerCategoryRoutes } from '@homechef/server/src/routes/categories';
import { registerRecipeRoutes } from '@homechef/server/src/routes/recipes';
import { registerCookingRoutes } from '@homechef/server/src/routes/cooking';
import { registerRecommendationRoutes } from '@homechef/server/src/routes/recommendation';

const ajv = new Ajv({ coerceTypes:false, removeAdditional:false, useDefaults:true, strict:false, allErrors:true });
type Handler = (request:any, reply:any)=>unknown;
const routes:{method:string;path:string;parts:string[];handler:Handler;validators:Record<string,any>}[]=[];
let errorHandler:(error:any,request:any,reply:any)=>unknown, notFound:Handler;
const app:any={setErrorHandler(fn:typeof errorHandler){errorHandler=fn;},setNotFoundHandler(fn:Handler){notFound=fn;}};
for(const method of ['get','post','put','patch','delete']) app[method]=(path:string, options:any, handler?:Handler)=>{
 const fn=handler??options;const schema=handler?options.schema??{}:{};
 const validators=Object.fromEntries(Object.entries(schema).filter(([k])=>['body','querystring','params'].includes(k)).map(([k,v])=>[k,ajv.compile(v as object)]));
 routes.push({method:method.toUpperCase(),path,parts:path.split('/'),handler:fn,validators});
};
registerErrorHandler(app); registerDefinitionRoutes(app); registerIngredientRoutes(app); registerSettingsRoutes(app); registerCategoryRoutes(app); registerRecipeRoutes(app); registerCookingRoutes(app); registerRecommendationRoutes(app);
registerContentRoutes(app);
// Match static endpoints before dynamic :id entries, as Fastify does.
routes.sort((a,b)=>a.parts.filter(p=>p.startsWith(':')).length-b.parts.filter(p=>p.startsWith(':')).length);
let pending=Promise.resolve();
export async function localRequest(path:string,init:RequestInit={}):Promise<Response>{
 const run=async()=>{
  const method=(init.method??'GET').toUpperCase(),url=new URL(path,'https://localhost');const parts=url.pathname.split('/');
  let match:any,params:Record<string,string>={};
  for(const route of routes){if(route.method!==method||route.parts.length!==parts.length)continue;const values:Record<string,string>={};if(route.parts.every((p,i)=>p.startsWith(':')?(values[p.slice(1)]=decodeURIComponent(parts[i]),true):p===parts[i])){match=route;params=values;break;}}
  const query:Record<string,any>=Object.create(null);for(const [key,value]of url.searchParams){if(key in query)query[key]=Array.isArray(query[key])?[...query[key],value]:[query[key],value];else query[key]=value;}
  const request:any={method,url:path,params,query,body:undefined,log:{error:(e:unknown)=>console.error(e)}};
  let status=200,body:unknown,sent=false;
  const reply:any={code(code:number){status=code;return this;},send(value:unknown){body=value;sent=true;return this;}};
  try{
   if(init.body!==undefined){if(typeof init.body!=='string')throw Object.assign(Error('请求内容格式错误'),{statusCode:400});if(init.body.length>1048576)throw Object.assign(Error('请求内容过大'),{statusCode:400});try{request.body=JSON.parse(init.body);}catch{throw Object.assign(Error('JSON格式错误'),{statusCode:400});}}
   if(match){for(const [key,validate]of Object.entries(match.validators)as[string,any][]){if(!validate(request[key==='querystring'?'query':key]))throw Object.assign(Error(ajv.errorsText(validate.errors)),{validation:validate.errors,statusCode:400});}const result=await match.handler(request,reply);if(!sent&&result!==reply){body=result;}}
   else await notFound(request,reply);
  }catch(error){await errorHandler(error as any,request as any,reply as any);}
  if(status>=500 && body && typeof body==='object' && 'error' in body) body={error:{code:'INTERNAL_ERROR',message:'本地操作未完成，请重新打开应用后重试'}};
  return new Response(status===204?null:JSON.stringify(body??null),{status,headers:{'content-type':'application/json'}});
 };
 const result=pending.then(run);pending=result.then(()=>{},()=>{});return result;
}
