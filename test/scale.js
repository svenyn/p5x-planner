const { chromium } = require('playwright');
const path = require('path');
const PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'p5x-planner.html');

(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(PAGE); await p.waitForTimeout(300);
  const r = await p.evaluate(() => {
    let seed=7; const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
    const pk=a=>a[Math.floor(rnd()*a.length)];
    const H=['Sun','Moon','Star','Sky'],S=Object.keys(SETS),SP=Object.keys(SPACE_SETS),SU=Object.keys(SUBSTATS);
    state.cards=[];
    for(let i=0;i<4000;i++){
      const slot=rnd()<0.12?'Space':pk(H), set=slot==='Space'?pk(SP):pk(S), rarity=pk([5,5,4,4,4,3,3,2,2,2]);
      const info=SLOT_INFO[slot], main=info.fixed?info.mains[0]:pk(info.mains);
      const s=[],u=new Set([main]),n=rarity>=4?4:rarity===3?3:2;
      while(s.length<n){const st=pk(SU); if(u.has(st))continue; u.add(st);
        const mx=slot==='Space'?(SUBSTATS[st].maxRollSpace||SUBSTATS[st].maxRoll):SUBSTATS[st].maxRoll;
        s.push({stat:st,value:+(mx*(0.5+rnd()*2.5)).toFixed(1)});}
      state.cards.push({id:'c'+i,slot,set,rarity,level:rarity*5,main,subs:s,equipped:null});
    }
    const pool=state.cards.filter(c=>c.rarity>=5);
    const out={};
    for(const [name,opts] of [['pref',{policy:'pref'}],['force4',{policy:'force4'}],['pref@120',{policy:'pref',p4value:120}],['stats',{policy:'stats'}]]){
      const k={}; let syn=0,tot=0; const t0=performance.now();
      for(const ch of CHARACTERS){ const res=bestPlan(ch,pool,opts); if(!res.best)continue;
        k[res.best.kind]=(k[res.best.kind]||0)+1; tot++; if(res.space&&res.space.pairs)syn++; }
      out[name]={kinds:k,spaceSynergy:`${syn}/${tot}`,ms:Math.round(performance.now()-t0)};
    }
    // dead 2pc must never appear
    const dead=[];
    for(const ch of CHARACTERS){ const res=bestPlan(ch,pool,{policy:'pref'}); if(!res.best)continue;
      const t=target(ch);
      for(const s of res.best.sets){ const d=SETS[s]; if(d&&d.elem&&d.elem!==ch.e) dead.push(`${ch.n}(${ch.e}) got ${s}`); } }
    out.deadElementSets = dead.length?dead.slice(0,5):'none';
    return out;
  });
  console.log(JSON.stringify({...r,errs},null,1));
  await b.close();
})();
