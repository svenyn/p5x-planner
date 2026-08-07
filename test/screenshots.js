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
    ['Ren Amamiya','Ryuji Sakamoto','Morgana','Kira Kitazato','Yusuke Kitagawa','Makoto Yuki'].forEach(n=>state.chars[n].owned=true);
    renderInv(); renderRoster(); renderOpt();
  });
  await p.selectOption('#optChar','Ryuji Sakamoto');
  await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-opt.png') });
  await p.click('nav button[data-tab="triage"]'); await p.click('#trRun'); await p.waitForTimeout(400);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-triage.png') });
  await p.click('nav button[data-tab="roster"]'); await p.waitForTimeout(300);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-roster.png') });
  // the scanning guide is one long document — capture the whole thing, not a viewport of it
  await p.click('nav button[data-tab="howto"]'); await p.waitForTimeout(200);
  await p.screenshot({ path:path.join(__dirname,'..','docs','shot-howto.png'), fullPage:true });
  await b.close();
})();
