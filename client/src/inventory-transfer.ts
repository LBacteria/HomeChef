import { request } from './api/definitions'
export interface TransferRow {name:string;quantity:number;unit:string;purchase_date:string;production_date:string|null;expiry_date:string|null;storage_method:string;note:string|null;secondary_unit:string|null;secondary_ratio:number|null;seasoning:boolean}
export interface TransferData {version:1;rows:TransferRow[]}
export interface ImportPreview {token:string;add:number;skip:number;errors:number;rows:Array<{row:number;name:string;status:'add'|'skip'|'error';message:string}>}
export const exportStock = () => request<TransferData>('/inventory-transfer')
export const previewStock = (rows:TransferRow[]) => request<ImportPreview>('/inventory-transfer/preview',{method:'POST',body:JSON.stringify({rows})})
export const importStock = (rows:TransferRow[],token:string) => request<{added:number;skipped:number}>('/inventory-transfer/import',{method:'POST',body:JSON.stringify({rows,token})})
function checksum(text:string) {let n=2166136261;for(let i=0;i<text.length;i++) n=Math.imul(n^text.charCodeAt(i),16777619);return (n>>>0).toString(16).padStart(8,'0')}
export function encodeStock(data:TransferData) {
 const json=JSON.stringify([1,data.rows.map(r=>[r.name,r.quantity,r.unit,r.purchase_date,r.production_date,r.expiry_date,r.storage_method,r.note,r.secondary_unit,r.secondary_ratio,r.seasoning])])
 const bytes=new TextEncoder().encode(json);let binary='';for(const b of bytes)binary+=String.fromCharCode(b)
 return 'HC1.'+btoa(binary)+'.'+checksum(json)
}
export function decodeStock(code:string):TransferRow[] {
 const text=code.trim();if(text.length>900000)throw Error('库存码过长，一次最多导入 2000 条')
 const match=/^HC1\.([A-Za-z0-9+/=]+)\.([a-f0-9]{8})$/.exec(text);if(!match)throw Error('不是 HomeChef 库存码，请完整复制 HC1 开头的内容')
 try {const bytes=Uint8Array.from(atob(match[1]),c=>c.charCodeAt(0));const json=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(checksum(json)!==match[2])throw Error();const data=JSON.parse(json);if(data[0]!==1||!Array.isArray(data[1])||!data[1].length||data[1].length>2000)throw Error();return data[1].map((r:unknown[])=>{if(!Array.isArray(r)||r.length!==11)throw Error();const [name,quantity,unit,purchase_date,production_date,expiry_date,storage_method,note,secondary_unit,secondary_ratio,seasoning]=r;return {name,quantity,unit,purchase_date,production_date,expiry_date,storage_method,note,secondary_unit,secondary_ratio,seasoning} as TransferRow})}catch{throw Error('库存码不完整或内容已损坏，请重新复制')}
}
const headers=['食材名称','数量','单位','入库日期','生产日期','到期日期','储存方式','备注','另一单位','每单位换算值','调味品']
export async function stockWorkbook(rows:TransferRow[]) {
 const module=await import('exceljs');const ExcelJS=module.default ?? module;const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('库存');sheet.addRow(headers)
 for(const r of rows)sheet.addRow([r.name,r.quantity,r.unit,r.purchase_date,r.production_date??'',r.expiry_date??'',r.storage_method,r.note??'',r.secondary_unit??'',r.secondary_ratio??'',r.seasoning?'是':'否'])
 sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter='A1:K1';sheet.columns.forEach((c,i)=>{c.width=[20,12,10,15,15,15,13,30,12,18,12][i]});sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF355C59'}}
 sheet.getCell('A1').note='一行一批库存；新增食材会一并建立。已有批次默认跳过，不覆盖本机数量。'
 sheet.getCell('D1').note='日期格式 YYYY-MM-DD；必填。生产日期可留空。'
 sheet.getCell('F1').note='填写实际到期日；留空表示本批不设置到期日，不使用默认保质期。'
 sheet.getCell('J1').note='1 个当前单位等于多少另一单位。例如数量3、单位个、另一单位克、换算值200，表示总计600克。另一单位和换算值要同时填写或留空。'
 sheet.getCell('K1').note='普通食材填否，调味品填是。'
 return new Uint8Array(await book.xlsx.writeBuffer())
}
export async function readStockWorkbook(bytes:ArrayBuffer):Promise<TransferRow[]> {
 const module=await import('exceljs');const ExcelJS=module.default ?? module;const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);const sheet=book.getWorksheet('库存');if(!sheet)throw Error('缺少“库存”工作表，请使用下载的模板')
 if(sheet.rowCount>2001||sheet.columnCount>11)throw Error('模板最多 2000 行库存和 11 列，请拆分后再导入')
 for(let i=0;i<headers.length;i++)if(sheet.getCell(1,i+1).value!==headers[i])throw Error('表头不匹配，请保留模板第一行和列顺序')
 function cell(row:number,col:number):string|number {const v=sheet!.getCell(row,col).value;if(v==null)return '';if(v instanceof Date)return v.toISOString().slice(0,10);if(typeof v==='string'||typeof v==='number')return v;throw Error('第 '+row+' 行包含公式、链接或特殊单元格，请改为普通文字/数字')}
 const rows:TransferRow[]=[]
 for(let n=2;n<=sheet.rowCount;n++){const v=headers.map((_,i)=>cell(n,i+1));if(v.every(x=>x===''))continue;const number=(x:string|number)=>x===''?NaN:Number(x);if(!['是','否'].includes(String(v[10])))throw Error('第 '+n+' 行调味品请填写“是”或“否”');rows.push({name:String(v[0]).trim(),quantity:number(v[1]),unit:String(v[2]).trim(),purchase_date:String(v[3]).trim(),production_date:v[4]===''?null:String(v[4]).trim(),expiry_date:v[5]===''?null:String(v[5]).trim(),storage_method:String(v[6]).trim(),note:v[7]===''?null:String(v[7]),secondary_unit:v[8]===''?null:String(v[8]).trim(),secondary_ratio:v[9]===''?null:number(v[9]),seasoning:v[10]==='是'})}
 return rows
}
declare global {interface Window {homechefSaveFile?:(name:string,mime:string,bytes:Uint8Array)=>Promise<boolean>}}
export async function saveStockFile(name:string,mime:string,bytes:Uint8Array) {
 if(window.homechefSaveFile)return window.homechefSaveFile(name,mime,bytes)
 const blob=new Blob([bytes.slice().buffer],{type:mime});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return true
}
