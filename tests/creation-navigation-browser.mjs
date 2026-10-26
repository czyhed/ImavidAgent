import {chromium,expect} from '@playwright/test';
import {startCreationApp} from './creation-app-fixture.mjs';
const app=await startCreationApp();let browser;const failures=[];
try {
 browser=await chromium.launch({headless:true,channel:'msedge'});
 let page=await browser.newPage({viewport:{width:1440,height:1000}});
 const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.log('FAIL '+name+': '+e.message);}};
 await check('template dirty form survives browser back cancellation',async()=>{
  await page.goto(app.origin);await page.locator('[data-nav=assets]').click();
  await page.getByRole('button',{name:'提示词与参数模板',exact:true}).click();
  await page.getByRole('button',{name:'新建模板',exact:true}).click();
  await page.getByLabel('模板名称',{exact:true}).fill('未保存模板');
  await page.getByLabel('提示词',{exact:true}).fill('不能丢失的提示词');
  let prompts=0;const dismiss=async d=>{prompts++;await d.dismiss();};page.on('dialog',dismiss);
  await page.evaluate(()=>{window.qaConfirms=[];window.confirm=message=>{window.qaConfirms.push(message);return false;};history.back();});await expect(page.getByRole('textbox',{name:'提示词',exact:true})).toHaveValue('不能丢失的提示词');
  const confirms=await page.evaluate(()=>window.qaConfirms);if(confirms.length!==1)throw new Error('Expected browser back to warn: '+JSON.stringify(confirms));
  page.off('dialog',dismiss);
 });
 await check('project can enter trash and be restored from App controls',async()=>{
  const created=await app.api('/api/creation/projects',{name:'项目回收测试'});
  await page.close();page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(app.origin+'/?screen=projects');
  const row=page.locator('.cp-project-row').filter({has:page.getByText('项目回收测试',{exact:true})});
  await expect(row.getByRole('button',{name:'移入回收站',exact:true})).toBeVisible();
  await row.getByRole('button',{name:'移入回收站',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'移入回收站',exact:true}).click();
  await expect(row).toHaveCount(0);
  const trashed=await app.api('/api/creation/trash');
  if(!trashed.items.some(p=>p.id===created.project.id))throw new Error('Project was not persisted in trash');
  await page.locator('.topnav-right').getByRole('button',{name:'回收站',exact:true}).click();
  const tr=page.getByRole('row').filter({has:page.getByRole('cell',{name:'项目回收测试',exact:true})});
  await tr.getByRole('button',{name:'恢复',exact:true}).click();
  await page.locator('[data-nav=projects]').click();await expect(page.getByText('项目回收测试',{exact:true})).toBeVisible();
 });
 if(failures.length)throw new Error(failures.join(String.fromCharCode(10)));
}finally{await browser?.close();await app.stop();}
