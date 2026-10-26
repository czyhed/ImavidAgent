import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {createMinioClient} from '../../server/store.mjs';
import {backupLegacyObjects,verifyLegacyBackup,deleteLegacyObjects} from '../../server/legacy-files.mjs';
for(const file of ['.env.middleware.local','.env.models.local'])if(existsSync(file))process.loadEnvFile(file);
const args=process.argv.slice(2);
const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:null;
const planFile=value('--plan'),backup=value('--backup');
if(!planFile||!backup)throw new Error('用法：node scripts/maintenance/legacy-files.mjs --plan <私密清单> --backup <私密备份目录> [--delete]');
const maintenance=resolve(process.env.SJ_MAINTENANCE_DIR||'.secrets');
function privatePath(value){const path=resolve(value),part=relative(maintenance,path);if(part.startsWith('..')||isAbsolute(part))throw new Error('维护文件只能保存在指定私密维护目录。');return path;}
const path=privatePath(planFile),directory=privatePath(backup);
const plan=JSON.parse(await readFile(path,'utf8'));
const objects=plan.objects;
if(!Array.isArray(objects))throw new Error('旧文件清单格式无效。');
const {client}=createMinioClient();
if(args.includes('--delete')){
 if(process.env.SJ_LEGACY_CLEANUP_AUTHORIZED!=='2026-10-22-all-old-test-data')throw new Error('只允许已授权并完成备份的维护窗口执行。');
 const pending=JSON.parse(await readFile(path+'.files-pending','utf8'));
 if(JSON.stringify(pending)!==JSON.stringify(objects))throw new Error('数据库清理尚未完成，或文件清单不一致。');
 await verifyLegacyBackup(client,objects,directory,{allowMissing:true});
 const deleted=await deleteLegacyObjects(client,objects);
 await writeFile(path+'.files-deleted',JSON.stringify({deleted,completedAt:new Date().toISOString()}),{mode:0o600});
 console.log(JSON.stringify({mode:'files-deleted',versions:deleted}));
}else{
 const result=await backupLegacyObjects(client,objects,directory);
 console.log(JSON.stringify({mode:'files-backed-up',...result}));
}
