import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
const here=(name)=>fileURLToPath(new URL(name,import.meta.url));
const sourceRoot=path.resolve(process.env.HOME_CHEF_SOURCE_ROOT||here('../'));
const overrides={ 'client/src/App.tsx':'App.tsx','client/src/api/definitions.ts':'definitions.ts','client/src/pages/SettingsPage.tsx':'SettingsPage.tsx','server/src/db/index.ts':'db.ts','server/src/services/faultInjection.ts':'faultInjection.ts' };
const known=JSON.parse(fs.readFileSync(here('./overrides/baseline.json'),'utf8'));
for(const [relative,expected] of Object.entries(known)){const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,relative))).digest('hex');if(actual!==expected)throw Error('Shared source changed; review Android override before rebuilding: '+relative);}
const journal=JSON.parse(fs.readFileSync(path.join(sourceRoot,'server/drizzle/meta/_journal.json'),'utf8'));
const migrations=journal.entries.map(entry=>({...entry,source:fs.readFileSync(path.join(sourceRoot,`server/drizzle/${entry.tag}.sql`),'utf8')}));
export default defineConfig({plugins:[{
 name:'homechef-mobile-platform',enforce:'pre',
 resolveId(id){if(id==='virtual:homechef-migrations')return '\0homechef-migrations';},
 load(id){if(id==='\0homechef-migrations')return 'export default '+JSON.stringify(migrations);const key=path.relative(sourceRoot,id.split('?')[0]).replaceAll('\\','/');if(overrides[key])return fs.readFileSync(here('./overrides/'+overrides[key]),'utf8');}
},react()],resolve:{dedupe:['react','react-dom','react-colorful','drizzle-orm'],alias:[{find:'@homechef',replacement:sourceRoot},{find:'@mobile',replacement:here('./runtime')},{find:'better-sqlite3',replacement:here('./runtime/native-database.ts')},{find:'node:crypto',replacement:here('./runtime/crypto.ts')}]},define:{'process.env.HOME_CHEF_FAULT_INJECT':'undefined'},build:{target:'es2022'}});
