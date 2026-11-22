// 真实Chromium中验证本机原型；不代表原生App、服务器或儿童内容验收。
const {chromium}=require('../.work/design-tooling/node_modules/playwright-core');
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const base='file:///'+path.join(root,'prototype/v2/index.html').replace(/\\/g,'/');
const out=path.join(root,'deliverables/v2/screens');fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[];
const ok=(name,details='')=>{checks.push({name,passed:true,details});process.stdout.write('PASS '+name+'\n');};
const executable=process.env.BABYPLAN_CHROMIUM||'C:/Users/Heart/AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe';
let browser;
async function scenario(page,value){await page.selectOption('#scenario',value,{force:true});}
async function state(page){return page.evaluate(()=>window.BabyPlanDemo.getState());}
async function goto(page,hash,surface='mobile'){await page.goto(`${base}?surface=${surface}&embed=${surface==='mobile'?'1':'0'}#${hash}`);await page.waitForFunction(()=>!!window.BabyPlanDemo);}
async function overflow(page){return page.evaluate(()=>({page:document.documentElement.scrollWidth>innerWidth+2,controls:[...document.querySelectorAll('button,input,select,.hero-meta')].filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+3).map(e=>({tag:e.tagName,text:e.textContent.slice(0,50),scroll:e.scrollWidth,client:e.clientWidth})).slice(0,10)}));}
(async()=>{
  browser=await chromium.launch({headless:true,executablePath:executable});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  for(const [name,hash] of [['today','today'],['detail','activity/roll/d1-1'],['discover','discover'],['stage','stage'],['growth','growth'],['settings','settings'],['week','week'],['start','start'],['measurements','measurements']]){
    await goto(p,hash);assert((await p.locator('main h1').count())>=1,name);const o=await overflow(p);assert(!o.page,JSON.stringify({name,o}));await p.screenshot({path:path.join(out,`mobile-${name}.png`)});
  }
  ok('9 mobile routes render at 390px without page overflow');
  await goto(p,'activity/roll/d1-1');await p.locator('[data-action="record"]').click();
  await p.locator('#sheet textarea[name="note"]').fill('来回滚了几次，宝宝还想再玩。');
  await p.locator('#sheet input[value="partner"]').check();await p.screenshot({path:path.join(out,'mobile-record.png')});
  await p.locator('#sheet button[type="submit"]').click();assert((await state(p)).records['d1-1'].participants.length===2);
  await p.reload();assert((await state(p)).records['d1-1'].note.includes('来回'));
  ok('Record participants and note persist after reload');
  await goto(p,'today');await p.locator('[data-action="mode"]').click();await p.locator('#confirm-mode').click();
  let items=await p.evaluate(()=>window.BabyPlanDemo.getDayItems());assert(items.length===4);assert((await state(p)).records['d1-1'].note.includes('来回'));assert(items.find(i=>i.id==='d1-1').minutes===15);
  await p.locator('[data-action="mode"]').click();await p.locator('#confirm-mode').click();assert((await p.evaluate(()=>window.BabyPlanDemo.getDayItems())).length===6);
  ok('Light mode and restore protect existing record and budget');
  await goto(p,'activity/basket/d1-2');await p.locator('[data-action="replace"]').click();await p.locator('[data-replace="cups"]').click();assert((await state(p)).replacements['d1-2']==='cups');
  ok('Replace only selected unrecorded activity');
  await goto(p,'activity/clap/d2-1');assert(await p.locator('[data-action="record"]').isDisabled());await p.reload();assert(await p.locator('[data-action="record"]').isDisabled());
  ok('Future date remains read-only after direct link and reload');
  await goto(p,'discover');await p.locator('#activity-search').fill('小熊');assert((await p.locator('.library-card').count())>0);assert((await p.locator('.library-card').count())<24);await p.locator('#activity-search').fill('没有这个名称');assert(await p.getByText('还没有找到这个玩法').isVisible());
  ok('Activity search filters and has an honest empty state');
  await goto(p,'activity/cups/d1-2');await scenario(p,'offline');await p.locator('[data-action="record"]').click();await p.locator('#sheet textarea[name="note"]').fill('离线记录');await p.locator('#sheet button[type="submit"]').click();assert((await state(p)).records['d1-2'].sync==='pending');
  ok('Offline simulation saves pending record locally');
  await goto(p,'activity/page/d1-3');await scenario(p,'conflict');await p.locator('[data-action="record"]').click();await p.locator('#sheet textarea[name="note"]').fill('我这边的观察');await p.locator('#sheet button[type="submit"]').click();await p.getByText('稍后决定，先保留草稿',{exact:true}).click();await p.reload();assert((await state(p)).conflictDraft.mine.note==='我这边的观察');await p.locator('[data-action="resume-conflict"]').click();await p.locator('[data-merge="both"]').click();assert((await state(p)).records['d1-3'].note.includes('我这边的观察'));assert((await state(p)).records['d1-3'].note.includes('另一位家长'));assert(!(await state(p)).conflictDraft);
  ok('Conflict survives cancel/reload and retains both notes on merge');
  await goto(p,'growth');await p.locator('[data-action="memory"]').first().click();await p.locator('#sheet select[name="type"]').selectOption('first');await p.locator('#sheet textarea').fill('第一次主动把书递给我。');await p.locator('#sheet button[type="submit"]').click();assert(await p.getByText('请由家长确认第一次，或者改成小故事。').isVisible());await p.locator('#sheet input[name="first"]').check();await p.locator('#sheet input[name="photo"]').check();await p.locator('#sheet button[type="submit"]').click();assert((await state(p)).memories[0].type==='first');assert(await p.getByText('照片占位 · 尚未上传').isVisible());
  ok('First memory requires parent confirmation; photo remains a placeholder');
  await goto(p,'measurements');await p.locator('[data-action="measurement"]').click();await p.locator('#sheet input[name="value"]').fill('83.5');await p.locator('#sheet button[type="submit"]').click();assert((await state(p)).measurements[0].value===83.5);assert(await p.locator('svg.trend circle').count()===1);assert(await p.locator('svg.trend polyline').count()===0);
  ok('Measurement creates one real point, no invented trend or percentile');
  await p.locator('[data-action="measurement"]').click();await p.locator('#sheet input[name="value"]').fill('84');await p.locator('#measure-method').selectOption({label:'站立身高'});await p.locator('#sheet button[type="submit"]').click();await p.locator('[data-action="measurement"]').click();await p.locator('#measure-kind').selectOption('weight');await p.locator('#sheet input[name="value"]').fill('11.2');await p.locator('#sheet button[type="submit"]').click();assert(await p.locator('svg.trend').count()===3);assert(await p.locator('svg.trend polyline').count()===0);
  ok('Height/length methods and weight are plotted separately');
  await goto(p,'settings');await p.locator('[data-action="reminder"]').click();for(let n=0;n<9;n++){await p.keyboard.press('Tab');assert(await p.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)));}await p.keyboard.press('Escape');assert(!(await p.locator('#sheet').isVisible()));
  ok('Dialog traps keyboard focus and Escape closes');
  await scenario(p,'error');await goto(p,'today');await scenario(p,'error');assert(await p.getByText('暂时没取到安排').isVisible());await p.locator('[data-action="retry"]').click();assert(await p.locator('.hero-card').isVisible());
  ok('Loading failure recovers without becoming empty content');
  const downloadPromise=p.waitForEvent('download');await goto(p,'settings');await p.locator('[data-action="export"]').click();await p.locator('#download-json').click();const download=await downloadPromise;const downloadPath=await download.path();const exported=JSON.parse(fs.readFileSync(downloadPath,'utf8'));assert(exported.kind==='babyplan-design-demo');assert(exported.missingMedia.length===1);
  ok('Export produces JSON with missing-media manifest');
  // 清洁上下文截图，防止自动化输入混入交付图。
  const clean=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});const d=await clean.newPage();d.on('pageerror',e=>errors.push(e.message));
  for(const [name,hash,surface] of [['parent-today','today','parent'],['parent-week','week','parent'],['parent-books','books','parent'],['admin-library','library','admin'],['admin-editor','editor/roll','admin'],['admin-review','review','admin'],['admin-releases','releases','admin']]){await goto(d,hash,surface);const o=await overflow(d);assert(!o.page,JSON.stringify({name,o}));await d.screenshot({path:path.join(out,name+'.png')});}
  ok('Parent and admin desktop routes render at 1440px');
  await goto(d,'editor/roll','admin');await d.locator('[name="title"]').fill('大软球，慢慢滚');await d.locator('[name="opening"]').fill('球来啦，我们慢慢接。');await d.locator('[name="note"]').fill('把开场表达写得更短。');await d.locator('[data-action="submit-review"]').click();assert((await state(d)).admin.status==='review');assert(await d.locator('[data-action="approve-review"]').isDisabled());await d.selectOption('#admin-role','reviewer');await d.locator('[data-action="approve-review"]').click();assert((await state(d)).admin.status==='review');for(let i=0;i<4;i++)await d.locator(`[data-check="${i}"]`).check();await d.locator('[data-action="approve-review"]').click();assert((await state(d)).admin.status==='approved');await d.locator('[data-action="go"][data-path="releases"]').click();assert(await d.locator('[data-action="publish"]').isDisabled());await d.selectOption('#admin-role','publisher');await d.locator('[data-action="publish"]').click();await d.locator('#confirm-publish').click();assert((await state(d)).admin.status==='published');await d.locator('[data-action="withdraw"]').click();await d.locator('#sheet textarea').fill('材料说明需要补充，演示安全撤回。');await d.locator('#sheet button[type="submit"]').click();assert((await state(d)).admin.status==='withdrawn');assert((await state(d)).admin.releases.length===2);
  ok('Editor/reviewer/publisher gating, checklist, publish and withdrawal flow');
  const layouts=[];
  for(const width of [360,390,430]){
    await p.setViewportSize({width,height:900});
    for(const hash of ['today','activity/roll/d1-1','discover','stage','growth','settings']){
      await goto(p,hash);await p.selectOption('#font-scale','2',{force:true});await p.selectOption('#theme','dark',{force:true});const o=await overflow(p);layouts.push({width,hash,...o});
    }
  }
  const layoutErrors=layouts.filter(x=>x.page||x.controls.length);if(layoutErrors.length)process.stdout.write('LAYOUT_WARN '+JSON.stringify(layoutErrors)+'\n');
  assert(!layouts.some(x=>x.page),'200% text produces page overflow');
  ok('18 mobile large-text/dark layout checks',JSON.stringify({controlOverflowWarnings:layoutErrors.length}));
  const largeContext=await browser.newContext({viewport:{width:430,height:900},deviceScaleFactor:1});const largePage=await largeContext.newPage();await goto(largePage,'today');await largePage.selectOption('#font-scale','2',{force:true});await largePage.selectOption('#theme','dark',{force:true});await largePage.screenshot({path:path.join(out,'mobile-large-dark.png')});await largeContext.close();
  for(const width of [768,360]){await d.setViewportSize({width,height:1000});for(const surface of ['parent','admin']){await goto(d,surface==='admin'?'library':'today',surface);assert(!(await overflow(d)).page,`${surface} ${width}`);}}
  ok('Parent/admin responsive layout at 768 and 360px');
  await d.setViewportSize({width:1440,height:1000});await goto(d,'week','parent');await d.emulateMedia({media:'print'});assert(await d.locator('.reviewbar').isHidden());assert(await d.locator('.desktop-sidebar').isHidden());assert(await d.locator('.week-card').count()===7);await d.emulateMedia({media:'screen'});
  ok('Print styling retains seven day cards and hides navigation');
  assert.equal(errors.length,0,errors.join('\n'));ok('No JavaScript page errors');
  const report={checkedOn:'2026-11-13',browser:'Chromium 134 via Playwright 1.51.1',checks,layoutChecks:layouts,pageErrors:errors,limits:['Mock localStorage state only; no real API/native permissions/sync/upload','No human family trial or expert child-content review']};
  fs.writeFileSync(path.join(root,'deliverables/v2/browser-check.json'),JSON.stringify(report,null,2));
  await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exit(1);});
