import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {createPool} from '../../server/store.mjs';
import {previewLegacyCleanup,applyLegacyCleanup} from '../../server/legacy-cleanup.mjs';
for(const file of ['.env.middleware.local','.env.models.local'])if(existsSync(file))process.loadEnvFile(file);
const args=process.argv.slice(2);const apply=args.includes('--apply');const target=args[args.indexOf('--plan')+1];
if(!args.includes('--plan')||!target)throw new Error('用法：node scripts/maintenance/cleanup-legacy.mjs --plan .secrets/legacy-cleanup.json [--apply]');
const path=resolve(target);
const part=relative(resolve(process.env.SJ_MAINTENANCE_DIR||'.secrets'),path);if(part.startsWith('..')||isAbsolute(part))throw new Error('清理清单必须保存在私密目录。');
const pool=createPool();
try{
 if(!apply){
  const plan=await previewLegacyCleanup(pool);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(plan,null,2),{mode:0o600});
  console.log(JSON.stringify({mode:'preview',tables:plan.tables,objectCount:plan.objects.length,digest:plan.digest}));
 }else{
  if(process.env.SJ_LEGACY_CLEANUP_AUTHORIZED!=='2026-10-22-all-old-test-data')throw new Error('仅允许明确授权的维护窗口执行；先备份并停应用。');
  const plan=JSON.parse(await readFile(path,'utf8'));
  const result=await applyLegacyCleanup(pool,plan);await writeFile(path+'.files-pending',JSON.stringify(result.objects,null,2),{mode:0o600});
  console.log(JSON.stringify({mode:'applied',removed:result.removed,pendingFiles:result.objects.length}));
 }
}finally{await pool.end();}
