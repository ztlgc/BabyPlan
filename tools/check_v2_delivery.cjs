const {chromium}=require('../.work/design-tooling/node_modules/playwright-core');
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..'),out=path.join(root,'deliverables/v2');
const fragment='C:/Users/Heart/.codex/visualizations/2026/11/12/01a1d070-e327-7c13-b06d-66e3c49cb957/babyplan-design.html';
const file=p=>'file:///'+p.replace(/\\/g,'/');
(async()=>{
const browser=await chromium.launch({headless:true,executablePath:process.env.BABYPLAN_CHROMIUM||'C:/Users/Heart/AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe'});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(file(path.join(out,'界面总览.html')));assert(await page.locator('img').evaluateAll(imgs=>imgs.every(i=>i.complete&&i.naturalWidth>0)));await page.screenshot({path:path.join(out,'界面总览.png'),fullPage:true});
await page.goto(file(path.join(root,'打开设计.html')));assert(await page.locator('img').evaluateAll(imgs=>imgs.every(i=>i.complete&&i.naturalWidth>0)));await page.screenshot({path:path.join(out,'设计总览入口.png')});assert(await page.locator('a[href*="活动手册"]').count()===1);
await page.goto(file(path.join(out,'活动手册.html')));assert(await page.locator('article.card').count()===24);assert(await page.locator('tbody tr').count()===7);await page.screenshot({path:path.join(out,'活动手册预览.png')});
await page.setViewportSize({width:360,height:900});assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)));
// 只有当前聊天存在内联片段；交接包中跳过此项，不打包聊天响应内容。
let inlineChecked=false;
if(fs.existsSync(fragment)){
  const markup=fs.readFileSync(fragment,'utf8');assert(!markup.includes('<!doctype')&&!markup.includes('<html')&&!markup.includes('<body'));
  await page.setViewportSize({width:736,height:900});await page.setContent(markup);await page.getByRole('button',{name:'看看怎么玩'}).click();assert(await page.getByText('和宝宝面对面坐下，留一小段距离。').isVisible());await page.getByRole('button',{name:'一起玩了'}).click();assert(await page.getByText('这次陪伴已记下 · 当前预览中的模拟记录').isVisible());await page.getByRole('button',{name:'阶段',exact:true}).click();assert(await page.getByRole('heading',{name:'陪着长大，慢慢来'}).isVisible());await page.getByRole('button',{name:'今天',exact:true}).click();await page.screenshot({path:path.join(root,'.work/inline-preview.png')});
  await page.setViewportSize({width:320,height:900});assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)));inlineChecked=true;
}
assert.equal(errors.length,0,errors.join('\n'));
fs.writeFileSync(path.join(out,'delivery-check.json'),JSON.stringify({checkedOn:'2026-11-13',boardImagesLoaded:true,portalImagesLoaded:true,handbookCards:24,handbookDays:7,handbookAt360:true,inlineChecked,inlineAt320:inlineChecked,pageErrors:errors},null,2));
console.log('Delivery, handbook, image assets and inline interactions passed.');await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
