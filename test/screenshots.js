const { chromium } = require('playwright');
const path = require('path');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'p5x-planner.html');
const DOCS = path.join(__dirname, '..', 'docs');
/* `npm run shots -- path/to/save.json` shoots a real save instead of the synthetic board — the
   only way to see the tool at the size it is actually used at (4000 cards, three dozen owned). */
const SAVE = process.argv[2] || null;

/* The synthetic board: 900 cards, six owned characters, dressed from a shrinking pool so there
   is still visible room in every build. Roster, Upgrades and the Weakest slots view all read
   equipped cards and show nothing without this. */
async function dressSynthetic(p) {
  await p.evaluate(() => {
    let seed=11; const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
    const pk=a=>a[Math.floor(rnd()*a.length)];
    const H=['Sun','Moon','Star','Sky'],SS=Object.keys(SETS),SP=Object.keys(SPACE_SETS),SU=Object.keys(SUBSTATS);
    state.cards=[];
    for(let i=0;i<900;i++){
      const slot=rnd()<0.12?'Space':pk(H), set=slot==='Space'?pk(SP):pk(SS), rarity=pk([5,5,5,4,4,3,2]);
      const info=SLOT_INFO[slot], main=info.fixed?info.mains[0]:pk(info.mains);
      const s=[],u=new Set([main]),n=rarity>=4?4:rarity===3?3:2;
      while(s.length<n){const st=pk(SU); if(u.has(st))continue; u.add(st);
        const mx=slot==='Space'?(SUBSTATS[st].maxRollSpace||SUBSTATS[st].maxRoll):SUBSTATS[st].maxRoll;
        s.push({stat:st,value:+(mx*(0.6+rnd()*2.4)).toFixed(1)});}
      state.cards.push({id:'c'+i,slot,set,rarity,level:rarity*5,main,subs:s,equipped:null});
    }
    const own=['Ren Amamiya','Ryuji Sakamoto','Morgana','Kira Kitazato','Yusuke Kitagawa','Makoto Yuki'];
    own.forEach(n=>state.chars[n].owned=true);
    own.forEach((n,k)=>{
      const ch=charDef(n);
      // Half the roster is geared from a deliberately narrow slice of the inventory, so
      // better cards of the same set are still sitting there for the Weakest slots view
      // to find — geared from the whole pool they would all be optimal by construction.
      const pool=state.cards.filter((c,i)=>!c.equipped&&c.rarity>=4&&(k<3||i<260));
      const r=bestPlan(ch,pool,{policy:'pref'});
      if(!r.best)return;
      ['Sun','Moon','Star','Sky'].slice(0,k===0?4:3).forEach(sl=>{const pk=r.best.picks[sl]; if(pk)pk.c.equipped=n;});
      if(r.space&&k%2===0)r.space.c.equipped=n;
    });
    commit(); markSaved();
  });
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1440,height:1000} });
  await p.goto(PAGE); await p.waitForTimeout(300);
  if (SAVE) {
    await p.setInputFiles('#fileIn', SAVE);
    await p.waitForFunction(() => /Loaded/.test(document.getElementById('dataMsg').textContent), null, { timeout: 60000 });
    await p.evaluate(() => hideToast());
  } else await dressSynthetic(p);
  const first = SAVE ? null : 'Ryuji Sakamoto';

  await p.click('nav button[data-tab="opt"]');
  if (first) await p.selectOption('#optChar', first);
  await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(DOCS,'shot-opt.png') });
  // Triage runs itself on the first visit; wait for that run rather than start another
  await p.click('nav button[data-tab="triage"]');
  await p.waitForFunction(() => /Rated \d+/.test(document.getElementById('trSummary').textContent), null, { timeout: 60000 });
  await p.screenshot({ path:path.join(DOCS,'shot-triage.png') });
  // the Vault is Triage's second view, and also runs itself on the first visit
  await p.click('#trSubtabs button[data-trtab="vault"]');
  await p.waitForSelector('#vaPanel:not(.hide)', { timeout: 60000 });
  await p.screenshot({ path:path.join(DOCS,'shot-vault.png') });
  await p.click('nav button[data-tab="upgrades"]');
  await p.click('#upSubtabs button[data-uptab="headroom"]'); await p.waitForTimeout(500);
  await p.screenshot({ path:path.join(DOCS,'shot-headroom.png') });
  await p.click('nav button[data-tab="roster"]'); await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(DOCS,'shot-roster.png') });
  await p.click('nav button[data-tab="teams"]'); await p.waitForTimeout(800);
  await p.screenshot({ path:path.join(DOCS,'shot-teams.png') });
  await p.click('#rsGrid .cc[data-ch] >> nth=0', { position: { x: 100, y: 150 } });
  await p.waitForSelector('#dlg[open]'); await p.waitForTimeout(200);
  await p.screenshot({ path:path.join(DOCS,'shot-loadout.png') });
  await p.keyboard.press('Escape');
  // The scanning guide has no nav button of its own — it is reached from the in-prose links
  // on the Data tab. Capture the whole thing, not a viewport of it.
  await p.click('nav button[data-tab="data"]');
  await p.click('#tab-data [data-goto="howto"] >> nth=0'); await p.waitForTimeout(200);
  await p.screenshot({ path:path.join(DOCS,'shot-howto.png'), fullPage:true });

  // A phone-width pass: nothing should scroll sideways, and the roster runs two columns.
  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('nav button[data-tab="roster"]'); await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(DOCS,'shot-phone-roster.png') });
  await p.click('nav button[data-tab="opt"]'); await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(DOCS,'shot-phone-opt.png') });
  const wide = await p.evaluate(() => document.documentElement.scrollWidth);
  if (wide > 390) console.warn(`phone-width Optimise is ${wide}px wide — something no longer scrolls inside itself`);
  await b.close();
})();
