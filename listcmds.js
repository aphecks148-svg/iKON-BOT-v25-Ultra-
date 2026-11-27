const base='/data/user/0/com.androidharness.app/files/github-projects/iKON-BOT-v25-Ultra--b7fa1456';
const fs=require('fs');
const files=fs.readdirSync(base+'/commands').filter(f=>/^cmds_\d+\.js$/.test(f)).sort();
const cats={};
for(const f of files){
  const s=fs.readFileSync(base+'/commands/'+f,'utf8');
  const re=/name:\s*'([^']+)'.*?category:\s*'([^']+)'/gs;
  let m;
  while((m=re.exec(s))!==null){
    const name=m[1], cat=m[2];
    if(!cats[cat]) cats[cat]=[];
    cats[cat].push(name);
  }
}
for(const c of Object.keys(cats).sort()){
  console.log('## '+c+' ('+cats[c].length+')');
  console.log(cats[c].join(', '));
}
console.log('TOTAL: '+Object.values(cats).reduce((a,b)=>a+b.length,0));
