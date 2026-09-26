const { chromium } = require('playwright');
const path = require('path');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'p5x-planner.html');

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1440,height:1000} });
  await p.goto(PAGE); await p.waitForTimeout(300);
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
    /* Dress everyone from the optimiser, but only the first four slots and from a pool
       that shrinks as it goes — the point of these shots is a board with real gear on it
       that still has visible room in it, not a finished account. Roster, Upgrades and the
       Weakest slots view all read equipped cards and show nothing without this. */
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
    renderInv(); renderRoster(); renderOpt();
  });
  // The roster is the landing tab, so Optimise has to be opened before its picker is
  // visible — selectOption on a hidden <select> just times out.
  await p.click('nav button[data-tab="opt"]');
  await p.selectOption('#optChar','Ryuji Sakamoto');
  await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-opt.png') });
  await p.click('nav button[data-tab="triage"]'); await p.click('#trRun');
  // Triage runs on the frame after its "Rating the inventory…" message, so wait for the result
  await p.waitForFunction(() => /Rated \d+/.test(document.getElementById('trSummary').textContent), null, { timeout: 20000 });
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-triage.png') });
  await p.click('nav button[data-tab="vault"]'); await p.click('#vaRun'); await p.waitForTimeout(400);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-vault.png') });
  await p.click('nav button[data-tab="upgrades"]');
  await p.click('#upSubtabs button[data-uptab="headroom"]'); await p.waitForTimeout(500);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-headroom.png') });
  await p.click('nav button[data-tab="roster"]'); await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-roster.png') });
  // The scanning guide has no nav button of its own any more — it is reached from the two
  // in-prose links on Save / Load. Capture the whole thing, not a viewport of it.
  await p.click('nav button[data-tab="data"]');
  await p.click('[data-goto="howto"]'); await p.waitForTimeout(200);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-howto.png'), fullPage:true });
  await b.close();
})();
